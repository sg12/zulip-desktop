// jitsi-window-utils.ts
import { BrowserWindow, webContents } from "electron";
import log from "electron-log";

export class JitsiWindowUtils {
    public static async leaveConference(window: BrowserWindow): Promise<boolean> {
        if (!window || window.isDestroyed()) {
            return false;
        }
        
        try {
            const result = await window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[JitsiManager] Attempting to leave conference...');
                    
                    if (window.jitsiNativeMediaStream) {
                        window.jitsiNativeMediaStream.getTracks().forEach(track => {
                            track.stop();
                            console.log('[JitsiManager] Stopped track:', track.kind);
                        });
                    }
                    
                    if (window.APP && window.APP.conference) {
                        if (window.APP.conference.hangup) {
                            window.APP.conference.hangup(true);
                            console.log('[JitsiManager] Called hangup()');
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            return true;
                        }
                        
                        if (window.APP.conference._room && window.APP.conference._room.leave) {
                            await window.APP.conference._room.leave();
                            console.log('[JitsiManager] Called room.leave()');
                            return true;
                        }
                    }
                    
                    return false;
                })();
            `);
            
            return result;
            
        } catch (error: any) {
            log.error(`[JitsiManager] Error leaving conference: ${error.message}`);
            return false;
        }
    }

    public static async forceReleaseAllMediaResources(window: BrowserWindow): Promise<void> {
        if (!window || window.isDestroyed()) return;
        
        try {
            const cdp = window.webContents.debugger;
            
            try {
                if (!cdp.isAttached()) {
                    await cdp.attach('1.3');
                }
                
                await cdp.sendCommand('Page.stopScreencast');
                await cdp.sendCommand('Browser.resetPermissions');
                
                await cdp.detach();
            } catch (cdpError) {
                log.warn(`[JITSI-NATIVE-MANAGER] CDP cleanup error: ${cdpError}`);
            }
            
            await window.webContents.executeJavaScript(`
                if (typeof gc !== 'undefined') {
                    gc();
                    gc();
                }
            `);
            
            const session = window.webContents.session;
            await session.clearCache();
            
            log.info("[JITSI-NATIVE-MANAGER] Forced release of all media resources");
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Error releasing media resources: ${error.message}`);
        }
    }

    public static async nukeClearAllStreams(window: BrowserWindow): Promise<void> {
        if (!window || window.isDestroyed()) return;
        
        try {
            await window.webContents.executeJavaScript(`
                (function() {
                    console.log('[NUKE] === SELECTIVE CLEANUP STARTING ===');
                    window.__interceptorFlag = false;

                    if (window.jitsiNativeMediaStream) {
                        window.jitsiNativeMediaStream.getTracks().forEach(track => {
                            if (track.readyState === 'live') {
                                track.stop();
                                console.log('[NUKE] Stopped native track:', track.id, track.kind);
                            }
                        });
                        window.jitsiNativeMediaStream = null;
                    }
                    
                    if (window.APP?.conference) {
                        const tracks = window.APP.conference.getLocalTracks?.() || [];
                        tracks.forEach(t => {
                            if (t.videoType === 'desktop' || t.type === 'desktop') {
                                if (t.dispose) t.dispose();
                                console.log('[NUKE] Disposed desktop track');
                            }
                        });
                    }
                    
                    console.log('[NUKE] === SELECTIVE CLEANUP COMPLETED ===');
                })();
            `);
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Selective clear error: ${error.message}`);
        }
    }
}