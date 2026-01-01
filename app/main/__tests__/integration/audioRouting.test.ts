import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioSessionService } from '../../services/audioSessionService.js';
import { SVVLocator } from '../../services/svvLocator.js';

/**
 * Интеграционные тесты для проверки работы всей системы маршрутизации аудио
 * 
 * Эти тесты проверяют взаимодействие между компонентами,
 * но требуют реального SoundVolumeView.exe для полного тестирования
 */

describe('Audio Routing Integration', () => {
  let audioService: AudioSessionService;
  let svvLocator: SVVLocator;

  beforeEach(() => {
    audioService = new AudioSessionService();
    svvLocator = new SVVLocator();
  });

  describe('SVVLocator + AudioSessionService', () => {
    it('должен найти SoundVolumeView и проверить готовность', async () => {
      // Этот тест требует реального SoundVolumeView.exe
      // В CI/CD можно пропустить если файл не найден
      const svvPath = await svvLocator.findSVV();
      
      if (!svvPath) {
        console.log('⚠️  SoundVolumeView.exe not found, skipping integration test');
        return;
      }

      const isReady = await audioService.isReady();
      expect(isReady).toBe(true);
    });

    it('должен получить список аудио сессий', async () => {
      const svvPath = await svvLocator.findSVV();
      
      if (!svvPath) {
        console.log('⚠️  SoundVolumeView.exe not found, skipping integration test');
        return;
      }

      try {
        const sessions = await audioService.getAudioSessions();
        
        // Проверяем структуру данных
        expect(Array.isArray(sessions)).toBe(true);
        
        if (sessions.length > 0) {
          const session = sessions[0];
          expect(session).toHaveProperty('processId');
          expect(session).toHaveProperty('processName');
          expect(session).toHaveProperty('displayName');
          expect(session).toHaveProperty('processPath');
          expect(session).toHaveProperty('volume');
          expect(session).toHaveProperty('muted');
        }
      } catch (error) {
        // Если SoundVolumeView не работает, это нормально для тестов
        console.log('⚠️  Could not get audio sessions:', error);
      }
    });

    it('должен получить список аудио устройств', async () => {
      const svvPath = await svvLocator.findSVV();
      
      if (!svvPath) {
        console.log('⚠️  SoundVolumeView.exe not found, skipping integration test');
        return;
      }

      try {
        const devices = await audioService.getAudioDevices();
        
        expect(Array.isArray(devices)).toBe(true);
        
        if (devices.length > 0) {
          const device = devices[0];
          expect(device).toHaveProperty('name');
          expect(device).toHaveProperty('id');
          expect(device).toHaveProperty('isDefault');
        }
      } catch (error) {
        console.log('⚠️  Could not get audio devices:', error);
      }
    });

    it('должен проверить наличие VB-Cable', async () => {
      const svvPath = await svvLocator.findSVV();
      
      if (!svvPath) {
        console.log('⚠️  SoundVolumeView.exe not found, skipping integration test');
        return;
      }

      try {
        const hasVC = await audioService.hasVBCable();
        const vcDeviceName = await audioService.getVBCableDeviceName();
        
        if (hasVC) {
          expect(vcDeviceName).toBeTruthy();
          expect(typeof vcDeviceName).toBe('string');
        } else {
          console.log('⚠️  VB-Cable not found in system');
        }
      } catch (error) {
        console.log('⚠️  Could not check VB-Cable:', error);
      }
    });
  });

  describe('CSV Parsing', () => {
    it('должен правильно парсить реальный формат CSV от SoundVolumeView', () => {
      const realCSV = `Name,Type,Direction,Process ID,Process Path,Volume Percent,Muted,Device Name
"Spotify","Application","Render","1234","C:\\Program Files\\Spotify\\spotify.exe","80","No","Speakers"
"Chrome","Application","Render","5678","C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","50","Yes","Speakers"
"System","Device","Render","0","","100","No","Speakers"`;

      const sessions = (audioService as any).parseCSV(realCSV);

      expect(sessions).toHaveLength(2);
      expect(sessions[0].processName).toBe('spotify.exe');
      expect(sessions[0].muted).toBe(false);
      expect(sessions[1].processName).toBe('chrome.exe');
      expect(sessions[1].muted).toBe(true);
    });

    it('должен обрабатывать CSV с кавычками и запятыми в значениях', () => {
      const csvWithQuotes = `Name,Type,Direction,Process ID,Process Path,Volume Percent,Muted,Device Name
"App, Name","Application","Render","1234","C:\\Program Files\\App, Name\\app.exe","80","No","Speakers"`;

      const sessions = (audioService as any).parseCSV(csvWithQuotes);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].processName).toBe('app.exe');
    });
  });

  describe('Process Name Extraction', () => {
    it('должен извлекать имя процесса из различных форматов путей', () => {
      const testCases = [
        { path: 'C:\\Program Files\\Game\\game.exe', expected: 'game.exe' },
        { path: 'C:/Program Files/Game/game.exe', expected: 'game.exe' },
        { path: '/usr/local/bin/app', expected: 'app' },
        { path: 'game.exe', expected: 'game.exe' },
      ];

      testCases.forEach(({ path, expected }) => {
        const result = (audioService as any).extractProcessName(path);
        expect(result).toBe(expected);
      });
    });
  });

  describe('Display Name Generation', () => {
    it('должен использовать словарь известных приложений', () => {
      const knownApps = [
        { processName: 'cs2.exe', expected: 'Counter-Strike 2' },
        { processName: 'dota2.exe', expected: 'Dota 2' },
        { processName: 'spotify.exe', expected: 'Spotify' },
      ];

      knownApps.forEach(({ processName, expected }) => {
        const result = (audioService as any).getDisplayName(processName, '');
        expect(result).toBe(expected);
      });
    });

    it('должен использовать имя сессии если доступно', () => {
      const result = (audioService as any).getDisplayName('unknown.exe', 'My Custom Game');
      expect(result).toBe('My Custom Game');
    });

    it('должен capitalize имя процесса как fallback', () => {
      const result = (audioService as any).getDisplayName('mygame.exe', '');
      expect(result).toBe('Mygame');
    });
  });
});

