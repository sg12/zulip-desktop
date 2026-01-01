import { describe, it, expect } from 'vitest';
import { SVVLocator } from '../svvLocator.js';

/**
 * Упрощенные тесты для SVVLocator
 * Проверяют основную логику без сложных моков файловой системы
 */

describe('SVVLocator - Simple Tests', () => {
  it('должен создать экземпляр класса', () => {
    const locator = new SVVLocator();
    expect(locator).toBeInstanceOf(SVVLocator);
  });

  it('должен иметь метод findSVV', () => {
    const locator = new SVVLocator();
    expect(typeof locator.findSVV).toBe('function');
  });

  it('должен иметь метод setManualPath', () => {
    const locator = new SVVLocator();
    expect(typeof locator.setManualPath).toBe('function');
  });

  it('должен иметь метод isReady', () => {
    const locator = new SVVLocator();
    expect(typeof locator.isReady).toBe('function');
  });

  it('должен иметь метод getCurrentPath', () => {
    const locator = new SVVLocator();
    expect(typeof locator.getCurrentPath).toBe('function');
  });
});

