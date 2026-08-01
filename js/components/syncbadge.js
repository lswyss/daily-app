/**
 * The sync badge.
 *
 * The single most important rule in this file: **never fake success.** A stale
 * "synced" is the worst failure this app can have, because it tells the user
 * their record of when an experiment happened is safe when it is not.
 *
 * So the badge only reads "synced" when a write was confirmed *and* nothing is
 * queued. Any pending mutation shows as unsaved, even between flushes.
 *
 * @module components/syncbadge
 */

/** @typedef {'synced'|'syncing'|'unsaved'|'offline'|'conflict'|'error'} BadgeState */

const LABELS = {
  synced: 'Synced',
  syncing: 'Saving…',
  unsaved: 'Unsaved',
  offline: 'Offline',
  conflict: 'Conflict',
  error: 'Error',
};

const MARKS = {
  synced: '✓',
  syncing: '⋯',
  unsaved: '•',
  offline: '⊘',
  conflict: '!',
  error: '!',
};

/**
 * Decide what the badge should say.
 *
 * @param {{status: BadgeState, pending: number, lastSyncedAt?: string|null}} args
 * @returns {{state: BadgeState, label: string, detail: string}}
 */
export function badgeState({ status, pending, lastSyncedAt = null }) {
  // An in-flight or failed state always wins over the queue count.
  if (status === 'syncing' || status === 'offline' || status === 'conflict' || status === 'error') {
    return {
      state: status,
      label: LABELS[status],
      detail:
        status === 'conflict'
          ? 'Someone else wrote first. Your changes are still saved on this device.'
          : status === 'offline'
            ? `${pending} change${pending === 1 ? '' : 's'} waiting for a connection.`
            : status === 'error'
              ? 'Could not save. Your changes are still on this device.'
              : 'Writing to GitHub…',
    };
  }

  if (pending > 0) {
    return {
      state: 'unsaved',
      label: LABELS.unsaved,
      detail: `${pending} change${pending === 1 ? '' : 's'} not yet written.`,
    };
  }

  return {
    state: 'synced',
    label: LABELS.synced,
    detail: lastSyncedAt ? `Last written ${new Date(lastSyncedAt).toLocaleTimeString()}.` : 'Up to date.',
  };
}

/**
 * @param {{status: BadgeState, pending: number, lastSyncedAt?: string|null, onClick?: () => void}} args
 * @returns {HTMLElement}
 */
export function syncBadge(args) {
  const { state, label, detail } = badgeState(args);

  const element = document.createElement(args.onClick ? 'button' : 'span');
  element.className = `badge is-${state}`;
  element.title = detail;
  if (args.onClick) {
    /** @type {HTMLButtonElement} */ (element).type = 'button';
    element.addEventListener('click', args.onClick);
  }

  const mark = document.createElement('span');
  mark.className = 'badge-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = MARKS[state];

  const text = document.createElement('span');
  text.textContent = label;

  element.append(mark, text);
  // Announce changes politely rather than interrupting.
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-label', `${label}. ${detail}`);

  return element;
}
