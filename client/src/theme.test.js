import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, resolveTheme, setTheme, storedTheme, THEME_KEY, watchTheme } from './theme.js';

/** Pretends the browser prefers dark (or not), with a way to change it. */
function mockPreference(dark) {
  const listeners = new Set();
  const media = {
    get matches() {
      return dark;
    },
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  return (next) => {
    dark = next;
    for (const fn of listeners) fn();
  };
}

describe('theme', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  it('remembers a choice, the browser default being none', () => {
    expect(storedTheme()).toBe('system');
    setTheme('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(storedTheme()).toBe('dark');
    setTheme('system');
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    window.localStorage.setItem(THEME_KEY, 'purple');
    expect(storedTheme()).toBe('system');
  });

  it('shows the browser’s preference for the default, and follows it', () => {
    const prefer = mockPreference(true);
    expect(resolveTheme('system')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('dark');

    const stop = watchTheme();
    prefer(false);
    expect(document.documentElement.dataset.theme).toBe('light');
    // A choice of its own isn't overridden by the browser's.
    setTheme('dark');
    prefer(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
  });

  it('defaults to light without a preference to read', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(resolveTheme('system')).toBe('light');
  });
});
