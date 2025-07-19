// CMSampleBuffer+Extensions.swift
import CoreMedia

extension CMSampleBuffer {
    func getImageBuffer() -> CVImageBuffer? {
        return CMSampleBufferGetImageBuffer(self)
    }
}

// ScreenCaptureManager.swift
import Foundation
import ScreenCaptureKit
@preconcurrency import AVFoundation
import VideoToolbox
import AppKit
import CoreMedia

@available(macOS 12.3, *)
class CaptureOutputDelegate: NSObject, SCStreamDelegate, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    weak var actor: CaptureActor?

    override init() {
        super.init()
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        Task {
            await self.actor?.handleStreamError(error)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        Task {
            await self.actor?.stream(stream, didOutputSampleBuffer: sampleBuffer, of: outputType)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        Task {
            await self.actor?.captureOutput(output, didOutput: sampleBuffer, from: connection)
        }
    }
}

@available(macOS 12.3, *)
actor CaptureActor {
    var isCapturing = false
    var errorMessage: String?
    
    private var stream: SCStream?
    private var captureSession: AVCaptureSession?
    private var assetWriter: AVAssetWriter?
    private var audioFile: AVAudioFile?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var videoFileURL = URL(fileURLWithPath: "/Users/sg12/Movies/ScreenCapture.mp4")
    private var audioFileURL = URL(fileURLWithPath: "/Users/sg12/Movies/MicCapture.m4a")
    private var mergedFileURL = URL(fileURLWithPath: "/Users/sg12/Movies/MergedCapture.mp4")
    private var firstSampleTime: CMTime = .zero
    private var lastVideoTime: CMTime = .zero
    private var lastAudioTime: CMTime = .zero
    private let sampleBufferQueue = DispatchQueue(label: "ScreenCaptureManager.SampleBufferQueue")
    private var contentFilter: SCContentFilter?
    private var captureWidth: Int = 0
    private var captureHeight: Int = 0
    private let outputDelegate: CaptureOutputDelegate

    init() {
        let delegate = CaptureOutputDelegate()
        self.outputDelegate = delegate
        delegate.actor = self
    }

    func handleStreamError(_ error: Error) {
        print("Stream stopped with error: \(error.localizedDescription)")
    }

    func setCaptureSource(_ source: [String: Any]) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let type = source["type"] as? String, let id = source["id"] as? String else {
            throw RecordingError("Invalid source format")
        }
        
        guard let mainDisplay = content.displays.first else {
            throw RecordingError("Display not found")
        }
        
        if type == "display" {
            guard let displayID = UInt32(id), let display = content.displays.first(where: { $0.displayID == displayID }) else {
                throw RecordingError("Screen not found")
            }
            contentFilter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            captureWidth = display.width
            captureHeight = display.height
        } else if type == "window" {
            guard let windowID = UInt32(id), let window = content.windows.first(where: { $0.windowID == windowID }) else {
                throw RecordingError("Window not found")
            }
            contentFilter = SCContentFilter(desktopIndependentWindow: window)
            captureWidth = Int(window.frame.width)
            captureHeight = Int(window.frame.height)
        } else if type == "application" {
            guard let app = content.applications.first(where: { $0.bundleIdentifier == id }) else {
                throw RecordingError("Application not found")
            }
            contentFilter = SCContentFilter(display: mainDisplay, including: [app], exceptingWindows: [])
            captureWidth = mainDisplay.width
            captureHeight = mainDisplay.height
        } else {
            throw RecordingError("Unsupported source type")
        }
    }

    private func selectSource() async throws -> [String: Any] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        
        var sourceList: [[String: Any]] = []
        var displayNames: [String] = []
        
        for (i, display) in content.displays.enumerated() {
            let name = "Screen \(i + 1)"
            displayNames.append(name)
            sourceList.append(["type": "display", "id": display.displayID])
        }
        
        for window in content.windows {
            let name = "\(window.title ?? "Untitled") - \(window.owningApplication?.applicationName ?? "Unknown")"
            displayNames.append(name)
            sourceList.append(["type": "window", "id": window.windowID])
        }
        
        for app in content.applications {
            let name = app.applicationName
            displayNames.append(name)
            sourceList.append(["type": "application", "id": app.bundleIdentifier])
        }
        
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.main.async {
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
                        let selectedSource = sourceList[selectedIndex]
                        continuation.resume(returning: selectedSource)
                    } else {
                        continuation.resume(throwing: RecordingError("No selection"))
                    }
                } else {
                    continuation.resume(throwing: RecordingError("Cancelled"))
                }
            }
        }
    }

    func startCapture() async throws {
        errorMessage = nil

        guard CGPreflightScreenCaptureAccess() else {
            print("No screen capture permission")
            errorMessage = "Screen capture permission denied."
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
            throw RecordingError("No screen capture permission")
        }

        try await requestMicrophoneAccess()

        if contentFilter == nil {
            let selectedSource = try await selectSource()
            try await setCaptureSource(selectedSource)
        }

        let fileManager = FileManager.default
        let moviesDir = URL(fileURLWithPath: "/Users/sg12/Movies")
        try fileManager.createDirectory(at: moviesDir, withIntermediateDirectories: true, attributes: nil)
        print("Folder /Users/sg12/Movies is accessible")

        try? fileManager.removeItem(at: videoFileURL)
        try? fileManager.removeItem(at: audioFileURL)
        try? fileManager.removeItem(at: mergedFileURL)

        assetWriter = try AVAssetWriter(outputURL: videoFileURL, fileType: .mp4)
        
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: captureWidth,
            AVVideoHeightKey: captureHeight,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 6000000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264High40,
                AVVideoExpectedSourceFrameRateKey: 60
            ]
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput?.expectsMediaDataInRealTime = true

        let sourcePixelBufferAttributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: captureWidth,
            kCVPixelBufferHeightKey as String: captureHeight
        ]
        pixelBufferAdaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput!, sourcePixelBufferAttributes: sourcePixelBufferAttributes)

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false
        ]
        audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput?.expectsMediaDataInRealTime = true

        if let videoInput = videoInput, assetWriter!.canAdd(videoInput) {
            assetWriter!.add(videoInput)
            print("Video input added to AVAssetWriter")
        } else {
            throw RecordingError("Failed to add video input")
        }
        if let audioInput = audioInput, assetWriter!.canAdd(audioInput) {
            assetWriter!.add(audioInput)
            print("Audio input added to AVAssetWriter")
        } else {
            throw RecordingError("Failed to add audio input")
        }
        
        guard assetWriter!.startWriting() else {
            throw RecordingError("Failed to start AVAssetWriter writing")
        }
        assetWriter!.startSession(atSourceTime: .zero)
        print("AVAssetWriter started writing")
        
        audioFile = try AVAudioFile(forWriting: audioFileURL, settings: audioSettings)
        print("AVAudioFile for microphone created: \(audioFileURL.path)")

        let config = SCStreamConfiguration()
        config.width = captureWidth
        config.height = captureHeight
        if #available(macOS 13.0, *) {
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = false
            config.sampleRate = 48000
            config.channelCount = 1
        }
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.queueDepth = 5
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true

        let session = AVCaptureSession()
        captureSession = session
        guard let audioDevice = AVCaptureDevice.default(for: .audio) else {
            throw RecordingError("Microphone unavailable")
        }
        let audioInputDevice = try AVCaptureDeviceInput(device: audioDevice)
        if session.canAddInput(audioInputDevice) {
            session.addInput(audioInputDevice)
            print("Microphone audio input added")
        } else {
            throw RecordingError("Failed to add audio input")
        }
        let audioOutput = AVCaptureAudioDataOutput()
        audioOutput.setSampleBufferDelegate(outputDelegate, queue: sampleBufferQueue)
        if session.canAddOutput(audioOutput) {
            session.addOutput(audioOutput)
            print("Microphone audio output added")
        } else {
            throw RecordingError("Failed to add audio output")
        }

        let streamLocal = SCStream(filter: contentFilter!, configuration: config, delegate: outputDelegate)
        try streamLocal.addStreamOutput(outputDelegate, type: .screen, sampleHandlerQueue: sampleBufferQueue)
        if #available(macOS 13.0, *) {
            try streamLocal.addStreamOutput(outputDelegate, type: .audio, sampleHandlerQueue: sampleBufferQueue)
        }
        
        try await streamLocal.startCapture()
        session.startRunning()
        print("AVCaptureSession started, state: \(session.isRunning)")
        
        self.stream = streamLocal
        isCapturing = true
        print("Video and audio capture started")
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
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
            throw RecordingError("Microphone access denied")
        @unknown default:
            throw RecordingError("Unknown microphone access status")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) async {
        guard isCapturing, let assetWriter = assetWriter else {
            return
        }
        
        if assetWriter.status != .writing {
            return
        }
        
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstSampleTime == .zero {
            firstSampleTime = presentationTime
        }
        
        let adjustedTime = presentationTime - firstSampleTime
        
        var timingInfo = CMSampleTimingInfo(
            duration: sampleBuffer.duration,
            presentationTimeStamp: adjustedTime,
            decodeTimeStamp: .invalid
        )
        
        var newSampleBuffer: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timingInfo,
            sampleBufferOut: &newSampleBuffer
        )
        
        guard let newSampleBuffer = newSampleBuffer else {
            return
        }
        
        switch type {
        case .screen:
            if let videoInput = videoInput, let pixelBufferAdaptor = pixelBufferAdaptor, videoInput.isReadyForMoreMediaData {
                guard let imageBuffer = newSampleBuffer.getImageBuffer() else {
                    return
                }
                
                if pixelBufferAdaptor.append(imageBuffer, withPresentationTime: adjustedTime) {
                    lastVideoTime = adjustedTime
                    print("Video buffer appended, time: \(adjustedTime.seconds)")
                }
            }
        case .audio:
            if let audioInput = audioInput, audioInput.isReadyForMoreMediaData {
                if audioInput.append(newSampleBuffer) {
                    lastAudioTime = adjustedTime
                    print("Audio buffer appended, time: \(adjustedTime.seconds)")
                }
            }
        default:
            break
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) async {
        guard isCapturing, let audioFile = audioFile else { return }
        
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let adjustedTime = presentationTime - firstSampleTime
        
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let blockBuffer = sampleBuffer.dataBuffer else {
            return
        }
        
        let format = AVAudioFormat(cmAudioFormatDescription: formatDescription)
        let numSamples = AVAudioFrameCount(sampleBuffer.numSamples)
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: numSamples) else {
            return
        }
        
        let audioBufferList = UnsafeMutableAudioBufferListPointer(pcmBuffer.mutableAudioBufferList)
        let channels = Int(format.channelCount)
        
        for i in 0..<channels {
            let abl = audioBufferList[i]
            guard let destination = abl.mData else {
                continue
            }
            let offset = i * Int(numSamples) * MemoryLayout<Float>.size
            let status = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: offset, dataLength: Int(numSamples) * MemoryLayout<Float>.size, destination: destination)
            if status != noErr {
                continue
            }
            let floatData = destination.assumingMemoryBound(to: Float.self)
            for j in 0..<Int(numSamples) {
                floatData[j] *= 2.0
            }
        }
        
        pcmBuffer.frameLength = numSamples
        
        do {
            try audioFile.write(from: pcmBuffer)
            lastAudioTime = adjustedTime
            print("Microphone buffer written, time: \(adjustedTime.seconds)")
        } catch {
            print("Error writing microphone buffer: \(error.localizedDescription)")
        }
    }
    
    func stopCapture() async throws {
        guard let stream = stream else {
            throw RecordingError("Stream not initialized")
        }

        try await stream.stopCapture()
        if let session = captureSession {
            print("AVCaptureSession state before stop: \(session.isRunning)")
            session.stopRunning()
            print("Capture stopped")
        }

        try await Task.sleep(nanoseconds: 1_000_000_000)

        let endTime = max(lastVideoTime, lastAudioTime)
        if endTime != .zero {
            assetWriter?.endSession(atSourceTime: endTime)
            print("Session ended at time: \(endTime.seconds) seconds")
        } else {
            print("Warning: endTime is zero, possibly no buffers were written")
        }

        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        audioFile = nil

        guard let assetWriter = assetWriter else {
            throw RecordingError("AVAssetWriter not initialized")
        }

        let videoFileURL = self.videoFileURL
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            assetWriter.finishWriting {
                if assetWriter.status == .completed {
                    print("Writing completed. File saved at \(videoFileURL.path)")
                    continuation.resume()
                } else {
                    let error = assetWriter.error ?? RecordingError("Unknown writing completion error")
                    print("Error completing writing: \(error.localizedDescription)")
                    continuation.resume(throwing: error)
                }
            }
        }

        try await mergeVideoAndAudio()

        isCapturing = false
        self.stream = nil
        self.captureSession = nil
        self.assetWriter = nil
        self.videoInput = nil
        self.audioInput = nil
        self.pixelBufferAdaptor = nil
        firstSampleTime = .zero
        lastVideoTime = .zero
        lastAudioTime = .zero
        contentFilter = nil

        do {
            let videoAttributes = try FileManager.default.attributesOfItem(atPath: videoFileURL.path)
            if let fileSize = videoAttributes[.size] as? Int64 {
                print("Video file size: \(fileSize) bytes")
                if fileSize < 1000 {
                    print("Warning: Video file too small, possibly no data written")
                }
            }
            let audioAttributes = try FileManager.default.attributesOfItem(atPath: audioFileURL.path)
            if let fileSize = audioAttributes[.size] as? Int64 {
                print("Audio file size: \(fileSize) bytes")
                if fileSize < 1000 {
                    print("Warning: Audio file too small, possibly no data written")
                }
            }
            let mergedAttributes = try FileManager.default.attributesOfItem(atPath: mergedFileURL.path)
            if let fileSize = mergedAttributes[.size] as? Int64 {
                print("Merged file size: \(fileSize) bytes")
                if fileSize < 1000 {
                    print("Warning: Merged file too small, possibly no data written")
                }
            }
        } catch {
            print("Error checking files: \(error.localizedDescription)")
        }
    }

    func mergeVideoAndAudio() async throws {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: videoFileURL.path) else {
            throw RecordingError("Video file does not exist")
        }
        guard fileManager.fileExists(atPath: audioFileURL.path) else {
            throw RecordingError("Audio file does not exist")
        }

        let videoAsset = AVURLAsset(url: videoFileURL)
        let audioAsset = AVURLAsset(url: audioFileURL)
        
        let composition = AVMutableComposition()
        
        guard let videoTrack = try await videoAsset.loadTracks(withMediaType: .video).first else {
            throw RecordingError("Failed to load video track")
        }
        let videoDuration = try await videoAsset.load(.duration)
        let compositionVideoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        try compositionVideoTrack?.insertTimeRange(CMTimeRange(start: .zero, duration: videoDuration), of: videoTrack, at: .zero)
        
        guard let audioTrack = try await audioAsset.loadTracks(withMediaType: .audio).first else {
            throw RecordingError("Failed to load audio track")
        }
        let audioDuration = try await audioAsset.load(.duration)
        let compositionAudioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        try compositionAudioTrack?.insertTimeRange(CMTimeRange(start: .zero, duration: min(videoDuration, audioDuration)), of: audioTrack, at: .zero)

        let audioMix = AVMutableAudioMix()
        let audioMixParams = AVMutableAudioMixInputParameters(track: compositionAudioTrack)
        audioMixParams.setVolume(1.0, at: .zero)
        audioMix.inputParameters.append(audioMixParams)
        
        if let systemAudioTrack = try await videoAsset.loadTracks(withMediaType: .audio).first {
            let compositionSystemAudioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            try compositionSystemAudioTrack?.insertTimeRange(CMTimeRange(start: .zero, duration: min(videoDuration, audioDuration)), of: systemAudioTrack, at: .zero)
            let systemAudioMixParams = AVMutableAudioMixInputParameters(track: compositionSystemAudioTrack)
            systemAudioMixParams.setVolume(3.0, at: .zero)
            audioMix.inputParameters.append(systemAudioMixParams)
        } else {
            print("Warning: Failed to load system audio track from \(videoFileURL.path)")
        }
        
        guard let exportSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            throw RecordingError("Failed to create AVAssetExportSession")
        }
        exportSession.outputURL = mergedFileURL
        exportSession.outputFileType = .mp4
        exportSession.audioMix = audioMix
        exportSession.shouldOptimizeForNetworkUse = true
        
        await exportSession.export()
        if exportSession.status == .completed {
            print("Merging completed. File saved at \(mergedFileURL.path)")
        } else {
            throw exportSession.error ?? RecordingError("Unknown export error")
        }
    }
}

@available(macOS 12.3, *)
@objc(CCaptureManager)
public class ScreenCaptureManager: NSObject {
    private let captureActor = CaptureActor()
    private var pickerCompletion: ((NSError?, [String: Any]?) -> Void)?

    @objc public var isCapturing: Bool {
        get {
            var result = false
            let semaphore = DispatchSemaphore(value: 0)
            Task {
                result = await captureActor.isCapturing
                semaphore.signal()
            }
            semaphore.wait()
            return result
        }
    }

    @objc public var errorMessage: String? {
        get {
            var result: String? = nil
            let semaphore = DispatchSemaphore(value: 0)
            Task {
                result = await captureActor.errorMessage
                semaphore.signal()
            }
            semaphore.wait()
            return result
        }
    }

    @objc public func setCaptureSource(_ source: [String: Any], completion: @escaping (NSError?) -> Void) {
        print("setCaptureSource called with source: \(source)")
        Task {
            do {
                try await captureActor.setCaptureSource(source)
                completion(nil)
            } catch {
                print("setCaptureSource error: \(error)")
                completion(error as NSError)
            }
        }
    }

    @objc public func startCaptureWithCompletion(_ completion: @escaping (NSError?) -> Void) {
        print("startCaptureWithCompletion called")
        Task {
            do {
                try await captureActor.startCapture()
                completion(nil)
            } catch {
                print("startCapture error: \(error)")
                completion(error as NSError)
            }
        }
    }

    @objc public func stopCaptureWithCompletion(_ completion: @escaping (NSError?) -> Void) {
        print("stopCaptureWithCompletion called")
        Task {
            do {
                try await captureActor.stopCapture()
                completion(nil)
            } catch {
                print("stopCapture error: \(error)")
                completion(error as NSError)
            }
        }
    }

    @objc public func testMethod() {
        print("Test from ScreenCaptureManager")
    }
    
    @available(macOS 14.0, *)
    @objc public func selectSourceWithPicker(completion: @escaping (NSError?, [String: Any]?) -> Void) {
        print("selectSourceWithPicker called")
        pickerCompletion = completion
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                
                var screensSourceList: [[String: Any]] = []
                var screensNames: [String] = []
                for (i, display) in content.displays.enumerated() {
                    let name = "Screen \(i + 1)"
                    screensNames.append(name)
                    screensSourceList.append(["type": "display", "id": "\(display.displayID)"])
                }
                
                var windowsSourceList: [[String: Any]] = []
                var windowsNames: [String] = []
                for window in content.windows {
                    let name = "\(window.title ?? "Untitled") - \(window.owningApplication?.applicationName ?? "Unknown")"
                    windowsNames.append(name)
                    windowsSourceList.append(["type": "window", "id": "\(window.windowID)"])
                }
                
                var appsSourceList: [[String: Any]] = []
                var appsNames: [String] = []
                for app in content.applications {
                    let name = app.applicationName
                    appsNames.append(name)
                    appsSourceList.append(["type": "application", "id": app.bundleIdentifier])
                }
                
                let selectedSource = try await withCheckedThrowingContinuation(function: "selectSource") { continuation in
                    DispatchQueue.main.async {
                        print("On main thread, showing tabbed test alert")
                        let alert = NSAlert()
                        alert.messageText = "Test UI Window with Tabs"
                        alert.informativeText = "This is a test to see if tabbed UI can be shown. Select and click OK to proceed to picker."
                        
                        let tabView = NSTabView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
                        
                        let screensTab = NSTabViewItem(identifier: "Screens")
                        screensTab.label = "Screens"
                        let screensDataSource = TableDataSource(names: screensNames)
                        let screensScroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
                        let screensTable = NSTableView(frame: screensScroll.bounds)
                        let screensColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
                        screensColumn.title = "Name"
                        screensColumn.width = 580
                        screensTable.addTableColumn(screensColumn)
                        screensTable.dataSource = screensDataSource
                        screensTable.delegate = screensDataSource
                        screensTable.allowsMultipleSelection = false
                        screensTable.allowsEmptySelection = false
                        screensTable.reloadData()
                        screensScroll.documentView = screensTable
                        screensTab.view = screensScroll
                        tabView.addTabViewItem(screensTab)
                        
                        let windowsTab = NSTabViewItem(identifier: "Windows")
                        windowsTab.label = "Windows"
                        let windowsDataSource = TableDataSource(names: windowsNames)
                        let windowsScroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
                        let windowsTable = NSTableView(frame: windowsScroll.bounds)
                        let windowsColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
                        windowsColumn.title = "Name"
                        windowsColumn.width = 580
                        windowsTable.addTableColumn(windowsColumn)
                        windowsTable.dataSource = windowsDataSource
                        windowsTable.delegate = windowsDataSource
                        windowsTable.allowsMultipleSelection = false
                        windowsTable.allowsEmptySelection = false
                        windowsTable.reloadData()
                        windowsScroll.documentView = windowsTable
                        windowsTab.view = windowsScroll
                        tabView.addTabViewItem(windowsTab)
                        
                        let appsTab = NSTabViewItem(identifier: "Apps")
                        appsTab.label = "Apps"
                        let appsDataSource = TableDataSource(names: appsNames)
                        let appsScroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
                        let appsTable = NSTableView(frame: appsScroll.bounds)
                        let appsColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
                        appsColumn.title = "Name"
                        appsColumn.width = 580
                        appsTable.addTableColumn(appsColumn)
                        appsTable.dataSource = appsDataSource
                        appsTable.delegate = appsDataSource
                        appsTable.allowsMultipleSelection = false
                        appsTable.allowsEmptySelection = false
                        appsTable.reloadData()
                        appsScroll.documentView = appsTable
                        appsTab.view = appsScroll
                        tabView.addTabViewItem(appsTab)
                        
                        alert.accessoryView = tabView
                        
                        alert.addButton(withTitle: "OK")
                        alert.addButton(withTitle: "Cancel")
                        
                        let response = alert.runModal()
                        print("Tabbed alert response: \(response)")
                        if response == .alertFirstButtonReturn {
                            let selectedTab = tabView.selectedTabViewItem
                            var selectedIndex = -1
                            var selectedSourceList: [[String: Any]] = []
                            
                            if let selectedTab = selectedTab {
                                if selectedTab.identifier as? String == "Screens" {
                                    if let scroll = selectedTab.view as? NSScrollView, let table = scroll.documentView as? NSTableView {
                                        selectedIndex = table.selectedRow
                                        selectedSourceList = screensSourceList
                                    }
                                } else if selectedTab.identifier as? String == "Windows" {
                                    if let scroll = selectedTab.view as? NSScrollView, let table = scroll.documentView as? NSTableView {
                                        selectedIndex = table.selectedRow
                                        selectedSourceList = windowsSourceList
                                    }
                                } else if selectedTab.identifier as? String == "Apps" {
                                    if let scroll = selectedTab.view as? NSScrollView, let table = scroll.documentView as? NSTableView {
                                        selectedIndex = table.selectedRow
                                        selectedSourceList = appsSourceList
                                    }
                                }
                                
                                if selectedIndex >= 0 {
                                    let selectedSource = selectedSourceList[selectedIndex]
                                    continuation.resume(returning: selectedSource)
                                } else {
                                    continuation.resume(throwing: RecordingError("No selection"))
                                }
                            } else {
                                continuation.resume(throwing: RecordingError("No tab selected"))
                            }
                        } else {
                            continuation.resume(throwing: RecordingError("Cancelled"))
                        }
                    }
                }
                try await captureActor.setCaptureSource(selectedSource)
                try await captureActor.startCapture()
                completion(nil, selectedSource)
            } catch {
                completion(error as NSError, nil)
            }
            // Comment out the picker for now
            // print("Test tabbed alert shown, now showing picker")
            // let picker = SCContentSharingPicker.shared
            // picker.add(self)
            // picker.isActive = true
            // print("Picker isActive set to true")
        }
    }
}

@available(macOS 14.0, *)
extension ScreenCaptureManager: SCContentSharingPickerObserver {
    public func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        print("contentSharingPicker didUpdateWith filter")
        picker.remove(self)
        picker.isActive = false
        Task {
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
                pickerCompletion?(nil, source)
            } catch {
                print("Error in didUpdateWith: \(error)")
                pickerCompletion?(error as NSError, nil)
            }
            pickerCompletion = nil
        }
    }
    
    public func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        print("contentSharingPicker didCancel")
        picker.remove(self)
        picker.isActive = false
        pickerCompletion?(NSError(domain: "Cancelled", code: 2), nil)
        pickerCompletion = nil
    }

    public func contentSharingPickerStartDidFailWithError(_ error: Error) {
        print("contentSharingPickerStartDidFailWithError: \(error)")
        pickerCompletion?(error as NSError, nil)
        pickerCompletion = nil
    }
}

class TableDataSource: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let names: [String]
    
    init(names: [String]) {
        self.names = names
        super.init()
    }
    
    func numberOfRows(in tableView: NSTableView) -> Int {
        names.count
    }
    
    func tableView(_ tableView: NSTableView, objectValueFor tableColumn: NSTableColumn?, row: Int) -> Any? {
        names[row]
    }
}

class RecordingError: NSError, @unchecked Sendable {
    init(_ message: String) {
        super.init(domain: "RecordingDomain", code: 0, userInfo: [NSLocalizedDescriptionKey: message])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}
