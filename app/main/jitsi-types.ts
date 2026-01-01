import { BrowserWindow } from "electron";
import { VIDEO_QUALITY_PRESETS } from "./video-quality-manager";

// jitsi-types.ts
export interface JitsiOptions {
    roomName: string;
    serverUrl?: string;
    displayName?: string;
    email?: string;
    avatarUrl?: string;
    jwt?: string;
    topic?: string;
    stream?: string;
}

export interface JitsiState {
    window: BrowserWindow | null;
    isStreamActive: boolean;
    streamId: string | null;
    lastSelectedSourceId?: string;
    lastSelectedSourceName?: string | null; // 🆕 Имя выбранного источника для маршрутизации аудио
    videoFrameCount?: number;
    audioFrameCount?: number;
    qualityPreset?: string;
}

export interface JitsiManagerConfig {
    videoQuality?: keyof typeof VIDEO_QUALITY_PRESETS;
    enableDebugUI?: boolean;
    enablePerformanceMonitoring?: boolean;
    monitoringInterval?: number;
}