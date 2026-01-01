import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain } from 'electron/main';
import { registerAudioHandlers } from '../audioHandlers.js';
import { AudioSessionService } from '../../services/audioSessionService.js';
import { SVVLocator } from '../../services/svvLocator.js';

// Моки
vi.mock('electron/main', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../services/audioSessionService.js', () => ({
  AudioSessionService: vi.fn().mockImplementation(() => ({
    isReady: vi.fn().mockResolvedValue(true),
    getAudioSessions: vi.fn().mockResolvedValue([
      {
        processId: 1234,
        processName: 'game.exe',
        displayName: 'Game',
        processPath: 'C:\\game.exe',
        volume: 100,
        muted: false,
      },
    ]),
    getAudioDevices: vi.fn().mockResolvedValue([
      { name: 'CABLE Input', id: 'cable-input', isDefault: false },
      { name: 'Speakers', id: 'speakers', isDefault: true },
    ]),
    getVBCableDeviceName: vi.fn().mockResolvedValue('CABLE Input'),
    setAppAudioDevice: vi.fn().mockResolvedValue(true),
    restoreDefaultDevice: vi.fn().mockResolvedValue(true),
    hasVBCable: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock('../../services/svvLocator.js', () => ({
  SVVLocator: vi.fn().mockImplementation(() => ({
    setManualPath: vi.fn().mockResolvedValue(true),
    getCurrentPath: vi.fn().mockReturnValue('/path/to/SoundVolumeView.exe'),
  })),
}));

describe('AudioHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('должен зарегистрировать все IPC обработчики', () => {
    registerAudioHandlers();

    expect(ipcMain.handle).toHaveBeenCalledWith('audio:checkReady', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('audio:getSessions', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('audio:getDevices', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('audio:routeToCable', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('audio:restoreDefault', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('audio:setManualPath', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('audio:hasVBCable', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('audio:getSVVPath', expect.any(Function));
  });

  it('должен обработать audio:checkReady', async () => {
    registerAudioHandlers();
    
    const handler = (ipcMain.handle as any).mock.calls.find(
      (call: any[]) => call[0] === 'audio:checkReady'
    )?.[1];

    const result = await handler();

    expect(result).toEqual({ success: true, isReady: true });
  });

  it('должен обработать audio:getSessions', async () => {
    registerAudioHandlers();
    
    const handler = (ipcMain.handle as any).mock.calls.find(
      (call: any[]) => call[0] === 'audio:getSessions'
    )?.[1];

    const result = await handler();

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].processName).toBe('game.exe');
  });

  it('должен обработать audio:routeToCable', async () => {
    registerAudioHandlers();
    
    const handler = (ipcMain.handle as any).mock.calls.find(
      (call: any[]) => call[0] === 'audio:routeToCable'
    )?.[1];

    const result = await handler(null, 'game.exe');

    expect(result.success).toBe(true);
    expect(result.deviceName).toBe('CABLE Input');
  });

  it('должен обработать ошибки в обработчиках', async () => {
    // Мокаем сервис чтобы он выбрасывал ошибку при создании
    const originalGetAudioSessions = AudioSessionService.prototype.getAudioSessions;
    AudioSessionService.prototype.getAudioSessions = vi.fn().mockRejectedValue(
      new Error('Test error')
    );

    registerAudioHandlers();
    
    const handler = (ipcMain.handle as any).mock.calls.find(
      (call: any[]) => call[0] === 'audio:getSessions'
    )?.[1];

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    
    // Восстанавливаем
    AudioSessionService.prototype.getAudioSessions = originalGetAudioSessions;
  });
});

