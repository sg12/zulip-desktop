// CMSampleBuffer+Extensions.swift
import CoreMedia
import CoreVideo

extension CMSampleBuffer {
    func getImageBuffer() -> CVImageBuffer? {
        return CMSampleBufferGetImageBuffer(self)
    }
    
    func getVideoFrame() -> [String: Any]? {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(self) else { return nil }
        
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(self).seconds
        let pixelFormat = CVPixelBufferGetPixelFormatType(imageBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer)
        
        // Блокируем буфер для чтения
        CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly) }
        
        // Извлекаем пиксели
        var pixelData: Data?
        if let baseAddress = CVPixelBufferGetBaseAddress(imageBuffer) {
            // ВАЖНО: Копируем только актуальные пиксели, без padding
            let actualBytesPerRow = width * 4 // BGRA = 4 bytes per pixel
            let totalSize = actualBytesPerRow * height
            
            // Создаем Data с правильным размером
            pixelData = Data(count: totalSize)
            
            pixelData?.withUnsafeMutableBytes { destPtr in
                guard let destBytes = destPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                let srcBytes = baseAddress.assumingMemoryBound(to: UInt8.self)
                
                // Копируем построчно, убирая padding
                for y in 0..<height {
                    let srcOffset = y * bytesPerRow
                    let destOffset = y * actualBytesPerRow
                    memcpy(destBytes + destOffset, srcBytes + srcOffset, actualBytesPerRow)
                }
            }
        }
        
        return [
            "width": width,
            "height": height,
            "timestamp": timestamp,
            "pixelFormat": pixelFormat,
            "pixelFormatName": getPixelFormatName(pixelFormat),
            "bytesPerRow": width * 4, // Актуальный bytesPerRow без padding
            "dataSize": pixelData?.count ?? 0,
            "hasData": pixelData != nil,
            // НЕ передаем imageBuffer - он вызывает краш
            // Вместо этого передаем пиксели как Data
            "pixelData": pixelData as Any
        ]
    }

    private func getPixelFormatName(_ format: OSType) -> String {
        switch format {
        case kCVPixelFormatType_32BGRA:
            return "BGRA"
        case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
            return "YUV420v"
        case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
            return "YUV420f"
        default:
            return "Unknown(\(format))"
        }
    }

    func getAudioData() -> [String: Any]? {
        guard let formatDesc = CMSampleBufferGetFormatDescription(self) else { return nil }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return nil }
        
        let numSamples = CMSampleBufferGetNumSamples(self)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(self).seconds
        
        // Получаем аудио данные
        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            self,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        
        defer {
            // Удаляем неиспользуемую проверку
            _ = blockBuffer  // Подавляем warning
        }
        
        var audioData: Data?
        var totalSize: Int = 0
        
        if status == noErr {
            // Если получили AudioBufferList, извлекаем данные
            let bufferCount = Int(audioBufferList.mNumberBuffers)
            if bufferCount > 0 {
                // Для простоты берем первый буфер (обычно интерливд стерео)
                let audioBuffer = audioBufferList.mBuffers
                if let data = audioBuffer.mData, audioBuffer.mDataByteSize > 0 {
                    audioData = Data(bytes: data, count: Int(audioBuffer.mDataByteSize))
                    totalSize = Int(audioBuffer.mDataByteSize)
                }
            }
        }
        
        return [
            "sampleRate": asbd.pointee.mSampleRate,
            "channels": asbd.pointee.mChannelsPerFrame,
            "timestamp": timestamp,
            "numSamples": numSamples,
            "format": asbd.pointee.mFormatID,
            "bitsPerChannel": asbd.pointee.mBitsPerChannel,
            "bytesPerFrame": asbd.pointee.mBytesPerFrame,
            "framesPerPacket": asbd.pointee.mFramesPerPacket,
            "hasData": audioData != nil,
            "dataSize": totalSize
        ]
    }
}

// ScreenCaptureManager.swift
import Foundation
import ScreenCaptureKit
@preconcurrency import AVFoundation
import AppKit
import CoreMedia

struct CaptureSource: Sendable {
    let type: String
    let id: String
}

class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) {
        self.value = value
    }
}

enum CaptureMode {
    case audioOnly
    case audioAndVideo
    case videoOnly
}

@available(macOS 12.3, *)
actor CaptureActor {
    var isCapturing = false
    var errorMessage: String?
    var isStreaming = false

    private var pickerCompletion: ((NSError?, [String: Any]?) -> Void)?
    private var stream: SCStream?
    private var captureSession: AVCaptureSession?
    private var contentFilter: SCContentFilter?
    private var captureWidth: Int = 0
    private var captureHeight: Int = 0
    private let sampleBufferQueue = DispatchQueue(label: "ScreenCaptureManager.SampleBufferQueue")
    private var firstSampleTime: CMTime = .zero
    private var lastVideoTime: CMTime = .zero
    private var lastAudioTime: CMTime = .zero
    private let outputDelegate: CaptureOutputDelegate
    private var directVideoCallback: ((CVImageBuffer, Double) -> Void)?
    private var directAudioCallback: ((CMSampleBuffer) -> Void)?

    // WebRTC callbacks
    var videoBufferCallback: ((CMSampleBuffer) -> Void)?
    var audioBufferCallback: ((CMSampleBuffer) -> Void)?
    var webrtcVideoCallback: (([String: Any]) -> Void)?
    var webrtcAudioCallback: ((CMSampleBuffer) -> Void)?

    // Параметры качества
    private var requestedWidth: Int = 1920
    private var requestedHeight: Int = 1080
    private var requestedFPS: Int = 30
    private var scaleFactor: Double = 1.0

    private var captureMode: CaptureMode = .audioAndVideo

    init() {
        let delegate = CaptureOutputDelegate()
        self.outputDelegate = delegate
        delegate.actor = self
    }

    // Метод для установки режима захвата
    func setCaptureMode(_ mode: CaptureMode) {
        self.captureMode = mode
        print("📹 Capture mode set to: \(mode)")
    }

    // Метод для установки параметров качества
    func setCaptureQuality(width: Int, height: Int, fps: Int) {
        print("📐 Setting capture quality: \(width)x\(height) @ \(fps) fps")
        
        // Валидация параметров
        requestedWidth = max(320, min(3840, width))   // От 320 до 4K
        requestedHeight = max(240, min(2160, height))  // От 240 до 4K
        requestedFPS = max(5, min(60, fps))           // От 5 до 60 fps
        
        print("📐 Validated quality: \(requestedWidth)x\(requestedHeight) @ \(requestedFPS) fps")
    }

    func setVideoCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        videoBufferCallback = callback
    }

    func setAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        audioBufferCallback = callback
    }
    
    func setWebRTCVideoCallback(_ callback: @escaping ([String: Any]) -> Void) {
        webrtcVideoCallback = callback
    }
    
    func setWebRTCAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        webrtcAudioCallback = callback
    }

    func setPickerCompletion(_ completion: @escaping (NSError?, [String: Any]?) -> Void) {
        pickerCompletion = completion
    }

    func getPickerCompletion() -> ((NSError?, [String: Any]?) -> Void)? {
        return pickerCompletion
    }

    func clearPickerCompletion() {
        pickerCompletion = nil
    }

    func handleStreamError(_ error: Error) {
        print("Stream stopped with error: \(error.localizedDescription)")
        isStreaming = false
    }

    func setCaptureSource(type: String, id: String) async throws {
        print("🔍 setCaptureSource called with type: \(type), id: \(id)")
        
        // Reset filter but NOT dimensions if quality was set
        contentFilter = nil
        
        // Сохраняем текущие настройки качества если они были установлены
        // УБРАЛИ неиспользуемую переменную hasQualitySettings
        let savedWidth = requestedWidth
        let savedHeight = requestedHeight
        let savedFPS = requestedFPS
        
        do {
            let contentTask = Task { @MainActor in
                try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            }
            let content = try await contentTask.value
            
            print("✅ Got shareable content with \(content.displays.count) displays and \(content.windows.count) windows")
            
            if type == "display" || type == "screen" {
                var cleanId = id
                cleanId = cleanId.replacingOccurrences(of: "screen:", with: "")
                cleanId = cleanId.replacingOccurrences(of: "display:", with: "")
                cleanId = cleanId.replacingOccurrences(of: ":0", with: "")
                cleanId = cleanId.trimmingCharacters(in: .whitespacesAndNewlines)
                
                print("🔍 Cleaned display ID: '\(cleanId)'")
                
                guard let displayID = UInt32(cleanId) else {
                    print("❌ Cannot parse display ID as UInt32: '\(cleanId)'")
                    
                    if let mainDisplay = content.displays.first {
                        print("⚠️ Using main display as fallback: \(mainDisplay.displayID)")
                        contentFilter = SCContentFilter(display: mainDisplay, excludingApplications: [], exceptingWindows: [])
                        
                        // Сохраняем исходные размеры
                        captureWidth = mainDisplay.width
                        captureHeight = mainDisplay.height
                        
                        print("✅ Main display configured: source size \(captureWidth)x\(captureHeight)")
                        print("📐 Requested quality: \(savedWidth)x\(savedHeight) @ \(savedFPS) fps")
                        return
                    }
                    
                    throw RecordingError("Invalid display ID and no fallback available")
                }
                
                if let display = content.displays.first(where: { $0.displayID == displayID }) {
                    print("✅ Found display: \(display.displayID), source size: \(display.width)x\(display.height)")
                    contentFilter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    
                    // Сохраняем ИСХОДНЫЙ размер экрана
                    captureWidth = display.width
                    captureHeight = display.height
                    
                    print("📐 Source dimensions: \(captureWidth)x\(captureHeight)")
                    print("📐 Requested quality: \(savedWidth)x\(savedHeight) @ \(savedFPS) fps")
                    
                } else {
                    if let mainDisplay = content.displays.first {
                        print("⚠️ Using main display as fallback")
                        contentFilter = SCContentFilter(display: mainDisplay, excludingApplications: [], exceptingWindows: [])
                        captureWidth = mainDisplay.width
                        captureHeight = mainDisplay.height
                    } else {
                        throw RecordingError("No displays available")
                    }
                }
                
            } else if type == "window" {
                let cleanId = id.trimmingCharacters(in: .whitespacesAndNewlines)
                
                guard let windowID = UInt32(cleanId) else {
                    print("❌ Invalid window ID: '\(cleanId)'")
                    throw RecordingError("Invalid window ID")
                }
                
                guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                    print("❌ Window not found with ID: \(windowID)")
                    throw RecordingError("Window not found")
                }
                
                if window.frame.width < 10 || window.frame.height < 10 {
                    print("⚠️ Window too small: \(window.frame.width)x\(window.frame.height)")
                    throw RecordingError("Window too small for capture")
                }
                
                contentFilter = SCContentFilter(desktopIndependentWindow: window)
                captureWidth = Int(window.frame.width)
                captureHeight = Int(window.frame.height)
                
                print("✅ Found window: source size \(captureWidth)x\(captureHeight)")
                print("📐 Requested quality: \(savedWidth)x\(savedHeight) @ \(savedFPS) fps")
            
            } else if type == "application" {
                guard let app = content.applications.first(where: { $0.bundleIdentifier == id }) else {
                    print("❌ Application not found with bundle ID: \(id)")
                    throw RecordingError("Application not found")
                }
                
                guard let mainDisplay = content.displays.first else {
                    throw RecordingError("No display available for application capture")
                }
                
                contentFilter = SCContentFilter(display: mainDisplay, including: [app], exceptingWindows: [])
                captureWidth = mainDisplay.width
                captureHeight = mainDisplay.height
                
                print("✅ Found application: \(app.applicationName)")
                print("📐 Source size: \(captureWidth)x\(captureHeight)")
                print("📐 Requested quality: \(savedWidth)x\(savedHeight) @ \(savedFPS) fps")
            } else {
                print("❌ Unsupported source type: \(type)")
                
                // Fallback to main display
                if let mainDisplay = content.displays.first {
                    print("⚠️ Using main display as fallback for unknown type")
                    contentFilter = SCContentFilter(display: mainDisplay, excludingApplications: [], exceptingWindows: [])
                    captureWidth = mainDisplay.width
                    captureHeight = mainDisplay.height
                } else {
                    throw RecordingError("Unsupported source type and no fallback")
                }
            }
            
            guard contentFilter != nil else {
                print("❌ Content filter is nil after setup")
                throw RecordingError("Failed to create content filter")
            }
            
            print("✅ setCaptureSource completed successfully")
            print("📐 Will capture from \(captureWidth)x\(captureHeight) source")
            print("📐 Will output at \(requestedWidth)x\(requestedHeight) @ \(requestedFPS) fps")
            
        } catch {
            print("❌ setCaptureSource error: \(error)")
            contentFilter = nil
            captureWidth = 0
            captureHeight = 0
            throw error
        }
    }

    func selectSource() async throws -> CaptureSource {
        let contentTask = Task { @MainActor in
            try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        }
        let content = try await contentTask.value
        
        var sourceList: [CaptureSource] = []
        var displayNames: [String] = []
        
        for (i, display) in content.displays.enumerated() {
            let name = "Screen \(i + 1)"
            displayNames.append(name)
            sourceList.append(CaptureSource(type: "display", id: "\(display.displayID)"))
        }
        
        for window in content.windows {
            let name = "\(window.title ?? "Untitled") - \(window.owningApplication?.applicationName ?? "Unknown")"
            displayNames.append(name)
            sourceList.append(CaptureSource(type: "window", id: "\(window.windowID)"))
        }
        
        for app in content.applications {
            let name = app.applicationName
            displayNames.append(name)
            sourceList.append(CaptureSource(type: "application", id: app.bundleIdentifier))
        }
        
        return try await withCheckedThrowingContinuation { continuation in
            Task.detached { [displayNames, sourceList] in
                let selectedSource = await MainActor.run { () -> CaptureSource? in
                    let alert = NSAlert()
                    alert.messageText = "Select Source to Capture"
                    alert.informativeText = "Choose a screen, window, or application"
                    
                    let popUp = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 400, height: 24), pullsDown: false)
                    popUp.addItems(withTitles: displayNames)
                    
                    alert.accessoryView = popUp
                    
                    alert.addButton(withTitle: "Select")
                    alert.addButton(withTitle: "Cancel")
                    
                    let response = alert.runModal()
                    if response == .alertFirstButtonReturn {
                        let selectedIndex = popUp.indexOfSelectedItem
                        if selectedIndex >= 0 {
                            return sourceList[selectedIndex]
                        } else {
                            return nil
                        }
                    } else {
                        return nil
                    }
                }
                if let selectedSource = selectedSource {
                    continuation.resume(returning: selectedSource)
                } else {
                    continuation.resume(throwing: RecordingError("No selection or cancelled"))
                }
            }
        }
    }

    // Вспомогательная функция для таймаута
    func withTimeout<T>(seconds: TimeInterval, operation: @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }
            
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw RecordingError("Operation timed out after \(seconds) seconds")
            }
            
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    func startCapture() async throws {
        print("🚀 startCapture called with mode: \(captureMode)")
        errorMessage = nil
        
        // Проверка прав доступа
        guard CGPreflightScreenCaptureAccess() else {
            print("❌ No screen capture permission")
            errorMessage = "Screen capture permission denied."
            throw RecordingError("No screen capture permission")
        }
        
        // Для режима audioOnly создаем минимальный фильтр
        if captureMode == .audioOnly {
            print("🎵 Audio-only mode - creating minimal filter")
            // Получаем основной дисплей для создания минимального фильтра
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            if let mainDisplay = content.displays.first {
                contentFilter = SCContentFilter(display: mainDisplay, excludingApplications: [], exceptingWindows: [])
                // Сохраняем размеры дисплея для конфигурации
                captureWidth = mainDisplay.width
                captureHeight = mainDisplay.height
                print("✅ Created minimal filter for audio-only mode (display: \(captureWidth)x\(captureHeight))")
            } else {
                throw RecordingError("No display available for audio capture")
            }
        } else {
            // Проверка contentFilter для видео режимов
            guard contentFilter != nil else {
                print("❌ No content filter set for video mode")
                throw RecordingError("No content filter available")
            }
        }
        
        // Теперь проверяем что фильтр точно есть
        guard let filter = contentFilter else {
            throw RecordingError("No content filter available")
        }
        
        // Создаем конфигурацию потока
        let streamConfig = SCStreamConfiguration()
        
        // ВАЖНО: Даже для audio-only используем реальные размеры
        // Иначе SCStream может не создаться
        if captureMode == .audioOnly {
            // Используем низкое разрешение для экономии ресурсов, но не 1x1
            streamConfig.width = 16
            streamConfig.height = 16
            streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps
            streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
            streamConfig.showsCursor = false
            streamConfig.queueDepth = 1 // Минимальная очередь
            print("🎵 Audio-only mode: using 640x480 @ 1fps for compatibility")
        } else if captureMode == .audioAndVideo || captureMode == .videoOnly {
            streamConfig.width = requestedWidth
            streamConfig.height = requestedHeight
            let frameInterval = CMTime(value: 1, timescale: CMTimeScale(requestedFPS))
            streamConfig.minimumFrameInterval = frameInterval
            streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
            streamConfig.showsCursor = true
            streamConfig.queueDepth = requestedWidth <= 640 ? 2 : 3
            print("📹 Video configured: \(requestedWidth)x\(requestedHeight) @ \(requestedFPS) fps")
        }
        
        // Настройки аудио
        if captureMode == .audioOnly || captureMode == .audioAndVideo {
            if #available(macOS 13.0, *) {
                streamConfig.capturesAudio = true
                streamConfig.excludesCurrentProcessAudio = true
                streamConfig.sampleRate = 48000
                streamConfig.channelCount = 2
                print("🎵 Audio configured: 48kHz, 2 channels")
            } else {
                print("⚠️ Audio capture requires macOS 13.0 or later")
                throw RecordingError("Audio capture requires macOS 13.0 or later")
            }
        }
        
        print("📋 Creating SCStream with configuration")
        print("   Filter: \(filter)")
        print("   Config: width=\(streamConfig.width), height=\(streamConfig.height)")
        
        do {
            let streamLocal = SCStream(filter: filter, configuration: streamConfig, delegate: outputDelegate)
            
            // ВАЖНО: Для audio-only тоже добавляем screen output, но с минимальными настройками
            // Это нужно чтобы поток вообще запустился
            if captureMode == .audioOnly {
                print("🎵 Adding minimal screen output for audio-only mode")
                try streamLocal.addStreamOutput(outputDelegate, type: .screen, sampleHandlerQueue: sampleBufferQueue)
            } else if captureMode == .audioAndVideo || captureMode == .videoOnly {
                print("📹 Adding video output handler")
                try streamLocal.addStreamOutput(outputDelegate, type: .screen, sampleHandlerQueue: sampleBufferQueue)
            }
            
            if captureMode == .audioOnly || captureMode == .audioAndVideo {
                if #available(macOS 13.0, *) {
                    print("🎵 Adding audio output handler")
                    do {
                        try streamLocal.addStreamOutput(outputDelegate, type: .audio, sampleHandlerQueue: sampleBufferQueue)
                        print("✅ Audio output handler added successfully")
                    } catch {
                        print("⚠️ Audio not added: \(error)")
                        throw error
                    }
                }
            }
            
            print("📋 Starting capture...")
            try await streamLocal.startCapture()
            
            self.stream = streamLocal
            isCapturing = true
            isStreaming = true
            
            print("✅ Capture started successfully in \(captureMode) mode!")
            
        } catch {
            print("❌ Failed to start capture: \(error)")
            print("   Error details: \(error.localizedDescription)")
            self.stream = nil
            isCapturing = false
            isStreaming = false
            throw error
        }
    }

    // Вспомогательный метод для получения главного дисплея
    private func getMainDisplay() async throws -> SCDisplay? {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        return content.displays.first
    }

    // Метод для изменения качества во время захвата
    func updateCaptureQuality(width: Int, height: Int, fps: Int) async throws {
        if !isCapturing || stream == nil {
            // Если не идет захват, просто сохраняем параметры
            setCaptureQuality(width: width, height: height, fps: fps)
            return
        }
        
        print("📐 Updating capture quality on the fly...")
        
        // Для изменения качества на лету нужно пересоздать поток
        // Сохраняем текущий фильтр
        let currentFilter = contentFilter
        
        // Останавливаем текущий захват
        if let stream = stream {
            try await stream.stopCapture()
        }
        
        // Устанавливаем новые параметры
        setCaptureQuality(width: width, height: height, fps: fps)
        
        // Восстанавливаем фильтр
        contentFilter = currentFilter
        
        // Перезапускаем с новыми параметрами
        try await startCapture()
        
        print("📐 Quality updated successfully")
    }

    private func requestMicrophoneAccess() async throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            print("Microphone access granted")
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            if granted {
                print("Microphone access obtained")
            } else {
                print("Microphone access denied")
                errorMessage = "Microphone access denied."
                throw RecordingError("Microphone access denied")
            }
        case .denied, .restricted:
            print("Microphone access denied or restricted")
            errorMessage = "Microphone access denied."
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
            }
            throw RecordingError("Microphone access denied")
        @unknown default:
            throw RecordingError("Unknown microphone access status")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) async {
        guard isCapturing && isStreaming else { return }
        
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstSampleTime == .zero {
            firstSampleTime = presentationTime
        }
        
        let adjustedTime = presentationTime - firstSampleTime
        
        switch type {
        case .screen:
            if let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
                // Прямая передача видео буфера
                directVideoCallback?(imageBuffer, adjustedTime.seconds)
                
                // Также отправляем в существующие callbacks
                videoBufferCallback?(sampleBuffer)
                if let frameData = sampleBuffer.getVideoFrame() {
                    webrtcVideoCallback?(frameData)
                }
            }
            
        case .audio:
            // ВАЖНО: Добавляем подробное логирование
            //print("🎵 System audio buffer received, time: \(adjustedTime.seconds)")
            
            // Получаем информацию о формате для отладки
            if let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
                if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) {
                    let channelCount = asbd.pointee.mChannelsPerFrame
                    let sampleRate = asbd.pointee.mSampleRate
                    let formatID = asbd.pointee.mFormatID
                    print("🎵 Audio format - Channels: \(channelCount), Sample Rate: \(sampleRate), Format: \(formatID)")
                    
                    //Проверяем формат аудио
                    if formatID == kAudioFormatLinearPCM {
                        print("🎵 Audio is Linear PCM - good for processing")
                    } else {
                        print("⚠️ Audio format is not Linear PCM: \(formatID)")
                    }
                }
            }
            
            // Проверяем количество сэмплов
            let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
            print("🎵 Audio samples in buffer: \(numSamples)")
            
            // Прямая передача аудио буфера
            directAudioCallback?(sampleBuffer)
            
            // Также отправляем в существующие callbacks
            audioBufferCallback?(sampleBuffer)
            
            // КРИТИЧНО: Вызываем WebRTC callback
            if let callback = webrtcAudioCallback {
                print("🎵 Calling webrtcAudioCallback")
                callback(sampleBuffer)
            } else {
                print("⚠️ webrtcAudioCallback is nil!")
            }
            
        case .microphone:
            // Добавляем обработку микрофона (для полноты)
            print("🎵 Microphone audio buffer received, time: \(adjustedTime.seconds)")
            audioBufferCallback?(sampleBuffer)
            webrtcAudioCallback?(sampleBuffer)
            
        @unknown default:
            print("⚠️ Unknown stream output type")
            break
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) async {
        guard isCapturing && isStreaming else { return }
        
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let adjustedTime = presentationTime - firstSampleTime
        lastAudioTime = adjustedTime
        print("Microphone buffer for WebRTC, time: \(adjustedTime.seconds)")
        audioBufferCallback?(sampleBuffer)
        webrtcAudioCallback?(sampleBuffer)
    }

    func stopCapture() async throws {
        guard let stream = stream else {
            throw RecordingError("Stream not initialized")
        }

        isStreaming = false
        try await stream.stopCapture()
        
        if let session = captureSession {
            print("AVCaptureSession state before stop: \(session.isRunning)")
            session.stopRunning()
            print("Capture stopped")
        }

        try await Task.sleep(nanoseconds: 1_000_000_000)

        isCapturing = false
        self.stream = nil
        self.captureSession = nil
        firstSampleTime = .zero
        lastVideoTime = .zero
        lastAudioTime = .zero
        contentFilter = nil
    }

    func getAvailableSources() async throws -> [[String: Any]] {
        let contentTask = Task { @MainActor in
            try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        }
        let content = try await contentTask.value
        
        var sources: [[String: Any]] = []
        
        // 1. Добавляем все дисплеи (экраны)
        for (i, display) in content.displays.enumerated() {
            sources.append([
                "type": "display",
                "id": "\(display.displayID)",
                "name": "Экран \(i + 1)",
                "width": display.width,
                "height": display.height,
                "isDisplay": true  // Маркер для фронтенда
            ])
        }
        
        // 2. Группируем окна по приложениям
        var appWindows: [String: [SCWindow]] = [:]
        var appNames: [String: String] = [:]
        
        for window in content.windows {
            // Пропускаем слишком маленькие окна
            if window.frame.width < 100 || window.frame.height < 100 {
                continue
            }
            
            // Пропускаем окна без заголовка или приложения
            guard let app = window.owningApplication,
                !app.applicationName.isEmpty else {
                continue
            }
            
            let bundleId = app.bundleIdentifier
            
            // Фильтруем системные окна и "мусор"
            let skipPatterns = [
                "com.apple.dock",
                "com.apple.controlcenter",
                "com.apple.notificationcenterui",
                "com.apple.systemuiserver",
                "com.apple.WindowManager",
                "com.apple.screencaptureui",
                "com.apple.screenshot",
                "com.apple.finder", // Можно оставить, если нужен Finder
                "com.apple.loginwindow",
                "com.apple.SecurityAgent",
                "com.apple.CoreAuthentication",
                "com.apple.Spotlight",
                "com.apple.universalcontrol"
            ]
            
            // Проверяем, не является ли это системным приложением
            let shouldSkip = skipPatterns.contains { pattern in
                bundleId.lowercased().contains(pattern.lowercased())
            }
            
            if shouldSkip {
                continue
            }
            
            // Группируем окна по приложению
            if appWindows[bundleId] == nil {
                appWindows[bundleId] = []
                appNames[bundleId] = app.applicationName
            }
            appWindows[bundleId]?.append(window)
        }
        
        // 3. Добавляем приложения (берем самое большое окно каждого приложения)
        for (bundleId, windows) in appWindows {
            guard let appName = appNames[bundleId],
                !windows.isEmpty else {
                continue
            }
            
            // Находим самое большое окно приложения
            let largestWindow = windows.max { window1, window2 in
                let area1 = window1.frame.width * window1.frame.height
                let area2 = window2.frame.width * window2.frame.height
                return area1 < area2
            }
            
            if let window = largestWindow {
                // Определяем тип приложения для лучшей сортировки
                let isPopularApp = [
                    "Chrome", "Safari", "Firefox", "Edge",
                    "Slack", "Discord", "Telegram", "WhatsApp",
                    "Visual Studio Code", "Xcode", "IntelliJ IDEA",
                    "Zoom", "Skype", "Microsoft Teams",
                    "Figma", "Sketch", "Photoshop"
                ].contains { appName.contains($0) }
                
                sources.append([
                    "type": "window",
                    "id": "\(window.windowID)",
                    "name": appName,
                    "appName": appName,
                    "bundleId": bundleId,
                    "title": window.title ?? appName,
                    "width": Int(window.frame.width),
                    "height": Int(window.frame.height),
                    "isApplication": true,  // Маркер для фронтенда
                    "isPopular": isPopularApp  // Для приоритетной сортировки
                ])
            }
        }
        
        // 4. Сортируем источники:
        // - Сначала экраны
        // - Затем популярные приложения
        // - Затем остальные приложения
        sources.sort { source1, source2 in
            // Экраны всегда первые
            if source1["isDisplay"] as? Bool == true {
                return true
            }
            if source2["isDisplay"] as? Bool == true {
                return false
            }
            
            // Популярные приложения идут перед обычными
            let isPopular1 = source1["isPopular"] as? Bool ?? false
            let isPopular2 = source2["isPopular"] as? Bool ?? false
            
            if isPopular1 != isPopular2 {
                return isPopular1
            }
            
            // Сортируем по имени
            let name1 = source1["name"] as? String ?? ""
            let name2 = source2["name"] as? String ?? ""
            return name1 < name2
        }
        
        print("📋 Filtered sources: \(sources.count) items")
        print("   - Displays: \(sources.filter { $0["isDisplay"] as? Bool == true }.count)")
        print("   - Applications: \(sources.filter { $0["isApplication"] as? Bool == true }.count)")
        
        return sources
    }

    func setDirectVideoCallback(_ callback: @escaping (CVImageBuffer, Double) -> Void) {
        // Сохраняем прямой callback для видео буфера
        self.directVideoCallback = callback
    }

    func setDirectAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        // Сохраняем прямой callback для аудио буфера
        self.directAudioCallback = callback
    }
}

@available(macOS 12.3, *)
class CaptureOutputDelegate: NSObject, SCStreamDelegate, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    weak var actor: CaptureActor?

    override init() {
        super.init()
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        Task.detached { [weak actor = self.actor, error] in
            await actor?.handleStreamError(error)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        Task.detached { [weak actor = self.actor, stream, sampleBuffer, outputType] in
            await actor?.stream(stream, didOutputSampleBuffer: sampleBuffer, of: outputType)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        Task.detached { [weak actor = self.actor, output, sampleBuffer, connection] in
            await actor?.captureOutput(output, didOutput: sampleBuffer, from: connection)
        }
    }
}

// These need to be OUTSIDE the class, at file scope
enum Either<Left, Right> {
    case left(Left)
    case right(Right)
}

extension Task where Success == Never, Failure == Never {
    static func select<T1, T2>(_ task1: Task<T1, Error>, _ task2: Task<T2, Error>) async throws -> Either<T1, T2> {
        return try await withThrowingTaskGroup(of: Either<T1, T2>.self) { group in
            group.addTask { try await .left(task1.value) }
            group.addTask { try await .right(task2.value) }
            
            guard let result = try await group.next() else {
                throw RecordingError("No task completed")
            }
            
            group.cancelAll()
            return result
        }
    }
}

@available(macOS 12.3, *)
@objc(CCaptureManager)
public class ScreenCaptureManager: NSObject, SCContentSharingPickerObserver {
    private let captureActor = CaptureActor()

    @objc public var isCapturing: Bool {
        get {
            let box = Box<Bool>(false)
            let semaphore = DispatchSemaphore(value: 0)
            Task.detached { [captureActor = self.captureActor] in
                box.value = await captureActor.isCapturing
                semaphore.signal()
            }
            semaphore.wait()
            return box.value
        }
    }

    @objc public var errorMessage: String? {
        get {
            let box = Box<String?>(nil)
            let semaphore = DispatchSemaphore(value: 0)
            Task.detached { [captureActor = self.captureActor] in
                box.value = await captureActor.errorMessage
                semaphore.signal()
            }
            semaphore.wait()
            return box.value
        }
    }

    @objc public func setCaptureSource(_ source: [String: Any], completion: @escaping @Sendable (NSError?) -> Void) {
        print("setCaptureSource called with source: \(source)")
        
        // Validate input
        guard let type = source["type"] as? String,
            let id = source["id"] as? String else {
            print("❌ Invalid source dictionary - missing type or id")
            let error = NSError(domain: "CaptureManager", 
                            code: -1, 
                            userInfo: [NSLocalizedDescriptionKey: "Invalid source: missing type or id"])
            DispatchQueue.main.async {
                completion(error)
            }
            return
        }
        
        print("📋 Source details - type: '\(type)', id: '\(id)'")
        
        // Simple timeout mechanism
        var hasCompleted = false
        let timeoutWorkItem = DispatchWorkItem {
            if !hasCompleted {
                hasCompleted = true
                print("⏱️ setCaptureSource timeout after 5 seconds")
                let error = NSError(domain: "CaptureManager",
                                code: -2,
                                userInfo: [NSLocalizedDescriptionKey: "Operation timeout"])
                DispatchQueue.main.async {
                    completion(error)
                }
            }
        }
        
        // Schedule timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + 5.0, execute: timeoutWorkItem)
        
        Task.detached { [captureActor = self.captureActor, type, id] in
            do {
                try await captureActor.setCaptureSource(type: type, id: id)
                
                // Cancel timeout if we succeeded
                timeoutWorkItem.cancel()
                
                if !hasCompleted {
                    hasCompleted = true
                    print("✅ setCaptureSource completed successfully")
                    DispatchQueue.main.async {
                        completion(nil)
                    }
                }
            } catch {
                // Cancel timeout
                timeoutWorkItem.cancel()
                
                if !hasCompleted {
                    hasCompleted = true
                    print("❌ setCaptureSource error: \(error)")
                    DispatchQueue.main.async {
                        let nsError: NSError
                        if let recordingError = error as? RecordingError {
                            nsError = recordingError
                        } else {
                            nsError = NSError(domain: "CaptureManager",
                                            code: -1,
                                            userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
                        }
                        completion(nsError)
                    }
                }
            }
        }
    }

    @objc public func startCaptureWithCompletion(_ completion: @escaping @Sendable (NSError?) -> Void) {
        print("startCaptureWithCompletion called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                try await captureActor.startCapture()
                DispatchQueue.main.async {
                    completion(nil)
                }
            } catch {
                print("startCapture error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError)
                }
            }
        }
    }

    @objc public func stopCaptureWithCompletion(_ completion: @escaping @Sendable (NSError?) -> Void) {
        print("stopCaptureWithCompletion called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                try await captureActor.stopCapture()
                DispatchQueue.main.async {
                    completion(nil)
                }
            } catch {
                print("stopCapture error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError)
                }
            }
        }
    }

    @objc public func startAudioOnlyCapture(_ completion: @escaping @Sendable (NSError?) -> Void) {
        print("🎵 startAudioOnlyCapture called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                await captureActor.setCaptureMode(.audioOnly)
                try await captureActor.startCapture()
                DispatchQueue.main.async {
                    completion(nil)
                }
            } catch {
                print("startAudioOnlyCapture error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError)
                }
            }
        }
    }

    @objc public func startAudioVideoCapture(_ completion: @escaping @Sendable (NSError?) -> Void) {
        print("📹🎵 startAudioVideoCapture called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                await captureActor.setCaptureMode(.audioAndVideo)
                try await captureActor.startCapture()
                DispatchQueue.main.async {
                    completion(nil)
                }
            } catch {
                print("startAudioVideoCapture error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError)
                }
            }
        }
    }

    @objc public func testMethod() {
        print("Test from ScreenCaptureManager")
    }

    @objc public func setVideoBufferCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        Task {
            await captureActor.setVideoCallback(callback)
        }
    }

    @objc public func setAudioBufferCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        Task {
            await captureActor.setAudioCallback(callback)
        }
    }
    
    @objc public func setWebRTCVideoCallback(_ callback: @escaping ([String: Any]) -> Void) {
        Task {
            await captureActor.setWebRTCVideoCallback(callback)
        }
    }
    
    @objc public func setWebRTCAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        Task {
            await captureActor.setWebRTCAudioCallback(callback)
        }
    }

    @objc public func getAvailableSourcesWithCompletion(_ completion: @escaping @Sendable (NSError?, [[String: Any]]?) -> Void) {
        print("getAvailableSourcesWithCompletion called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                let sources = try await captureActor.getAvailableSources()
                DispatchQueue.main.async {
                    completion(nil, sources)
                }
            } catch {
                print("getAvailableSources error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError, nil)
                }
            }
        }
    }

    @available(macOS 14.0, *)
    @objc public func selectSourceWithPickerWithCompletion(_ completion: @escaping @Sendable (NSError?, [String: Any]?) -> Void) {
        Task.detached { [captureActor = self.captureActor] in
            await captureActor.setPickerCompletion(completion)
            let picker = SCContentSharingPicker.shared
            await MainActor.run { [weak self] in
                guard let self = self else { return }
                picker.add(self)
                picker.isActive = true
            }
        }
    }

    @available(macOS 14.0, *)
    public func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        print("contentSharingPicker didUpdateWith filter")
        picker.remove(self)
        picker.isActive = false
        Task.detached { [captureActor = self.captureActor, filter] in
            let completion = await captureActor.getPickerCompletion()
            do {
                print("Fetching SCShareableContent.current")
                let content = try await SCShareableContent.current
                var source: [String: Any]?
                for window in content.windows {
                    let testFilter = SCContentFilter(desktopIndependentWindow: window)
                    if testFilter == filter {
                        source = ["type": "window", "id": "\(window.windowID)"]
                        break
                    }
                }
                if source == nil {
                    for display in content.displays {
                        let testFilter = SCContentFilter(display: display, excludingWindows: [])
                        if testFilter == filter {
                            source = ["type": "display", "id": "\(display.displayID)"]
                            break
                        }
                    }
                }
                print("Source found: \(source ?? [:])")
                let strongSource = source
                DispatchQueue.main.async {
                    completion?(nil, strongSource)
                }
            } catch {
                DispatchQueue.main.async {
                    completion?(error as NSError, nil)
                }
            }
            await captureActor.clearPickerCompletion()
        }
    }

    @available(macOS 14.0, *)
    public func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        print("contentSharingPicker didCancel")
        picker.remove(self)
        picker.isActive = false
        Task.detached { [captureActor = self.captureActor] in
            let completion = await captureActor.getPickerCompletion()
            DispatchQueue.main.async {
                completion?(NSError(domain: "Cancelled", code: 2), nil)
            }
            await captureActor.clearPickerCompletion()
        }
    }

    @available(macOS 14.0, *)
    public func contentSharingPickerStartDidFailWithError(_ error: any Error) {
        print("contentSharingPickerStartDidFailWithError: \(error)")
        Task.detached { [captureActor = self.captureActor] in
            let completion = await captureActor.getPickerCompletion()
            DispatchQueue.main.async {
                completion?(error as NSError, nil)
            }
            await captureActor.clearPickerCompletion()
        }
    }

    @objc public func debugDisplayInfo(_ completion: @escaping @Sendable (String) -> Void) {
        Task.detached {
            do {
                let contentTask = Task { @MainActor in
                    try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                }
                let content = try await contentTask.value
                
                var info = "=== DISPLAY DIAGNOSTIC INFO ===\n"
                info += "Number of displays: \(content.displays.count)\n\n"
                
                for (index, display) in content.displays.enumerated() {
                    info += "Display #\(index + 1):\n"
                    info += "  - Display ID: \(display.displayID)\n"
                    info += "  - Size: \(display.width) x \(display.height)\n"
                    info += "  - Frame: \(display.frame)\n"
                    info += "\n"
                }
                
                info += "Number of windows: \(content.windows.count)\n"
                info += "First 5 windows:\n"
                for window in content.windows.prefix(5) {
                    info += "  - Window ID: \(window.windowID), Title: \(window.title ?? "No title")\n"
                }
                
                print(info)
                
                DispatchQueue.main.async {
                    completion(info)
                }
            } catch {
                let errorInfo = "Failed to get display info: \(error.localizedDescription)"
                print(errorInfo)
                DispatchQueue.main.async {
                    completion(errorInfo)
                }
            }
        }
    }

    @objc public func validateSourceId(_ sourceId: String, completion: @escaping @Sendable (Bool, String) -> Void) {
        Task.detached {
            do {
                let contentTask = Task { @MainActor in
                    try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                }
                let content = try await contentTask.value
                
                // Parse the source ID
                var cleanId = sourceId
                cleanId = cleanId.replacingOccurrences(of: "screen:", with: "")
                cleanId = cleanId.replacingOccurrences(of: "display:", with: "")
                cleanId = cleanId.replacingOccurrences(of: ":0", with: "")
                
                if let displayID = UInt32(cleanId) {
                    let found = content.displays.contains { $0.displayID == displayID }
                    
                    if found {
                        DispatchQueue.main.async {
                            completion(true, "Display \(displayID) found")
                        }
                    } else {
                        let availableIDs = content.displays.map { String($0.displayID) }.joined(separator: ", ")
                        DispatchQueue.main.async {
                            completion(false, "Display \(displayID) not found. Available: \(availableIDs)")
                        }
                    }
                } else {
                    DispatchQueue.main.async {
                        completion(false, "Invalid ID format: \(sourceId)")
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    completion(false, "Error: \(error.localizedDescription)")
                }
            }
        }
    }

    @objc public func setCaptureQuality(_ width: Int32, height: Int32, fps: Int32) {
        print("📐 ScreenCaptureManager.setCaptureQuality called")
        print("   Width: \(width)")
        print("   Height: \(height)")
        print("   FPS: \(fps)")
        
        Task {
            await captureActor.setCaptureQuality(width: Int(width), height: Int(height), fps: Int(fps))
            print("📐 Quality set in actor")
        }
    }

    // Альтернативный вариант с другим именем для теста
    @objc public func testSetQuality(_ width: Int32, height: Int32, fps: Int32) {
        print("📐 TEST: testSetQuality called: \(width)x\(height)@\(fps)")
    }
    
}  // End of class

class RecordingError: NSError, @unchecked Sendable {
    init(_ message: String) {
        super.init(domain: "RecordingDomain", code: 0, userInfo: [NSLocalizedDescriptionKey: message])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

// Fix Sendable conformances
extension SCShareableContent: @retroactive @unchecked Sendable {}
extension SCDisplay: @retroactive @unchecked Sendable {}
extension SCWindow: @retroactive @unchecked Sendable {}
extension SCRunningApplication: @retroactive @unchecked Sendable {}
extension CMSampleBuffer: @retroactive @unchecked Sendable {}
extension SCStream: @retroactive @unchecked Sendable {}
extension AVCaptureOutput: @retroactive @unchecked Sendable {}
extension AVCaptureConnection: @retroactive @unchecked Sendable {}
extension SCContentFilter: @retroactive @unchecked Sendable {}
