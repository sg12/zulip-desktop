// jitsi-ui-manager.ts
import { BrowserWindow } from "electron";
import log from "electron-log";

export class JitsiUIManager {
    public async injectLoadingScreen(window: BrowserWindow): Promise<void> {
        if (!window || window.isDestroyed()) return;
        
        const loadingHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    
                    body {
                        background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1e 100%);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                        overflow: hidden;
                    }
                    
                    .loading-container {
                        text-align: center;
                        animation: fadeIn 0.5s ease-in;
                    }
                    
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(20px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    
                    .logo {
                        width: 80px;
                        height: 80px;
                        margin: 0 auto 30px;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        border-radius: 20px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        box-shadow: 0 10px 40px rgba(102, 126, 234, 0.3);
                        animation: pulse 2s ease-in-out infinite;
                    }
                    
                    @keyframes pulse {
                        0%, 100% { transform: scale(1); }
                        50% { transform: scale(1.05); }
                    }
                    
                    .logo svg {
                        width: 50px;
                        height: 50px;
                        fill: white;
                    }
                    
                    .loading-text {
                        color: #ffffff;
                        font-size: 18px;
                        font-weight: 500;
                        margin-bottom: 20px;
                        letter-spacing: 0.5px;
                    }
                    
                    .loading-subtext {
                        color: #8892b0;
                        font-size: 14px;
                        margin-bottom: 40px;
                    }
                    
                    .spinner-container {
                        position: relative;
                        width: 50px;
                        height: 50px;
                        margin: 0 auto;
                    }
                    
                    .spinner {
                        width: 50px;
                        height: 50px;
                        border: 3px solid rgba(255, 255, 255, 0.1);
                        border-top-color: #667eea;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                    }
                    
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                    
                    .progress-bar {
                        width: 250px;
                        height: 4px;
                        background: rgba(255, 255, 255, 0.1);
                        border-radius: 2px;
                        margin: 30px auto;
                        overflow: hidden;
                    }
                    
                    .progress-fill {
                        height: 100%;
                        background: linear-gradient(90deg, #667eea, #764ba2);
                        border-radius: 2px;
                        width: 0%;
                        /* Более реалистичная анимация прогресса - 7 секунд */
                        animation: progress 7s ease-out forwards;
                    }
                    
                    @keyframes progress {
                        0% { width: 0%; }
                        20% { width: 25%; }
                        40% { width: 45%; }
                        60% { width: 65%; }
                        80% { width: 85%; }
                        90% { width: 92%; }
                        100% { width: 98%; }
                    }
                    
                    .tips {
                        position: absolute;
                        bottom: 40px;
                        left: 50%;
                        transform: translateX(-50%);
                        color: #64748b;
                        font-size: 13px;
                        animation: tipChange 3s ease-in-out infinite;
                    }
                    
                    @keyframes tipChange {
                        0%, 100% { opacity: 0.6; }
                        50% { opacity: 1; }
                    }
                </style>
            </head>
            <body>
                <div class="loading-container">
                    <div class="logo">
                        <svg viewBox="0 0 24 24">
                            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                        </svg>
                    </div>
                    <div class="loading-text">Подключаемся к конференции</div>
                    <div class="loading-subtext" id="loading-status">Инициализация...</div>
                    <div class="spinner-container">
                        <div class="spinner"></div>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                </div>
                <div class="tips" id="loading-tips">Проверяем соединение...</div>
                
                <script>
                    // Меняем текст подсказок
                    const tips = [
                        'Проверяем соединение...',
                        'Загружаем интерфейс...',
                        'Настраиваем аудио и видео...',
                        'Подготавливаем конференцию...',
                        'Почти готово...'
                    ];
                    const statusTexts = [
                        'Инициализация...',
                        'Подключение к серверу...',
                        'Загрузка модулей...',
                        'Настройка параметров...',
                        'Финальная подготовка...'
                    ];
                    
                    let tipIndex = 0;
                    const tipsElement = document.getElementById('loading-tips');
                    const statusElement = document.getElementById('loading-status');
                    
                    setInterval(() => {
                        tipIndex = (tipIndex + 1) % tips.length;
                        tipsElement.style.opacity = '0';
                        setTimeout(() => {
                            tipsElement.textContent = tips[tipIndex];
                            tipsElement.style.opacity = '1';
                        }, 300);
                        
                        if (statusElement) {
                            statusElement.textContent = statusTexts[tipIndex];
                        }
                    }, 1500);
                </script>
            </body>
            </html>
        `;
        
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML)}`);
    }

    public async hideLoadingScreen(window: BrowserWindow): Promise<void> {
        if (!window || window.isDestroyed()) return;
        
        try {
            await window.webContents.executeJavaScript(`
                (function() {
                    // Создаем элемент для плавного перехода
                    const fadeOverlay = document.createElement('div');
                    fadeOverlay.style.cssText = \`
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: #1a1a2e;
                        z-index: 999999;
                        transition: opacity 0.8s ease-out;
                        pointer-events: none;
                    \`;
                    document.body.appendChild(fadeOverlay);
                    
                    // Более плавное скрытие
                    setTimeout(() => {
                        fadeOverlay.style.opacity = '0';
                        setTimeout(() => {
                            fadeOverlay.remove();
                        }, 800); // Совпадает с временем transition
                    }, 200); // Небольшая задержка перед началом
                    
                    console.log('[LOADING] Loading screen hidden with smooth transition');
                })();
            `);
        } catch (error) {
            log.error("[JITSI-MANAGER] Error hiding loading screen:", error);
        }
    }

    public async waitForJitsiReady(window: BrowserWindow): Promise<boolean> {
        if (!window || window.isDestroyed()) return false;
        
        let attempts = 0;
        const maxAttempts = 100; // 5 секунд максимум
        
        while (attempts < maxAttempts) {
            try {
                const isReady = await window.webContents.executeJavaScript(`
                    (function() {
                        // Проверяем различные индикаторы готовности Jitsi
                        const checks = {
                            hasJitsiMeetJS: typeof JitsiMeetJS !== 'undefined',
                            hasAPP: typeof APP !== 'undefined',
                            hasConference: !!(window.APP && window.APP.conference),
                            hasRoom: !!(window.APP && window.APP.conference && window.APP.conference._room),
                            domReady: document.readyState === 'complete',
                            hasToolbar: !!document.querySelector('.toolbox-content-items'),
                            // Добавляем проверку видео элементов
                            hasVideoContainer: !!document.querySelector('#largeVideoContainer'),
                            // Проверяем что UI полностью загружен
                            hasUIElements: !!document.querySelector('.filmstrip') && 
                                        !!document.querySelector('.toolbox'),
                            // Проверяем что нет видимых лоадеров
                            noLoaders: !document.querySelector('.spinner') && 
                                    !document.querySelector('.loading')
                        };
                        
                        // Считаем готовым если основные компоненты загружены
                        const isReady = checks.hasJitsiMeetJS && 
                                checks.hasAPP && 
                                checks.hasConference &&
                                checks.domReady &&
                                checks.hasToolbar &&
                                checks.hasVideoContainer &&
                                checks.hasUIElements;
                        
                        console.log('[LOADING] Jitsi ready check:', checks, 'Ready:', isReady);
                        return isReady;
                    })();
                `);
                
                if (isReady) {
                    await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 секунды дополнительно
                    log.info("[JITSI-MANAGER] Jitsi is ready!");
                    return true;
                }
            } catch (error) {
                // Игнорируем ошибки во время загрузки
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        log.warn("[JITSI-MANAGER] Jitsi initialization timeout, proceeding anyway");
        return false;
    }

    public async injectDebugOverlay(
        window: BrowserWindow | null,
        config: { enableDebugUI?: boolean },
        nativeAvailable: boolean,
        useStandardJitsi: boolean,
        useNativeAudio: boolean,
        getDebugInfo: () => Promise<any>
    ): Promise<void> {
        log.info("[JITSI-MANAGER] Injecting debug indicator with quality controls...");
        
        if (!config.enableDebugUI) {
            return;
        }
        
        if (!window || window.isDestroyed()) {
            return;
        }
        
        // Проверяем доступность нативного плагина
        const showQualityControls = nativeAvailable && !useStandardJitsi;
        
        log.info(`[JITSI-MANAGER] Native available: ${nativeAvailable}, Show quality controls: ${showQualityControls}`);
        
        try {
            // Проверяем, не инъектировано ли уже
            const alreadyInjected = await window.webContents.executeJavaScript(`
                !!(document.getElementById('native-debug-indicator'))
            `);
            
            if (alreadyInjected) {
                return;
            }
            
            // ШАГ 1: Добавляем стили
            await window.webContents.executeJavaScript(`
                (function() {
                    const style = document.createElement('style');
                    style.id = 'debug-indicator-styles';
                    style.textContent = \`
                        @keyframes pulse {
                            0% { opacity: 1; }
                            50% { opacity: 0.5; }
                            100% { opacity: 1; }
                        }
                        @keyframes slideIn {
                            from { transform: translateX(-100%); opacity: 0; }
                            to { transform: translateX(0); opacity: 1; }
                        }
                        @keyframes slideOut {
                            from { transform: translateX(0); opacity: 1; }
                            to { transform: translateX(-100%); opacity: 0; }
                        }
                        #quality-preset option {
                            background: #222;
                            color: white;
                        }
                        input[type="number"]::-webkit-inner-spin-button,
                        input[type="number"]::-webkit-outer-spin-button {
                            opacity: 1;
                            height: 20px;
                        }
                        #apply-custom:hover {
                            background: #45a049 !important;
                        }
                        #quality-toggle:hover {
                            color: rgba(255,255,255,1) !important;
                        }
                        .status-badge {
                            padding: 2px 6px;
                            border-radius: 4px;
                            font-size: 10px;
                            font-weight: bold;
                            color: white;
                            margin-left: 8px;
                        }
                        .native-mode { background: #4CAF50; }
                        .standard-mode { background: #FF9800; }
                        .error-mode { background: #f44336; }
                        #native-audio-toggle {
                            width: 16px;
                            height: 16px;
                            position: relative;
                            -webkit-appearance: none;
                            appearance: none;
                            background: rgba(255,255,255,0.2);
                            border-radius: 3px;
                            outline: none;
                            cursor: pointer;
                            transition: background 0.3s;
                        }
                        
                        #native-audio-toggle:checked {
                            background: #4CAF50;
                        }
                        
                        #native-audio-toggle:checked::after {
                            content: '✓';
                            position: absolute;
                            color: white;
                            font-size: 12px;
                            top: -2px;
                            left: 2px;
                        }
                        
                        #native-audio-toggle:hover {
                            background: rgba(255,255,255,0.3);
                        }
                        
                        #native-audio-toggle:checked:hover {
                            background: #45a049;
                        }
                    \`;
                    document.head.appendChild(style);
                    return true;
                })();
            `);
            
            // ШАГ 2: Создаем HTML структуру - передаем параметры через переменные
            await window.webContents.executeJavaScript(`
                (function() {
                    // Получаем параметры
                    const showQualityControls = ${showQualityControls};
                    const nativeAvailable = ${nativeAvailable};
                    
                    console.log('[DEBUG] Creating indicator - showQualityControls:', showQualityControls, 'nativeAvailable:', nativeAvailable);
                    
                    // Удаляем старые элементы
                    const oldIndicator = document.getElementById('native-debug-indicator');
                    if (oldIndicator) oldIndicator.remove();
                    
                    const container = document.createElement('div');
                    container.id = 'native-debug-indicator';
                    container.style.cssText = 'position: fixed; top: 15px; left: 15px; z-index: 999999;';
                    
                    // Создаем индикатор бар
                    const indicatorBar = document.createElement('div');
                    indicatorBar.id = 'indicator-bar';
                    indicatorBar.style.cssText = 'display: flex; gap: 8px; padding: 6px 10px; background: rgba(0, 0, 0, 0.6); border-radius: 15px; align-items: center; backdrop-filter: blur(8px); transition: opacity 0.3s; margin-bottom: 8px;';
                    
                    // Точка для плагина
                    const pluginDot = document.createElement('div');
                    pluginDot.id = 'plugin-dot';
                    pluginDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: ' + (nativeAvailable ? '#4CAF50' : '#f44336') + '; transition: background 0.3s; box-shadow: 0 0 3px rgba(0,0,0,0.2);';
                    pluginDot.title = 'Plugin Status: ' + (nativeAvailable ? 'Available' : 'Not Available');
                    
                    // Точка для аудио
                    const audioDot = document.createElement('div');
                    audioDot.id = 'audio-dot';
                    audioDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: #2196F3; transition: background 0.3s; box-shadow: 0 0 3px rgba(0,0,0,0.2);';
                    audioDot.title = 'Audio Status';
                    
                    indicatorBar.appendChild(pluginDot);
                    indicatorBar.appendChild(audioDot);
                    
                    // Добавляем элементы управления качеством только если плагин доступен
                    if (showQualityControls) {
                        // Разделитель
                        const separator = document.createElement('div');
                        separator.style.cssText = 'width: 1px; height: 12px; background: rgba(255,255,255,0.2); margin: 0 4px;';
                        
                        // Кнопка настроек
                        const qualityToggle = document.createElement('button');
                        qualityToggle.id = 'quality-toggle';
                        qualityToggle.style.cssText = 'background: none; border: none; color: rgba(255,255,255,0.7); cursor: pointer; padding: 0; font-size: 12px; transition: color 0.2s;';
                        qualityToggle.title = 'Quality Settings';
                        qualityToggle.textContent = '⚙️';
                        
                        indicatorBar.appendChild(separator);
                        indicatorBar.appendChild(qualityToggle);
                    } else {
                        // Добавляем индикатор режима для standard mode
                        const modeIndicator = document.createElement('span');
                        modeIndicator.className = 'status-badge standard-mode';
                        modeIndicator.textContent = 'STANDARD';
                        modeIndicator.title = 'Using standard Jitsi (no quality controls)';
                        indicatorBar.appendChild(modeIndicator);
                    }

                    // Добавляем индикатор текущего режима (только для чтения)
                    const audioModeIndicator = document.createElement('div');
                    audioModeIndicator.id = 'audio-mode-indicator';
                    audioModeIndicator.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-left: 8px;';
                    
                    const audioModeIcon = document.createElement('span');
                    audioModeIcon.style.cssText = 'font-size: 10px;';
                    audioModeIcon.textContent = '🔊';
                    
                    const audioModeText = document.createElement('span');
                    audioModeText.id = 'audio-mode-text';
                    audioModeText.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.7);';
                    audioModeText.textContent = ${useNativeAudio} ? 'Native' : 'Standard';
                    
                    audioModeIndicator.appendChild(audioModeIcon);
                    audioModeIndicator.appendChild(audioModeText);
                    
                    indicatorBar.appendChild(audioModeIndicator);
                    
                    container.appendChild(indicatorBar);
                    document.body.appendChild(container);
                    
                    console.log('[DEBUG] Indicator bar created');
                    return true;
                })();
            `);
            
            // ШАГ 3: Создаем панель качества ТОЛЬКО если нативный плагин доступен
            if (showQualityControls) {
                await window.webContents.executeJavaScript(`
                    (function() {
                        const container = document.getElementById('native-debug-indicator');
                        if (!container) {
                            console.error('[DEBUG] Container not found for quality panel');
                            return false;
                        }
                        
                        const qualityPanel = document.createElement('div');
                        qualityPanel.id = 'quality-panel';
                        qualityPanel.style.cssText = 'display: none; background: rgba(0, 0, 0, 0.85); border-radius: 12px; padding: 12px; backdrop-filter: blur(10px); min-width: 200px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
                        
                        // Заголовок
                        const title = document.createElement('div');
                        title.style.cssText = 'color: #fff; font-size: 11px; margin-bottom: 10px; font-family: system-ui;';
                        title.textContent = 'Качество трансляции';
                        
                        // Селектор качества
                        const select = document.createElement('select');
                        select.id = 'quality-preset';
                        select.style.cssText = 'width: 100%; padding: 6px; border-radius: 6px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px; margin-bottom: 8px; cursor: pointer;';
                        
                        const options = [
                            ['ULTRALOW', 'Очень низкое (320x240 @ 15fps)'],
                            ['LOW', 'Низкое (640x480 @ 15fps)'],
                            ['MEDIUM', 'Среднее (1280x720 @ 10fps)', true],
                            ['HIGH', 'Высокое (1920x1080 @ 30fps)'],
                            ['ULTRAHIGH', 'Ультра (2560x1440 @ 30fps)'],
                            ['PRESENTATION', 'Презентация (1920x1080 @ 5fps)'],
                            ['SCREENSHARE', 'Демонстрация (1920x1080 @ 15fps)'],
                            ['CUSTOM', '➤ Настроить...']
                        ];
                        
                        options.forEach(([value, text, selected]) => {
                            const option = document.createElement('option');
                            option.value = value;
                            option.textContent = text;
                            option.style.background = '#222';
                            if (selected) option.selected = true;
                            select.appendChild(option);
                        });
                        
                        // Кастомные настройки
                        const customSettings = document.createElement('div');
                        customSettings.id = 'custom-settings';
                        customSettings.style.cssText = 'display: none;';
                        
                        const customInner = document.createElement('div');
                        customInner.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.1); margin: 8px 0; padding-top: 8px;';
                        
                        // Строка с width и height
                        const sizeRow = document.createElement('div');
                        sizeRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 6px;';
                        
                        const widthInput = document.createElement('input');
                        widthInput.id = 'custom-width';
                        widthInput.type = 'number';
                        widthInput.placeholder = 'Ширина';
                        widthInput.min = '320';
                        widthInput.max = '3840';
                        widthInput.style.cssText = 'flex: 1; padding: 4px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px;';
                        
                        const heightInput = document.createElement('input');
                        heightInput.id = 'custom-height';
                        heightInput.type = 'number';
                        heightInput.placeholder = 'Высота';
                        heightInput.min = '240';
                        heightInput.max = '2160';
                        heightInput.style.cssText = 'flex: 1; padding: 4px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px;';
                        
                        sizeRow.appendChild(widthInput);
                        sizeRow.appendChild(heightInput);
                        
                        // Строка с FPS и кнопкой
                        const controlRow = document.createElement('div');
                        controlRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px;';
                        
                        const fpsInput = document.createElement('input');
                        fpsInput.id = 'custom-fps';
                        fpsInput.type = 'number';
                        fpsInput.placeholder = 'FPS';
                        fpsInput.min = '1';
                        fpsInput.max = '60';
                        fpsInput.style.cssText = 'flex: 1; padding: 4px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px;';
                        
                        const applyButton = document.createElement('button');
                        applyButton.id = 'apply-custom';
                        applyButton.textContent = 'Установить';
                        applyButton.style.cssText = 'flex: 1; padding: 4px 12px; border-radius: 4px; background: #4CAF50; border: none; color: white; font-size: 11px; cursor: pointer; transition: background 0.2s;';
                        
                        controlRow.appendChild(fpsInput);
                        controlRow.appendChild(applyButton);
                        
                        customInner.appendChild(sizeRow);
                        customInner.appendChild(controlRow);
                        customSettings.appendChild(customInner);
                        
                        // Текущее качество
                        const currentQuality = document.createElement('div');
                        currentQuality.id = 'current-quality';
                        currentQuality.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); font-size: 10px; font-family: monospace;';
                        currentQuality.textContent = 'Текущее: -';
                        
                        qualityPanel.appendChild(title);
                        qualityPanel.appendChild(select);
                        qualityPanel.appendChild(customSettings);
                        qualityPanel.appendChild(currentQuality);
                        
                        container.appendChild(qualityPanel);
                        
                        console.log('[DEBUG] Quality panel created');
                        return true;
                    })();
                `);
            }
            
            // ШАГ 4: Добавляем функциональность - передаем showQualityControls как переменную
            await window.webContents.executeJavaScript(`
                (function() {
                    const showQualityControls = ${showQualityControls};
                    
                    const qualityToggle = document.getElementById('quality-toggle');
                    const qualityPanel = document.getElementById('quality-panel');
                    const qualityPreset = document.getElementById('quality-preset');
                    const customSettings = document.getElementById('custom-settings');
                    const applyCustom = document.getElementById('apply-custom');
                    const indicatorBar = document.getElementById('indicator-bar');
                    
                    // Только если есть элементы управления качеством
                    if (qualityToggle && qualityPanel) {
                        // Переключение панели
                        qualityToggle.onclick = function(e) {
                            e.stopPropagation();
                            qualityPanel.style.display = qualityPanel.style.display === 'none' ? 'block' : 'none';
                        };
                        
                        // Закрытие при клике вне
                        document.addEventListener('click', function(e) {
                            const container = document.getElementById('native-debug-indicator');
                            if (container && !container.contains(e.target)) {
                                if (qualityPanel) qualityPanel.style.display = 'none';
                            }
                        });
                        
                        // Выбор пресета
                        if (qualityPreset) {
                            qualityPreset.onchange = async function() {
                                const value = this.value;
                                if (value === 'CUSTOM') {
                                    if (customSettings) customSettings.style.display = 'block';
                                } else {
                                    if (customSettings) customSettings.style.display = 'none';
                                    if (window.ipcRenderer) {
                                        const result = await window.ipcRenderer.invoke('jitsi:change-video-quality', value);
                                        console.log('[Quality] Preset result:', result);
                                    }
                                }
                            };
                        }
                        
                        // Применение кастомных настроек
                        if (applyCustom) {
                            applyCustom.onclick = async function() {
                                const width = parseInt(document.getElementById('custom-width').value);
                                const height = parseInt(document.getElementById('custom-height').value);
                                const fps = parseInt(document.getElementById('custom-fps').value);
                                
                                if (width && height && fps && window.ipcRenderer) {
                                    const result = await window.ipcRenderer.invoke('jitsi:set-custom-quality', width, height, fps);
                                    console.log('[Quality] Custom result:', result);
                                }
                            };
                        }
                    }
                    
                    // Двойной клик для скрытия (работает всегда)
                    if (indicatorBar) {
                        indicatorBar.ondblclick = function() {
                            indicatorBar.style.opacity = '0.1';
                            if (qualityPanel) qualityPanel.style.display = 'none';
                            setTimeout(() => {
                                indicatorBar.style.opacity = '1';
                            }, 3000);
                        };
                    }
                    
                    // Функция обновления индикаторов
                    window.updateDebugIndicator = function(data) {
                        const pluginDot = document.getElementById('plugin-dot');
                        const audioDot = document.getElementById('audio-dot');
                        
                        if (pluginDot && data.hasAddon !== undefined) {
                            pluginDot.style.background = data.hasAddon ? '#4CAF50' : '#f44336';
                        }
                        
                        if (audioDot) {
                            const isAudioActive = data.nativeCaptureActive && 
                                                data.audioFrameCount > 0 && 
                                                data.isStreamActive;
                            audioDot.style.background = isAudioActive ? '#4CAF50' : '#2196F3';
                            audioDot.style.animation = isAudioActive ? 'pulse 2s infinite' : 'none';
                        }
                    };
                    
                    console.log('[DEBUG] ✅ Debug indicator ready (quality controls:', showQualityControls, ')');
                    return true;
                })();
            `);
            
            log.info(`✅ Debug indicator injected successfully (quality controls: ${showQualityControls})`);
            
            // Отправляем начальные данные
            const debugInfo = await getDebugInfo();
            await window.webContents.executeJavaScript(`
                if (window.updateDebugIndicator) {
                    window.updateDebugIndicator(${JSON.stringify(debugInfo)});
                }
            `);
            
            // Запускаем мониторинг
            this.startDebugMonitoring(window, getDebugInfo);
            
        } catch (error: any) {
            log.error(`[JITSI-MANAGER] Injection error: ${error.message}`);
        }
    }

    startDebugMonitoring(
        window: BrowserWindow | null,
        getDebugInfo: () => Promise<any>
    ): NodeJS.Timer | undefined {  // Изменяем тип возвращаемого значения
        if (!window || window.isDestroyed()) return undefined;
        
        const updateInterval = 2000;
        
        const interval = setInterval(async () => {
            if (!window || window.isDestroyed()) {
                clearInterval(interval);
                return;
            }
            
            try {
                const debugInfo = await getDebugInfo();
                
                await window.webContents.executeJavaScript(`
                    if (window.updateDebugIndicator) {
                        window.updateDebugIndicator(${JSON.stringify(debugInfo)});
                    }
                `);
                
            } catch (error) {
                // Тихо игнорируем ошибки мониторинга
            }
        }, updateInterval);
        
        return interval;  // Теперь можем вернуть interval
    }

    getLoadingScreenHTML(): string {
        // Это весь HTML код из метода injectLoadingScreen
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    
                    body {
                        background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1e 100%);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                        overflow: hidden;
                    }
                    
                    .loading-container {
                        text-align: center;
                        animation: fadeIn 0.5s ease-in;
                    }
                    
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(20px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    
                    .logo {
                        width: 80px;
                        height: 80px;
                        margin: 0 auto 30px;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        border-radius: 20px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        box-shadow: 0 10px 40px rgba(102, 126, 234, 0.3);
                        animation: pulse 2s ease-in-out infinite;
                    }
                    
                    @keyframes pulse {
                        0%, 100% { transform: scale(1); }
                        50% { transform: scale(1.05); }
                    }
                    
                    .logo svg {
                        width: 50px;
                        height: 50px;
                        fill: white;
                    }
                    
                    .loading-text {
                        color: #ffffff;
                        font-size: 18px;
                        font-weight: 500;
                        margin-bottom: 20px;
                        letter-spacing: 0.5px;
                    }
                    
                    .loading-subtext {
                        color: #8892b0;
                        font-size: 14px;
                        margin-bottom: 40px;
                    }
                    
                    .spinner-container {
                        position: relative;
                        width: 50px;
                        height: 50px;
                        margin: 0 auto;
                    }
                    
                    .spinner {
                        width: 50px;
                        height: 50px;
                        border: 3px solid rgba(255, 255, 255, 0.1);
                        border-top-color: #667eea;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                    }
                    
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                    
                    .progress-bar {
                        width: 250px;
                        height: 4px;
                        background: rgba(255, 255, 255, 0.1);
                        border-radius: 2px;
                        margin: 30px auto;
                        overflow: hidden;
                    }
                    
                    .progress-fill {
                        height: 100%;
                        background: linear-gradient(90deg, #667eea, #764ba2);
                        border-radius: 2px;
                        width: 0%;
                        animation: progress 7s ease-out forwards;
                    }
                    
                    @keyframes progress {
                        0% { width: 0%; }
                        20% { width: 25%; }
                        40% { width: 45%; }
                        60% { width: 65%; }
                        80% { width: 85%; }
                        90% { width: 92%; }
                        100% { width: 98%; }
                    }
                    
                    .tips {
                        position: absolute;
                        bottom: 40px;
                        left: 50%;
                        transform: translateX(-50%);
                        color: #64748b;
                        font-size: 13px;
                        animation: tipChange 3s ease-in-out infinite;
                    }
                    
                    @keyframes tipChange {
                        0%, 100% { opacity: 0.6; }
                        50% { opacity: 1; }
                    }
                </style>
            </head>
            <body>
                <div class="loading-container">
                    <div class="logo">
                        <svg viewBox="0 0 24 24">
                            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                        </svg>
                    </div>
                    <div class="loading-text">Подключаемся к конференции</div>
                    <div class="loading-subtext" id="loading-status">Инициализация...</div>
                    <div class="spinner-container">
                        <div class="spinner"></div>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                </div>
                <div class="tips" id="loading-tips">Проверяем соединение...</div>
                
                <script>
                    const tips = [
                        'Проверяем соединение...',
                        'Загружаем интерфейс...',
                        'Настраиваем аудио и видео...',
                        'Подготавливаем конференцию...',
                        'Почти готово...'
                    ];
                    const statusTexts = [
                        'Инициализация...',
                        'Подключение к серверу...',
                        'Загрузка модулей...',
                        'Настройка параметров...',
                        'Финальная подготовка...'
                    ];
                    
                    let tipIndex = 0;
                    const tipsElement = document.getElementById('loading-tips');
                    const statusElement = document.getElementById('loading-status');
                    
                    setInterval(() => {
                        tipIndex = (tipIndex + 1) % tips.length;
                        tipsElement.style.opacity = '0';
                        setTimeout(() => {
                            tipsElement.textContent = tips[tipIndex];
                            tipsElement.style.opacity = '1';
                        }, 300);
                        
                        if (statusElement) {
                            statusElement.textContent = statusTexts[tipIndex];
                        }
                    }, 1500);
                </script>
            </body>
            </html>
        `;
    }

    getDebugIndicatorStyles(): string {
        // Это CSS стили из метода injectDebugOverlay (ШАГ 1)
        return `
            @keyframes pulse {
                0% { opacity: 1; }
                50% { opacity: 0.5; }
                100% { opacity: 1; }
            }
            @keyframes slideIn {
                from { transform: translateX(-100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(-100%); opacity: 0; }
            }
            #quality-preset option {
                background: #222;
                color: white;
            }
            input[type="number"]::-webkit-inner-spin-button,
            input[type="number"]::-webkit-outer-spin-button {
                opacity: 1;
                height: 20px;
            }
            #apply-custom:hover {
                background: #45a049 !important;
            }
            #quality-toggle:hover {
                color: rgba(255,255,255,1) !important;
            }
            .status-badge {
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: bold;
                color: white;
                margin-left: 8px;
            }
            .native-mode { background: #4CAF50; }
            .standard-mode { background: #FF9800; }
            .error-mode { background: #f44336; }
            #native-audio-toggle {
                width: 16px;
                height: 16px;
                position: relative;
                -webkit-appearance: none;
                appearance: none;
                background: rgba(255,255,255,0.2);
                border-radius: 3px;
                outline: none;
                cursor: pointer;
                transition: background 0.3s;
            }
            
            #native-audio-toggle:checked {
                background: #4CAF50;
            }
            
            #native-audio-toggle:checked::after {
                content: '✓';
                position: absolute;
                color: white;
                font-size: 12px;
                top: -2px;
                left: 2px;
            }
            
            #native-audio-toggle:hover {
                background: rgba(255,255,255,0.3);
            }
            
            #native-audio-toggle:checked:hover {
                background: #45a049;
            }
        `;
    }
}