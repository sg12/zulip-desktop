// jitsi-screen-share-monitor.ts
import log from "electron-log";

export class JitsiScreenShareMonitor {
    private monitoringCode = `
    (function() {
        // Предотвращаем повторную инициализацию
        if (window.__screenShareMonitor) {
            console.log('[ScreenShareMonitor] Already initialized');
            return;
        }

        console.log('[ScreenShareMonitor] Initializing comprehensive monitoring...');
        
        window.__screenShareMonitor = {
            isSharing: false,
            lastCheckTime: Date.now(),
            checkInterval: null,
            mutationObserver: null,
            originalFunctions: {},
            stopCallbacks: new Set(),
            startCallbacks: new Set()
        };

        const monitor = window.__screenShareMonitor;

        // ===== МЕТОД 1: Перехват Redux Actions =====
        function interceptReduxStore() {
            if (!window.APP?.store) {
                console.log('[ScreenShareMonitor] Redux store not ready');
                return false;
            }

            const originalDispatch = window.APP.store.dispatch;
            window.APP.store.dispatch = function(action) {
                // Логируем все экшены связанные с screen sharing
                if (action.type && (
                    action.type.includes('SCREEN') ||
                    action.type.includes('DESKTOP') ||
                    action.type === 'TOGGLE_SCREENSHARING' ||
                    action.type === 'SET_SCREENSHARING' ||
                    action.type === 'TRACK_REMOVED' ||
                    action.type === 'TRACK_ADDED'
                )) {
                    console.log('[ScreenShareMonitor] Redux action:', action.type, action);
                    
                    // Проверяем состояние после диспатча
                    setTimeout(() => {
                        checkScreenShareState('redux-action');
                    }, 100);
                }
                
                return originalDispatch.call(this, action);
            };
            
            console.log('[ScreenShareMonitor] Redux store intercepted');
            return true;
        }

        // ===== МЕТОД 2: Мониторинг DOM кнопки =====
        function monitorScreenShareButton() {
            if (monitor.mutationObserver) {
                monitor.mutationObserver.disconnect();
            }

            monitor.mutationObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes') {
                        const target = mutation.target;
                        
                        // Проверяем кнопку демонстрации экрана
                        if (target.matches && (
                            target.matches('[aria-label*="screen" i]') ||
                            target.matches('[aria-label*="share" i]') ||
                            target.matches('[aria-label*="desktop" i]') ||
                            target.matches('.toolbox-button')
                        )) {
                            const wasPressed = mutation.oldValue?.includes('true');
                            const isPressed = target.getAttribute('aria-pressed') === 'true';
                            
                            if (wasPressed !== isPressed) {
                                console.log('[ScreenShareMonitor] Button state changed:', 
                                    wasPressed, '->', isPressed);
                                
                                if (wasPressed && !isPressed) {
                                    // Остановка демонстрации
                                    handleScreenShareStopped('button-change');
                                } else if (!wasPressed && isPressed) {
                                    // Начало демонстрации  
                                    handleScreenShareStarted('button-change');
                                }
                            }
                        }
                    }
                    
                    // Также отслеживаем изменения классов
                    if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                        const target = mutation.target;
                        if (target.classList && (
                            target.classList.contains('toolbox-button') ||
                            target.querySelector?.('[aria-label*="screen" i]')
                        )) {
                            const wasToggled = mutation.oldValue?.includes('toggled');
                            const isToggled = target.classList.contains('toggled');
                            
                            if (wasToggled !== isToggled) {
                                console.log('[ScreenShareMonitor] Button toggled:', 
                                    wasToggled, '->', isToggled);
                                    
                                if (wasToggled && !isToggled) {
                                    handleScreenShareStopped('button-toggle');
                                }
                            }
                        }
                    }
                });
            });

            // Наблюдаем за всем документом
            monitor.mutationObserver.observe(document.body, {
                attributes: true,
                attributeOldValue: true,
                subtree: true,
                attributeFilter: ['aria-pressed', 'class', 'aria-label']
            });
            
            console.log('[ScreenShareMonitor] DOM monitoring started');
        }

        // ===== МЕТОД 3: Перехват конференции API =====
        function interceptConferenceAPI() {
            if (!window.APP?.conference) {
                console.log('[ScreenShareMonitor] Conference not ready');
                return false;
            }

            // Перехватываем toggleScreenSharing
            if (!monitor.originalFunctions.toggleScreenSharing) {
                monitor.originalFunctions.toggleScreenSharing = 
                    window.APP.conference.toggleScreenSharing;
                    
                window.APP.conference.toggleScreenSharing = async function(...args) {
                    const wasSharing = window.APP.conference.isSharingScreen?.() || false;
                    console.log('[ScreenShareMonitor] toggleScreenSharing called, was sharing:', wasSharing);
                    
                    // Вызываем оригинальную функцию
                    const result = await monitor.originalFunctions.toggleScreenSharing.apply(this, args);
                    
                    // Проверяем новое состояние
                    setTimeout(() => {
                        const isSharing = window.APP.conference.isSharingScreen?.() || false;
                        console.log('[ScreenShareMonitor] After toggle, is sharing:', isSharing);
                        
                        if (wasSharing && !isSharing) {
                            handleScreenShareStopped('toggle-api');
                        } else if (!wasSharing && isSharing) {
                            handleScreenShareStarted('toggle-api');
                        }
                    }, 500);
                    
                    return result;
                };
            }

            // Перехватываем stopScreenSharing если есть
            if (window.APP.conference.stopScreenSharing && 
                !monitor.originalFunctions.stopScreenSharing) {
                monitor.originalFunctions.stopScreenSharing = 
                    window.APP.conference.stopScreenSharing;
                    
                window.APP.conference.stopScreenSharing = async function(...args) {
                    console.log('[ScreenShareMonitor] stopScreenSharing called');
                    const result = await monitor.originalFunctions.stopScreenSharing.apply(this, args);
                    handleScreenShareStopped('stop-api');
                    return result;
                };
            }

            console.log('[ScreenShareMonitor] Conference API intercepted');
            return true;
        }

        // ===== МЕТОД 4: Мониторинг треков =====
        function monitorTracks() {
            if (!window.APP?.conference?.room) {
                return;
            }

            const room = window.APP.conference.room;
            
            // Слушаем события удаления треков
            if (room.on && !room.__trackMonitoringEnabled) {
                room.__trackMonitoringEnabled = true;
                
                room.on('track.removed', (track) => {
                    if (track && track.isLocal() && track.getVideoType() === 'desktop') {
                        console.log('[ScreenShareMonitor] Desktop track removed');
                        handleScreenShareStopped('track-removed');
                    }
                });
                
                room.on('track.added', (track) => {
                    if (track && track.isLocal() && track.getVideoType() === 'desktop') {
                        console.log('[ScreenShareMonitor] Desktop track added');
                        handleScreenShareStarted('track-added');
                    }
                });
                
                console.log('[ScreenShareMonitor] Track monitoring enabled');
            }
        }

        // ===== МЕТОД 5: Периодическая проверка состояния =====
        function startPolling() {
            if (monitor.checkInterval) {
                clearInterval(monitor.checkInterval);
            }

            monitor.checkInterval = setInterval(() => {
                checkScreenShareState('polling');
            }, 250);
            
            console.log('[ScreenShareMonitor] Polling started');
        }

        // ===== Основная функция проверки состояния =====
        function checkScreenShareState(source) {
            try {
                let isCurrentlySharing = false;
                
                // Способ 1: Через APP.conference
                if (window.APP?.conference?.isSharingScreen) {
                    isCurrentlySharing = window.APP.conference.isSharingScreen();
                }
                
                // Способ 2: Через Redux store
                if (!isCurrentlySharing && window.APP?.store) {
                    const state = window.APP.store.getState();
                    const tracks = state['features/base/tracks'];
                    if (tracks) {
                        isCurrentlySharing = tracks.some(track => 
                            track.local && track.videoType === 'desktop'
                        );
                    }
                }
                
                // Способ 3: Через JitsiConference
                if (!isCurrentlySharing && window.APP?.conference?.room) {
                    const localTracks = window.APP.conference.room.getLocalTracks();
                    isCurrentlySharing = localTracks.some(track => 
                        track.getVideoType && track.getVideoType() === 'desktop'
                    );
                }
                
                // Детектируем изменение состояния
                if (monitor.isSharing !== isCurrentlySharing) {
                    console.log('[ScreenShareMonitor] State changed:', 
                        monitor.isSharing, '->', isCurrentlySharing, 
                        'detected by:', source);
                    
                    monitor.isSharing = isCurrentlySharing;
                    
                    if (!isCurrentlySharing) {
                        handleScreenShareStopped(source);
                    } else {
                        handleScreenShareStarted(source);
                    }
                }
                
            } catch (error) {
                console.error('[ScreenShareMonitor] Error checking state:', error);
            }
        }

        // ===== Обработчики событий =====
        function handleScreenShareStarted(source) {
            console.log('[ScreenShareMonitor] 🟢 SCREEN SHARE STARTED, source:', source);
            monitor.isSharing = true;
            
            // Вызываем все коллбэки
            monitor.startCallbacks.forEach(callback => {
                try {
                    callback(source);
                } catch (e) {
                    console.error('[ScreenShareMonitor] Start callback error:', e);
                }
            });
        }

        function handleScreenShareStopped(source) {
            console.log('[ScreenShareMonitor] 🔴 SCREEN SHARE STOPPED, source:', source);
            monitor.isSharing = false;
            
            // КРИТИЧНО: Останавливаем Native capture
            stopNativeCapture(source);
            
            // Вызываем все коллбэки
            monitor.stopCallbacks.forEach(callback => {
                try {
                    callback(source);
                } catch (e) {
                    console.error('[ScreenShareMonitor] Stop callback error:', e);
                }
            });
        }

        // ===== Остановка Native Capture =====
        async function stopNativeCapture(source) {
            console.log('[ScreenShareMonitor] 🛑 Stopping native capture, triggered by:', source);
            
            try {
                // Останавливаем все треки
                if (window.jitsiNativeMediaStream) {
                    window.jitsiNativeMediaStream.getTracks().forEach(track => {
                        track.stop();
                    });
                    window.jitsiNativeMediaStream = null;
                }
                
                if (window.electronVideoStream) {
                    window.electronVideoStream.getTracks().forEach(track => {
                        track.stop();
                    });
                    window.electronVideoStream = null;
                }
                
                // Закрываем audio context
                if (window.nativeAudioContext && window.nativeAudioContext.state !== 'closed') {
                    await window.nativeAudioContext.close();
                    window.nativeAudioContext = null;
                }
                
                // Сбрасываем флаги
                window.isNativeActive = false;
                window.isHybridMode = false;
                
                // Вызываем остановку в main процессе
                if (window.ipcRenderer) {
                    console.log('[ScreenShareMonitor] Calling jitsi:stop-native-capture...');
                    const result = await window.ipcRenderer.invoke('jitsi:stop-native-capture');
                    console.log('[ScreenShareMonitor] Stop result:', result);
                }
                
            } catch (error) {
                console.error('[ScreenShareMonitor] Error stopping native capture:', error);
            }
        }

        // ===== API для добавления коллбэков =====
        window.__screenShareMonitor.onStop = function(callback) {
            monitor.stopCallbacks.add(callback);
        };
        
        window.__screenShareMonitor.onStart = function(callback) {
            monitor.startCallbacks.add(callback);
        };

        // ===== Инициализация всех методов =====
        function initializeAllMethods() {
            let attempts = 0;
            const maxAttempts = 30;
            
            const initInterval = setInterval(() => {
                attempts++;
                
                const reduxReady = interceptReduxStore();
                const conferenceReady = interceptConferenceAPI();
                
                if (reduxReady && conferenceReady) {
                    clearInterval(initInterval);
                    
                    // Запускаем все мониторы
                    monitorScreenShareButton();
                    monitorTracks();
                    startPolling();
                    
                    // Начальная проверка
                    checkScreenShareState('initial');
                    
                    console.log('[ScreenShareMonitor] ✅ All monitoring methods initialized');
                    
                } else if (attempts >= maxAttempts) {
                    clearInterval(initInterval);
                    console.warn('[ScreenShareMonitor] Some methods failed to initialize');
                    
                    // Запускаем что можем
                    monitorScreenShareButton();
                    startPolling();
                }
            }, 500);
        }

        // Запускаем инициализацию
        initializeAllMethods();
        
        console.log('[ScreenShareMonitor] ✅ Monitor script injected');
        
        return true;
    })();
    `;

    async injectMonitor(window: any): Promise<boolean> {
        if (!window || window.isDestroyed()) {
            log.error("[ScreenShareMonitor] No window to inject into");
            return false;
        }

        try {
            const result = await window.webContents.executeJavaScript(this.monitoringCode);
            log.info("[ScreenShareMonitor] Monitor injected successfully");
            return result;
        } catch (error: any) {
            log.error(`[ScreenShareMonitor] Injection failed: ${error.message}`);
            return false;
        }
    }

    // Добавить дополнительный коллбэк для остановки
    async addStopCallback(window: any, callback: string): Promise<void> {
        if (!window || window.isDestroyed()) return;

        await window.webContents.executeJavaScript(`
            if (window.__screenShareMonitor) {
                window.__screenShareMonitor.onStop(${callback});
            }
        `);
    }
}