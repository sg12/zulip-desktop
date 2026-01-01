import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioSessionService } from '../audioSessionService.js';
import { SVVLocator } from '../svvLocator.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Моки
vi.mock('../svvLocator.js', () => ({
  SVVLocator: vi.fn().mockImplementation(() => ({
    findSVV: vi.fn().mockResolvedValue('/path/to/SoundVolumeView.exe'),
    isReady: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('AudioSessionService', () => {
  let service: AudioSessionService;
  const mockExecFile = execFile as any;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AudioSessionService();
  });

  describe('parseCSV', () => {
    it('должен правильно парсить CSV с аудио сессиями', () => {
      const csv = `Name,Type,Direction,Process ID,Process Path,Volume Percent,Muted,Device Name
Spotify,Application,Render,1234,C:\\Program Files\\Spotify\\spotify.exe,80,No,Speakers
Chrome,Application,Render,5678,C:\\Program Files\\Chrome\\chrome.exe,50,No,Speakers`;

      // Используем приватный метод через рефлексию
      const sessions = (service as any).parseCSV(csv);

      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({
        processId: 1234,
        processName: 'spotify.exe',
        displayName: 'Spotify',
        processPath: 'C:\\Program Files\\Spotify\\spotify.exe',
        volume: 80,
        muted: false,
      });
    });

    it('должен фильтровать только Application Render сессии', () => {
      const csv = `Name,Type,Direction,Process ID,Process Path,Volume Percent,Muted,Device Name
Spotify,Application,Render,1234,C:\\spotify.exe,80,No,Speakers
Microphone,Device,Capture,0,,100,No,Microphone
System,Device,Render,0,,100,No,Speakers`;

      const sessions = (service as any).parseCSV(csv);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].processName).toBe('spotify.exe');
    });

    it('должен обрабатывать пустой CSV', () => {
      const csv = `Name,Type,Direction,Process ID,Process Path,Volume Percent,Muted,Device Name`;

      const sessions = (service as any).parseCSV(csv);

      expect(sessions).toHaveLength(0);
    });
  });

  describe('extractProcessName', () => {
    it('должен извлекать имя процесса из пути', () => {
      const processPath = 'C:\\Program Files\\Game\\game.exe';
      const processName = (service as any).extractProcessName(processPath);

      expect(processName).toBe('game.exe');
    });

    it('должен обрабатывать пути с обратными слешами', () => {
      const processPath = 'C:/Program Files/Game/game.exe';
      const processName = (service as any).extractProcessName(processPath);

      expect(processName).toBe('game.exe');
    });
  });

  describe('getDisplayName', () => {
    it('должен использовать словарь известных приложений', () => {
      const displayName = (service as any).getDisplayName('cs2.exe', '');
      expect(displayName).toBe('Counter-Strike 2');
    });

    it('должен использовать имя сессии если доступно', () => {
      const displayName = (service as any).getDisplayName('unknown.exe', 'My Game');
      expect(displayName).toBe('My Game');
    });

    it('должен capitalize имя процесса как fallback', () => {
      const displayName = (service as any).getDisplayName('mygame.exe', '');
      expect(displayName).toBe('Mygame');
    });
  });

  describe('getAudioSessions', () => {
    it('должен возвращать список сессий', async () => {
      const mockCSV = `Name,Type,Direction,Process ID,Process Path,Volume Percent,Muted,Device Name
Game,Application,Render,1234,C:\\game.exe,100,No,Speakers`;

      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        callback(null, { stdout: mockCSV });
      });

      // Мокаем execFileAsync
      vi.spyOn(require('node:util'), 'promisify').mockReturnValue(
        async () => ({ stdout: mockCSV })
      );

      const sessions = await service.getAudioSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].processName).toBe('game.exe');
    });

    it('должен выбрасывать ошибку если SoundVolumeView не найден', async () => {
      const mockLocator = service['svvLocator'] as any;
      mockLocator.findSVV.mockResolvedValue(null);

      await expect(service.getAudioSessions()).rejects.toThrow('SoundVolumeView not found');
    });
  });

  describe('setAppAudioDevice', () => {
    it('должен перенаправлять звук приложения', async () => {
      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        callback(null, { stdout: '' });
      });

      vi.spyOn(require('node:util'), 'promisify').mockReturnValue(
        async () => ({ stdout: '' })
      );

      const result = await service.setAppAudioDevice('game.exe', 'CABLE Input');

      expect(result).toBe(true);
    });

    it('должен выбрасывать ошибку при неудаче', async () => {
      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        callback(new Error('Failed'), null);
      });

      vi.spyOn(require('node:util'), 'promisify').mockReturnValue(
        async () => { throw new Error('Failed'); }
      );

      await expect(
        service.setAppAudioDevice('game.exe', 'CABLE Input')
      ).rejects.toThrow();
    });
  });

  describe('hasVBCable', () => {
    it('должен возвращать true если VB-Cable найден', async () => {
      const mockCSV = `Name,Type,Direction
CABLE Input,Device,Render
Speakers,Device,Render`;

      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        callback(null, { stdout: mockCSV });
      });

      vi.spyOn(require('node:util'), 'promisify').mockReturnValue(
        async () => ({ stdout: mockCSV })
      );

      const hasVC = await service.hasVBCable();

      expect(hasVC).toBe(true);
    });

    it('должен возвращать false если VB-Cable не найден', async () => {
      const mockCSV = `Name,Type,Direction
Speakers,Device,Render`;

      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        callback(null, { stdout: mockCSV });
      });

      vi.spyOn(require('node:util'), 'promisify').mockReturnValue(
        async () => ({ stdout: mockCSV })
      );

      const hasVC = await service.hasVBCable();

      expect(hasVC).toBe(false);
    });
  });
});

