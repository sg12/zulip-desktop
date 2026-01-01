// electron-custom-source-picker.ts - Модуль для отображения диалога выбора источника экрана
import log from "electron-log";

export interface SourcePickerOptions {
    sources: Array<{
        id: string;
        name: string;
        thumbnail?: string;
        display_id?: string;
    }>;
    onSelect: (sourceId: string | null) => void;
}

/**
 * Показывает кастомный диалог выбора источника экрана
 * ВНИМАНИЕ: Этот код выполняется в контексте Jitsi окна через executeJavaScript
 */
export function getSourcePickerCode(): string {
    return `
        function showSourcePicker(sources, callback) {
            requestAnimationFrame(() => {
                const existing = document.getElementById('source-picker-overlay');
                if (existing) existing.remove();
                
                const overlay = document.createElement('div');
                overlay.id = 'source-picker-overlay';
                overlay.style.cssText = \`
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0);
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    backdrop-filter: blur(0px);
                    transition: background 0.2s, backdrop-filter 0.2s;
                \`;
                
                const dialog = document.createElement('div');
                dialog.style.cssText = \`
                    background: white;
                    border-radius: 16px;
                    padding: 32px;
                    max-width: 90%;
                    max-height: 80%;
                    overflow: auto;
                    min-width: 700px;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                    transform: scale(0.9);
                    opacity: 0;
                    transition: transform 0.2s, opacity 0.2s;
                \`;
                
                const fragment = document.createDocumentFragment();
                
                const header = document.createElement('h2');
                header.style.cssText = 'margin-top: 0; color: #333; font-size: 24px;';
                header.textContent = 'Выберите экран или окно для демонстрации';
                fragment.appendChild(header);

                // 🔘 ДОБАВЛЕН ЧЕКБОКС ДЛЯ ВИРТУАЛЬНОГО КАБЕЛЯ
                const vcOption = document.createElement('label');
                vcOption.style.cssText = \`
                    display: flex;
                    align-items: center;
                    margin: 16px 0;
                    font-size: 14px;
                    color: #555;
                \`;
                const vcCheckbox = document.createElement('input');
                vcCheckbox.type = 'checkbox';
                vcCheckbox.id = 'use-virtual-cable';
                vcCheckbox.style.cssText = 'margin-right: 10px; transform: scale(1.2);';
                const vcLabel = document.createElement('span');
                vcLabel.textContent = 'Использовать виртуальный кабель для звука (VB-Cable / VoiceMeeter)';
                vcOption.appendChild(vcCheckbox);
                vcOption.appendChild(vcLabel);
                fragment.appendChild(vcOption);

                const vcHelp = document.createElement('div');
                vcHelp.style.cssText = 'font-size: 12px; color: #888; margin-top: 4px; line-height: 1.4;';
                vcHelp.innerHTML = 'Требуется установка <a href="https://www.vb-audio.com/Cable/" target="_blank" style="color:#2196F3;">VB-Cable</a> и настройка перенаправления звука приложения.';
                vcHelp.querySelector('a').onclick = (e) => {
                    e.stopPropagation();
                    window.open('https://www.vb-audio.com/Cable/', '_blank');
                };
                fragment.appendChild(vcHelp);
                
                const grid = document.createElement('div');
                grid.style.cssText = \`
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                    gap: 20px;
                    margin: 24px 0;
                \`;
                
                sources.forEach(source => {
                    const item = document.createElement('div');
                    item.className = 'source-item';
                    item.dataset.sourceId = source.id;
                    item.style.cssText = \`
                        border: 3px solid #e0e0e0;
                        border-radius: 12px;
                        padding: 16px;
                        cursor: pointer;
                        text-align: center;
                        background: white;
                        transition: border-color 0.15s, transform 0.15s;
                    \`;
                    
                    const img = document.createElement('img');
                    img.src = source.thumbnail || '';
                    img.style.cssText = \`
                        width: 100%;
                        height: 160px;
                        object-fit: contain;
                        margin-bottom: 12px;
                        border-radius: 8px;
                        background: #f5f5f5;
                    \`;
                    
                    const name = document.createElement('div');
                    name.style.cssText = \`
                        font-size: 14px;
                        color: #666;
                        word-wrap: break-word;
                        font-weight: 500;
                    \`;
                    name.textContent = source.name || 'Unknown';
                    
                    item.appendChild(img);
                    item.appendChild(name);
                    
                    item.onmouseenter = () => {
                        item.style.borderColor = '#2196F3';
                        item.style.transform = 'scale(1.05)';
                    };
                    item.onmouseleave = () => {
                        item.style.borderColor = '#e0e0e0';
                        item.style.transform = 'scale(1)';
                    };
                    
                    item.onclick = () => {
                        const useVC = document.getElementById('use-virtual-cable').checked;
                        overlay.style.background = 'rgba(0, 0, 0, 0)';
                        dialog.style.transform = 'scale(0.9)';
                        dialog.style.opacity = '0';
                        setTimeout(() => {
                            overlay.remove();
                            // Передаём ОБЪЕКТ: sourceId + sourceName + флаг режима
                            callback({ sourceId: source.id, sourceName: source.name, useVirtualCable: useVC });
                        }, 200);
                    };
                    
                    grid.appendChild(item);
                });
                
                fragment.appendChild(grid);
                
                const cancelButton = document.createElement('button');
                cancelButton.textContent = 'Отмена';
                cancelButton.style.cssText = \`
                    display: block;
                    margin: 24px auto 0;
                    background: #f44336;
                    color: white;
                    border: none;
                    padding: 12px 32px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: 500;
                    transition: background 0.15s;
                \`;
                
                cancelButton.onclick = () => {
                    overlay.style.background = 'rgba(0, 0, 0, 0)';
                    dialog.style.transform = 'scale(0.9)';
                    dialog.style.opacity = '0';
                    setTimeout(() => {
                        overlay.remove();
                        callback(null);
                    }, 200);
                };
                
                fragment.appendChild(cancelButton);
                
                dialog.appendChild(fragment);
                overlay.appendChild(dialog);
                document.body.appendChild(overlay);
                
                requestAnimationFrame(() => {
                    overlay.style.background = 'rgba(0, 0, 0, 0.85)';
                    overlay.style.backdropFilter = 'blur(5px)';
                    dialog.style.transform = 'scale(1)';
                    dialog.style.opacity = '1';
                });
            });
        }
    `;
}

/**
 * Возвращает код для инжекции функции выбора источника в окно
 * Этот код включает саму функцию showSourcePicker
 */
export function injectSourcePickerFunction(): string {
    return `
        (function() {
            if (!window.showSourcePicker) {
                ${getSourcePickerCode()}
                console.log('[SourcePicker] Function injected successfully');
            }
        })();
    `;
}

/**
 * Возвращает упрощенный код перехватчика screen share для нативного режима
 * ВАЖНО: Этот код инжектируется в Jitsi окно и перехватывает вызовы демонстрации экрана
 */
export function getSimplifiedScreenShareInterceptorCode(): string {
    // Импортируем функцию выбора источника
    const sourcePickerCode = getSourcePickerCode();
    
    return `
        (function() {
            console.log('[JitsiManager] Installing simplified screen share interceptor...');
            
            window.__interceptorFlag = window.__interceptorFlag || false;
            let pendingSourcesCallback = null;
            
            // Предзагрузка источников
            let cachedSources = null;
            let cacheTime = 0;
            const CACHE_DURATION = 5000;
            
            async function getElectronSourcesWithCache() {
                const now = Date.now();
                if (cachedSources && (now - cacheTime) < CACHE_DURATION) {
                    console.log('[JitsiManager] Using cached sources');
                    return cachedSources;
                }
                
                if (window.ipcRenderer) {
                    cachedSources = await window.ipcRenderer.invoke('get-electron-desktop-sources');
                    cacheTime = now;
                    return cachedSources;
                }
                return [];
            }
            
            // Предзагружаем источники
            setTimeout(() => {
                getElectronSourcesWithCache().then(sources => {
                    console.log('[JitsiManager] Preloaded', sources.length, 'sources');
                });
            }, 1000);
            
            // Инжектируем функцию показа выбора источника из модуля
            ${sourcePickerCode}

            // Мониторинг состояния
            setInterval(() => {
                if (window.__interceptorFlag === true) {
                    return;
                }
                
                if (window.isScreenShareActive) {
                    let isStillSharing = false;
                    try {
                        if (window.APP?.conference?.getLocalTracks) {
                            const tracks = window.APP.conference.getLocalTracks();
                            isStillSharing = tracks.some(track => track.videoType === 'desktop');
                        }
                    } catch (e) {}
                    
                    const hasLiveStream = window.jitsiNativeMediaStream && 
                                        window.jitsiNativeMediaStream.getTracks().some(t => t.readyState === 'live');
                    
                    if (!isStillSharing && !hasLiveStream) {
                        console.log('[Monitor] Auto-cleanup: no active desktop track or stream');
                        
                        window.isScreenShareActive = false;
                        window.isNativeActive = false;
                        window.__interceptorFlag = false;
                        
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                track.stop();
                            });
                            window.jitsiNativeMediaStream = null;
                        }
                    }
                }
            }, 3000);
            
            // Ждем загрузки Jitsi API
            function waitForJitsiAPI() {
                return new Promise((resolve) => {
                    if (window.JitsiMeetScreenObtainer?.openDesktopPicker) {
                        resolve(true);
                        return;
                    }
                    
                    let attempts = 0;
                    const checkInterval = setInterval(() => {
                        attempts++;
                        if (window.JitsiMeetScreenObtainer?.openDesktopPicker) {
                            clearInterval(checkInterval);
                            resolve(true);
                        } else if (attempts > 100) {
                            clearInterval(checkInterval);
                            resolve(false);
                        }
                    }, 50);
                });
            }
            
            waitForJitsiAPI().then(ready => {
                if (!ready) return;
                
                const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                
                window.JitsiMeetScreenObtainer.openDesktopPicker = async function(options, callback) {
                    console.log('[JitsiManager] Desktop picker intercepted - NATIVE MODE ONLY');
                    
                    if (window.__interceptorFlag === true) {
                        console.log('[JitsiManager] Already processing, skipping');
                        return;
                    }
                    
                    // Проверка на активную демонстрацию
                    let isAlreadySharing = false;
                    try {
                        if (window.APP?.conference?.getLocalTracks) {
                            const tracks = window.APP.conference.getLocalTracks();
                            isAlreadySharing = tracks.some(track => track.videoType === 'desktop');
                        }
                    } catch (e) {}
                    
                    if (isAlreadySharing) {
                        console.log('[JitsiManager] Already sharing, stopping first');
                        try {
                            if (window.APP?.conference?.toggleScreenSharing) {
                                await window.APP.conference.toggleScreenSharing();
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                        } catch (e) {
                            console.error('[JitsiManager] Error stopping share:', e);
                        }
                        
                        window.isScreenShareActive = false;
                        window.isNativeActive = false;
                        window.__interceptorFlag = false;
                        
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => track.stop());
                            window.jitsiNativeMediaStream = null;
                        }
                        
                        console.log('[JitsiManager] Previous share stopped');
                        return;
                    }
                    
                    window.__interceptorFlag = true;

                    // Сохраняем микрофон
                    window.__savedMicrophoneTrack = null;
                    try {
                        if (window.APP?.conference?.getLocalTracks) {
                            const tracks = window.APP.conference.getLocalTracks();
                            const micTrack = tracks.find(t => t.type === 'audio' && t.videoType !== 'desktop');
                            if (micTrack) {
                                window.__savedMicrophoneTrack = micTrack;
                                window.__microphoneMuted = micTrack.isMuted();
                                console.log('[JitsiManager] Saved microphone track, muted:', window.__microphoneMuted);
                            }
                        }
                    } catch (e) {
                        console.warn('[JitsiManager] Could not save microphone:', e);
                    }
                    
                    try {
                        // СРАЗУ показываем выбор источников (без выбора режима звука)
                        const sources = await getElectronSourcesWithCache();
                        
                        // Используем импортированную функцию showSourcePicker
                        showSourcePicker(sources, async (result) => {
                            if (!result || !result.sourceId) {
                                window.__interceptorFlag = false;
                                console.log('[JitsiManager] User cancelled source selection');
                                return;
                            }
                            
                            const { sourceId, sourceName, useVirtualCable } = result;
                            
                            try {
                                // 🆕 Передаём режим Virtual Cable в main process
                                await window.ipcRenderer.invoke('jitsi:set-virtual-cable-mode', useVirtualCable);
                                
                                // Сохраняем выбранный источник с именем для маршрутизации аудио
                                await window.ipcRenderer.invoke('jitsi:save-selected-source', sourceId, sourceName);
                                
                                // Создаем нативный поток
                                const streamResult = await window.ipcRenderer.invoke('create-native-stream-for-jitsi');
                                
                                if (!streamResult.success) {
                                    console.error('[JitsiManager] Stream creation failed');
                                    window.__interceptorFlag = false;
                                    return;
                                }
                                
                                // Ждем готовности потока
                                let attempts = 0;
                                const maxAttempts = 50;
                                let streamReady = false;

                                while (attempts < maxAttempts) {
                                    attempts++;
                                    
                                    if (window.jitsiNativeMediaStream && 
                                        window.jitsiNativeMediaStream.getTracks && 
                                        window.jitsiNativeMediaStream.getTracks().length > 0) {
                                        
                                        const tracks = window.jitsiNativeMediaStream.getTracks();
                                        const allTracksLive = tracks.every(t => t.readyState === 'live');
                                        
                                        if (allTracksLive) {
                                            streamReady = true;
                                            console.log('[JitsiManager] Stream ready with', tracks.length, 'tracks');
                                            break;
                                        }
                                    }
                                    
                                    await new Promise(r => setTimeout(r, 50));
                                }
                                
                                if (!streamReady) {
                                    console.error('[JitsiManager] Stream timeout after', attempts, 'attempts');
                                    window.__interceptorFlag = false;
                                    return;
                                }
                                
                                console.log('[JitsiManager] Native stream confirmed ready');
                                window.isScreenShareActive = true;
                                
                                // Вызываем callback
                                if (callback) {
                                    setTimeout(() => {
                                        console.log('[JitsiManager] Calling Jitsi callback');
                                        callback('native:' + sourceId, { 
                                            audio: true, 
                                            screenShareAudio: true 
                                        });
                                        
                                        setTimeout(() => {
                                            window.__interceptorFlag = false;
                                        }, 1000);
                                    }, 100);
                                }
                                
                                // Восстановление микрофона
                                setTimeout(async () => {
                                    window.__interceptorFlag = false;
                                    
                                    try {
                                        const tracks = window.APP.conference.getLocalTracks();
                                        const hasMic = tracks.some(t => 
                                            t.type === 'audio' && 
                                            t.videoType !== 'desktop'
                                        );
                                        
                                        if (!hasMic) {
                                            console.log('[JitsiManager] Microphone missing, creating new...');
                                            
                                            const audioTracks = await window.JitsiMeetJS.createLocalTracks({
                                                devices: ['audio']
                                            });
                                            
                                            if (audioTracks && audioTracks[0]) {
                                                await window.APP.conference.addTrack(audioTracks[0]);
                                                
                                                if (window.__microphoneMuted) {
                                                    await audioTracks[0].mute();
                                                }
                                                
                                                console.log('[JitsiManager] New microphone added');
                                            }
                                        }
                                    } catch (e) {
                                        console.error('[JitsiManager] Error checking/restoring mic:', e);
                                    }
                                    
                                    window.__savedMicrophoneTrack = null;
                                    window.__microphoneMuted = null;
                                }, 3000);
                                
                            } catch (error) {
                                console.error('[JitsiManager] Error in native mode:', error);
                                window.__interceptorFlag = false;
                            }
                        });
                        
                    } catch (error) {
                        console.error('[JitsiManager] Error in picker:', error);
                        window.__interceptorFlag = false;
                    }
                };
            });
            
            return { success: true };
        })();
    `;
}

/**
 * Логирование для отладки
 */
export function logSourcePickerEvent(event: string, data?: any): void {
    log.info(`[ElectronSourcePicker] ${event}`, data ? JSON.stringify(data) : '');
}