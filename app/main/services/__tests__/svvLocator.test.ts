import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SVVLocator } from '../svvLocator.js';

// Моки
vi.mock('electron/main', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return '/tmp/test-user-data';
      if (name === 'home') return '/tmp/test-home';
      return '/tmp';
    }),
  },
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockAccess = vi.fn();
const mockWriteFile = vi.fn();

vi.mock('node:fs', () => ({
  default: {
    existsSync: () => mockExistsSync(),
    readFileSync: () => mockReadFileSync(),
    promises: {
      access: () => mockAccess(),
      writeFile: () => mockWriteFile(),
    },
  },
  existsSync: () => mockExistsSync(),
  readFileSync: () => mockReadFileSync(),
  promises: {
    access: () => mockAccess(),
    writeFile: () => mockWriteFile(),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('SVVLocator', () => {
  let locator: SVVLocator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockAccess.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    locator = new SVVLocator();
  });

  describe('findSVV', () => {
    it('должен найти SoundVolumeView в сохранённом пути', async () => {
      const savedPath = '/path/to/SoundVolumeView.exe';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(savedPath);
      mockAccess.mockResolvedValue(undefined);

      const result = await locator.findSVV();

      expect(result).toBe(savedPath);
      expect(mockReadFileSync).toHaveBeenCalled();
    });

    it('должен найти SoundVolumeView в PATH', async () => {
      const pathInEnv = '/usr/local/bin/SoundVolumeView.exe';
      mockExistsSync.mockReturnValue(false);
      mockAccess.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      // Мокаем execFileAsync через where команду
      vi.spyOn(require('node:util'), 'promisify').mockReturnValue(
        async () => ({ stdout: pathInEnv })
      );

      const result = await locator.findSVV();

      expect(result).toBe(pathInEnv);
    });

    it('должен вернуть null если SoundVolumeView не найден', async () => {
      mockExistsSync.mockReturnValue(false);
      mockAccess.mockRejectedValue(new Error('not found'));

      // Мокаем execFileAsync чтобы он выбрасывал ошибку
      vi.spyOn(require('node:util'), 'promisify').mockReturnValue(
        async () => { throw new Error('not found'); }
      );

      const result = await locator.findSVV();

      expect(result).toBeNull();
    });
  });

  describe('setManualPath', () => {
    it('должен сохранить валидный путь', async () => {
      const testPath = '/valid/path/SoundVolumeView.exe';
      // Мокаем доступ к файлу как успешный
      mockAccess.mockImplementation(() => Promise.resolve());
      mockWriteFile.mockImplementation(() => Promise.resolve());

      const result = await locator.setManualPath(testPath);

      expect(result).toBe(true);
    });

    it('должен вернуть false для невалидного пути', async () => {
      const testPath = '/invalid/path/SoundVolumeView.exe';
      // Мокаем доступ к файлу как неуспешный
      mockAccess.mockImplementation(() => Promise.reject(new Error('not found')));

      const result = await locator.setManualPath(testPath);

      expect(result).toBe(false);
    });
  });

  describe('isReady', () => {
    it('должен вернуть true если путь валиден', async () => {
      const testPath = '/valid/path/SoundVolumeView.exe';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(testPath);
      mockAccess.mockImplementation(() => Promise.resolve());

      const result = await locator.isReady();

      expect(result).toBe(true);
    });

    it('должен вернуть false если путь невалиден', async () => {
      mockExistsSync.mockReturnValue(false);
      mockAccess.mockImplementation(() => Promise.reject(new Error('not found')));

      const result = await locator.isReady();

      expect(result).toBe(false);
    });
  });

  describe('getCurrentPath', () => {
    it('должен вернуть сохранённый путь', () => {
      const savedPath = '/saved/path/SoundVolumeView.exe';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(savedPath);

      const result = locator.getCurrentPath();

      expect(result).toBe(savedPath);
    });

    it('должен вернуть null если путь не сохранён', () => {
      mockExistsSync.mockReturnValue(false);

      const result = locator.getCurrentPath();

      expect(result).toBeNull();
    });
  });
});

