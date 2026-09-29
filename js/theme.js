/**
 * Light or dark, chosen per device. Light is the default everywhere: the app is
 * designed on cream paper, and following a phone that lives in dark mode made it
 * look like a different app. "Match device" is there for anyone who wants that.
 *
 * `index.html` applies the saved choice in an inline script before the first
 * paint, so there is no flash of the wrong colours; this module handles changes.
 *
 * @module theme
 */

export const THEME_KEY = 'daily.theme';

/** @type {readonly ['light','dark','auto']} */
export const THEMES = /** @type {const} */ (['light', 'dark', 'auto']);

export const THEME_LABELS = { light: 'Light', dark: 'Dark', auto: 'Match device' };

/**
 * @param {{getItem(k: string): string|null}} storage
 * @returns {'light'|'dark'|'auto'}
 */
export function loadTheme(storage) {
  try {
    const value = storage.getItem(THEME_KEY);
    return THEMES.includes(/** @type {any} */ (value)) ? /** @type {any} */ (value) : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Save and apply.
 * @param {'light'|'dark'|'auto'} theme
 * @param {{setItem(k: string, v: string): void}} storage
 */
export function setTheme(theme, storage) {
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    // Private browsing: it still applies for this visit.
  }
  applyTheme(theme);
}

/** @param {'light'|'dark'|'auto'} theme */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Tells the browser which native controls (date pickers, selects) to draw.
  const scheme = theme === 'auto' ? 'light dark' : theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#151914' : '#F4F1E8');
}
