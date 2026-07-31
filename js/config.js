/**
 * Device configuration: the token and which repo holds the data.
 *
 * Lives in localStorage, one device at a time, never committed. Storage is
 * injected so this is testable without a browser.
 *
 * Security posture, stated plainly: anyone with the unlocked device can read this
 * token and therefore the task list. That is accepted, and bounded by scoping the
 * token to one repo with an expiry. See the README's risk section.
 *
 * @module config
 */

export const CONFIG_KEY = 'daily.config.v1';

/** Defaults so the setup form is one field, not three, in the normal case. */
export const DEFAULT_OWNER = 'lswyss';
export const DEFAULT_REPO = 'daily-data';

/**
 * @typedef {object} DailyConfig
 * @property {string} token
 * @property {string} owner
 * @property {string} repo
 * @property {string|null} savedAt
 */

/**
 * Does this look like a GitHub token? A soft check to catch a truncated paste
 * early. The real validation is always a live read — never trust the shape.
 * @param {string} token
 * @returns {{plausible: boolean, hint: string|null}}
 */
export function inspectToken(token) {
  const value = String(token ?? '').trim();
  if (value === '') return { plausible: false, hint: 'Paste a token to continue.' };
  if (/\s/.test(value)) {
    return { plausible: false, hint: 'That contains a space — the paste may be incomplete.' };
  }
  if (value.startsWith('github_pat_')) return { plausible: true, hint: null };
  if (/^gh[pousr]_/.test(value)) {
    return {
      plausible: true,
      hint: 'That looks like a classic token. A fine-grained token scoped to one repo is safer.',
    };
  }
  return {
    plausible: false,
    hint: 'That does not look like a GitHub token. Fine-grained tokens start with github_pat_.',
  };
}

/**
 * Read stored config. Returns null when this device has not been set up.
 * @param {Storage|{getItem(k: string): string|null}} storage
 * @returns {DailyConfig|null}
 */
export function loadConfig(storage) {
  let raw;
  try {
    raw = storage.getItem(CONFIG_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.token) return null;
    return {
      token: parsed.token,
      owner: parsed.owner || DEFAULT_OWNER,
      repo: parsed.repo || DEFAULT_REPO,
      savedAt: parsed.savedAt ?? null,
    };
  } catch {
    // Corrupt config is the same as no config: the setup screen will ask again.
    return null;
  }
}

/**
 * Persist config. Trims the token, because a pasted token routinely carries a
 * trailing newline and GitHub rejects it with a confusing 401.
 * @param {{token: string, owner?: string, repo?: string}} input
 * @param {Storage|{setItem(k: string, v: string): void}} storage
 * @param {() => string} [now]
 * @returns {DailyConfig}
 */
export function saveConfig(input, storage, now = () => new Date().toISOString()) {
  const token = String(input.token ?? '').trim();
  if (token === '') throw new Error('saveConfig: token is required');

  /** @type {DailyConfig} */
  const config = {
    token,
    owner: (input.owner || DEFAULT_OWNER).trim(),
    repo: (input.repo || DEFAULT_REPO).trim(),
    savedAt: now(),
  };
  storage.setItem(CONFIG_KEY, JSON.stringify(config));
  return config;
}

/**
 * Forget this device entirely: token and any queued changes.
 *
 * The queue goes too, deliberately. Queued mutations cannot be flushed without a
 * token, and leaving them behind would replay a previous user's edits against a
 * different account's data later.
 *
 * @param {Storage|{removeItem(k: string): void}} storage
 * @param {string[]} [alsoRemove]
 */
export function clearConfig(storage, alsoRemove = ['daily.mutations.v1']) {
  storage.removeItem(CONFIG_KEY);
  for (const key of alsoRemove) storage.removeItem(key);
}
