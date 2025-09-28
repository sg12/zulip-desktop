// jitsi-url-builder.ts
import { JitsiOptions } from './jitsi-types';

export class JitsiURLBuilder {
    static buildConferenceUrl(
        server: string, 
        roomName: string, 
        options: JitsiOptions
    ): string {
        let url = `${server}/${roomName}`;

        // Query параметры (JWT токен)
        const queryParams = new URLSearchParams();
        if (options.jwt) queryParams.append('jwt', options.jwt);
        
        if (queryParams.toString()) {
            url += '?' + queryParams.toString();
        }

        // Hash параметры для конфигурации
        const hashParams = new URLSearchParams();
        
        // === ОСНОВНЫЕ НАСТРОЙКИ ===
        hashParams.append('config.prejoinPageEnabled', 'false');
        hashParams.append('config.startWithAudioMuted', 'false');
        hashParams.append('config.startWithVideoMuted', 'true');
        
        // === НАСТРОЙКИ ЛОГИРОВАНИЯ ===
        hashParams.append('config.apiLogLevels', JSON.stringify(['error']));
        hashParams.append('config.logging.defaultLogLevel', 'error');
        
        // === НАСТРОЙКИ ВИДЕО И АУДИО ===
        hashParams.append('config.disableSimulcast', 'true');
        hashParams.append('config.disableAudioLevels', 'false');
        hashParams.append('config.stereo', 'false');
        hashParams.append('config.resolution', '720');
        
        // === НАСТРОЙКИ ОБРАБОТКИ АУДИО ===
        hashParams.append('config.echoCancellation', 'true');
        hashParams.append('config.noiseSuppression', 'true');
        hashParams.append('config.highpassFilter', 'true');
        hashParams.append('config.autoGainControl', 'true');
        hashParams.append('config.enableLipSync', 'false');
        
        // === НАСТРОЙКИ ДЕМОНСТРАЦИИ ЭКРАНА ===
        hashParams.append('config.desktopSharingFrameRate.min', '15');
        hashParams.append('config.desktopSharingFrameRate.max', '30');
        
        // Разрешение для демонстрации экрана
        hashParams.append('config.constraints.video.width.min', '480');
        hashParams.append('config.constraints.video.width.ideal', '800');
        hashParams.append('config.constraints.video.width.max', '900');
        hashParams.append('config.constraints.video.height.min', '360');
        hashParams.append('config.constraints.video.height.ideal', '500');
        hashParams.append('config.constraints.video.height.max', '720');
        hashParams.append('config.constraints.video.frameRate.min', '15');
        hashParams.append('config.constraints.video.frameRate.max', '30');
        
        // Настройки для desktop sharing
        hashParams.append('config.desktopSharingConstraints.video.width.min', '360');
        hashParams.append('config.desktopSharingConstraints.video.width.ideal', '800');
        hashParams.append('config.desktopSharingConstraints.video.width.max', '900');
        hashParams.append('config.desktopSharingConstraints.video.height.min', '480');
        hashParams.append('config.desktopSharingConstraints.video.height.ideal', '500');
        hashParams.append('config.desktopSharingConstraints.video.height.max', '800');
        hashParams.append('config.desktopSharingConstraints.video.frameRate.min', '15');
        hashParams.append('config.desktopSharingConstraints.video.frameRate.max', '30');
        
        // === ОТКЛЮЧЕНИЕ ФУНКЦИЙ ИНТЕРФЕЙСА ===
        hashParams.append('config.hideConferenceSubject', 'true');
        hashParams.append('config.deeplinking.disabled', 'true');
        hashParams.append('config.disableRemoteMute', 'true');
        hashParams.append('config.disableKick', 'true');
        hashParams.append('config.disableGrantModerator', 'true');
        hashParams.append('config.disablePrivateChat', 'true');
        hashParams.append('config.disableSelfViewSettings', 'true');
        hashParams.append('config.disableLocalVideoFlip', 'true');
        hashParams.append('config.disableLocalStats', 'true');
        hashParams.append('config.disableAVModeration', 'true');
        hashParams.append('config.disableInviteFunctions', 'true');
        
        // Настройки панели участников
        hashParams.append('config.participantsPane.hideMoreActionsButton', 'true');
        hashParams.append('config.breakoutRooms.hideMoreActionsButton', 'true');
        
        // Настройки filmstrip
        hashParams.append('config.filmstrip.disableStageFilmstrip', 'true');
        hashParams.append('config.filmstrip.disableResizable', 'true');
        
        // === НАСТРОЙКИ ИНТЕРФЕЙСА ===
        hashParams.append('interfaceConfig.DISABLE_VIDEO_BACKGROUND', 'true');
        hashParams.append('interfaceConfig.DISABLE_DOMINANT_SPEAKER_INDICATOR', 'true');
        
        // Кнопки тулбара - только необходимые
        const toolbarButtons = [
            'camera',
            'desktop',
            'microphone', 
            'settings',
            'fullscreen',
            'hangup'
        ];
        hashParams.append('interfaceConfig.TOOLBAR_BUTTONS', JSON.stringify(toolbarButtons));
        
        // === ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ ===
        if (options.displayName) {
            hashParams.append('userInfo.displayName', options.displayName);
        }
        if (options.email) {
            hashParams.append('userInfo.email', options.email);
        }
        if (options.avatarUrl) {
            hashParams.append('userInfo.avatarURL', options.avatarUrl);
        }
        
        // === ИСТОЧНИКИ ДЛЯ ДЕМОНСТРАЦИИ ===
        hashParams.append('config.desktopSharingSources', JSON.stringify(['screen', 'window']));
        
        // === ДОПОЛНИТЕЛЬНЫЕ НАСТРОЙКИ ===
        hashParams.append('config.enableWelcomePage', 'false');
        hashParams.append('config.enableClosePage', 'false');
        hashParams.append('config.fileRecordingsEnabled', 'false');
        hashParams.append('config.liveStreamingEnabled', 'false');
        hashParams.append('config.transcribingEnabled', 'false');
        hashParams.append('config.enableCalendarIntegration', 'false');
        hashParams.append('config.enableNoAudioDetection', 'false');
        hashParams.append('config.enableNoisyMicDetection', 'false');
        hashParams.append('config.enableSaveLogs', 'false');
        hashParams.append('config.disableThirdPartyRequests', 'true');
        hashParams.append('config.p2p.enabled', 'false');
        
        // Добавляем hash параметры к URL
        if (hashParams.toString()) {
            url += '#' + hashParams.toString();
        }

        return url;
    }
}