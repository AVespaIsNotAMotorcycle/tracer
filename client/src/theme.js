// Light or dark mode: the user's choice (light, dark, or the browser's default, 'system'),
// remembered in this browser, and applied as `data-theme` on <html> ('light' or 'dark'), which
// App.css themes by. The choice is applied before the page first paints by a small script in
// index.html that repeats storedTheme and resolveTheme, so there's no flash of the wrong theme;
// keep the two in step.

export const THEME_KEY = 'tracer:theme';
export const THEMES = ['system', 'light', 'dark'];

const darkQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');

/** The user's choice: 'system' (the browser's default), 'light' or 'dark'. */
export function storedTheme() {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/** The theme a choice shows: 'light' or 'dark'. */
export function resolveTheme(choice) {
  if (choice === 'light' || choice === 'dark') return choice;
  return darkQuery()?.matches ? 'dark' : 'light';
}

/** Shows the theme for `choice`. */
export function applyTheme(choice) {
  document.documentElement.dataset.theme = resolveTheme(choice);
}

/** Remembers `choice` in this browser and shows it. */
export function setTheme(choice) {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage blocked: it applies to this page only.
  }
  applyTheme(choice);
}

/**
 * Keeps the theme current: follows the browser's setting while the choice is 'system', and a
 * choice made in another tab. Returns a function that stops it.
 */
export function watchTheme() {
  const update = () => applyTheme(storedTheme());
  const media = darkQuery();
  media?.addEventListener('change', update);
  const onStorage = (event) => {
    if (event.key === THEME_KEY || event.key === null) update();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    media?.removeEventListener('change', update);
    window.removeEventListener('storage', onStorage);
  };
}
