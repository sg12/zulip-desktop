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
                        overlay.style.background = 'rgba(0, 0, 0, 0)';
                        dialog.style.transform = 'scale(0.9)';
                        dialog.style.opacity = '0';
                        setTimeout(() => {
                            overlay.remove();
                            callback(source.id);
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
 * Логирование для отладки
 */
export function logSourcePickerEvent(event: string, data?: any): void {
    log.info(`[ElectronSourcePicker] ${event}`, data ? JSON.stringify(data) : '');
}