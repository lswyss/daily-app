/**
 * Entry point: wiring, routing, and the optimistic-update loop.
 *
 * The loop is: user acts → append a mutation → apply it locally → re-render →
 * debounce a flush. The local copy is always "what the server has, plus what is
 * still queued", so the screen never disagrees with the badge.
 *
 * @module main
 */

import { loadConfig } from './config.js';
import { createGitHubClient } from './github.js';
import {
  applyMutation,
  applyMutations,
  createMutationLog,
  emptyState,
  mutation,
  parseState,
} from './store.js';
import {
  FLUSH_DEBOUNCE_MS,
  createDebouncer,
  createFlushQueue,
  planInboxDrain,
  pushMutations,
} from './sync.js';
import { newTaskId, parseCapture, toTask, todayIso } from './parse.js';
import { needsConfirmation } from './views/today.js';
import { normaliseAnchor } from './calendar.js';
import { syncBadge } from './components/syncbadge.js';
import { renderSetup } from './views/setup.js';
import { renderToday } from './views/today.js';
import { renderCalendar } from './views/calendar.js';
import { groupIdeas, renderIdeas } from './views/ideas.js';

const root = /** @type {HTMLElement} */ (document.getElementById('view'));
const flashEl = /** @type {HTMLElement} */ (document.getElementById('flash'));
const bannerEl = /** @type {HTMLElement} */ (document.getElementById('banner'));
const toastEl = /** @type {HTMLElement} */ (document.getElementById('toast'));
const storage = globalThis.localStorage;

/** @type {{config: any, client: any, base: any, local: any, status: string, lastSyncedAt: string|null, draft: string, loading: boolean, loadError: Error|null}} */
const app = {
  config: null,
  client: null,
  base: emptyState(),
  local: emptyState(),
  status: 'synced',
  lastSyncedAt: null,
  draft: '',
  ideaDraft: '',
  upcomingOpen: false,
  editingId: null,
  loading: false,
  loadError: null,
  // Always opens on Today. The calendar is somewhere you go, not where you land.
  view: 'today',
  zoom: 'month',
  anchor: normaliseAnchor('month', todayIso()),
  selectedDay: todayIso(),
};

const log = createMutationLog({
  storage,
  onError: (err) => flash(err.message, 'bad'),
});

// --------------------------------------------------------------- chrome

/** @param {string} text @param {'ok'|'bad'} [kind] */
function flash(text, kind = 'ok') {
  flashEl.textContent = text;
  flashEl.className = `flash is-${kind}`;
  flashEl.hidden = false;
  globalThis.setTimeout(() => {
    if (flashEl.textContent === text) flashEl.hidden = true;
  }, 6000);
}

let toastTimer = null;
/** @param {string} text @param {{label: string, onAction: () => void}} [action] */
function toast(text, action) {
  toastEl.replaceChildren();
  const label = document.createElement('span');
  label.textContent = text;
  toastEl.append(label);

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      hideToast();
      action.onAction();
    });
    toastEl.append(button);
  }

  toastEl.hidden = false;
  if (toastTimer) globalThis.clearTimeout(toastTimer);
  toastTimer = globalThis.setTimeout(hideToast, 8000);
}

function hideToast() {
  toastEl.hidden = true;
  if (toastTimer) globalThis.clearTimeout(toastTimer);
  toastTimer = null;
}

/** The conflict banner. Persistent — it must not be dismissible by accident. */
function showConflict() {
  bannerEl.replaceChildren();
  const text = document.createElement('p');
  text.textContent =
    'Another device wrote first, twice in a row. Your changes are safe on this device but are not on GitHub yet.';

  const actions = document.createElement('div');
  actions.className = 'banner-actions';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'primary';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => {
    hideConflict();
    void flushQueue.request();
  });

  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'danger';
  discard.textContent = 'Discard my changes';
  discard.addEventListener('click', () => {
    if (!globalThis.confirm(`Discard ${log.size()} unsaved change(s) and reload from GitHub?`)) return;
    log.clear();
    hideConflict();
    void reload();
  });

  actions.append(retry, discard);
  bannerEl.append(text, actions);
  bannerEl.hidden = false;
}

function hideConflict() {
  bannerEl.hidden = true;
  bannerEl.replaceChildren();
}

// ----------------------------------------------------------------- sync

const flushQueue = createFlushQueue(async () => {
  if (log.isEmpty() || !app.client) return;

  app.status = 'syncing';
  render();

  const result = await pushMutations({ client: app.client, log });

  if (result.status === 'synced') {
    // Adopt what was actually written. After a replay this includes the other
    // device's changes, so rendering our own optimistic copy would be a lie.
    if (result.state) {
      app.base = result.state;
      app.local = applyMutations(app.base, log.all()).state;
    }
    app.status = 'synced';
    app.lastSyncedAt = new Date().toISOString();
    hideConflict();

    if (result.skipped.length > 0) {
      flash(
        `${result.skipped.length} change(s) could not be applied — the task no longer exists.`,
        'bad',
      );
    }
  } else if (result.status === 'conflict') {
    app.status = 'conflict';
    showConflict();
  } else if (result.status === 'offline') {
    app.status = 'offline';
  } else if (result.status === 'error') {
    app.status = 'error';
    flash(result.error?.message ?? 'Could not save.', 'bad');
  }

  render();
});

const debouncer = createDebouncer(() => void flushQueue.request(), FLUSH_DEBOUNCE_MS);

/** Apply a mutation locally and queue it. */
function commit(m) {
  log.append(m);
  const { state, skipped } = applyMutation(app.local, m);
  app.local = state;
  if (skipped) flash(`That task is no longer here (${skipped}).`, 'bad');
  if (app.status !== 'conflict') app.status = 'unsaved';
  render();
  debouncer.schedule();
}

async function reload() {
  if (!app.client) return;
  app.loading = true;
  app.loadError = null;
  render();

  try {
    const file = await app.client.readFile('data.json');
    if (file === null) throw new Error('data.json is missing from the data repo.');
    app.base = parseState(file.content);
    app.local = applyMutations(app.base, log.all()).state;
    app.status = log.isEmpty() ? 'synced' : 'unsaved';
    if (log.isEmpty()) app.lastSyncedAt = new Date().toISOString();
  } catch (err) {
    app.loadError = /** @type {Error} */ (err);
    app.status = 'error';
  } finally {
    app.loading = false;
    render();
  }

  // Pick up anything dictated since the app was last open.
  if (!app.loadError) void drainInbox({ force: true });
}

// ---------------------------------------------------------- inbox drain

/** Don't re-list the inbox on every glance back at the app. */
const DRAIN_COOLDOWN_MS = 60_000;
let lastDrainAt = 0;

/**
 * Decide what one dictated capture means.
 *
 * The Shortcut declares `"type": "idea"`, so the common path needs no guessing.
 * Anything else that cannot be filed confidently is imported **as an idea** rather
 * than dropped or guessed into a dated task — an idea is the harmless resting
 * place, it is visible in the Ideas list, and it can be promoted in one tap.
 */
function interpretCapture(capture, id) {
  const parsed = parseCapture(capture.raw, {
    today: todayIso(),
    projects: app.local.projects ?? [],
    experiments: (app.local.experiments ?? []).map((e) => e.id),
  });

  const decisions = {
    id,
    source: capture.source === 'app' ? 'app' : 'shortcut',
    now: capture.capturedAt,
  };

  const wantsIdea = capture.type === 'idea' || parsed.type === 'idea';
  if (wantsIdea || needsConfirmation(parsed, todayIso())) {
    return { task: toTask({ ...parsed, type: 'idea', due: null }, decisions) };
  }
  return { task: toTask(parsed, decisions) };
}

/**
 * Import everything sitting in `inbox/`, then delete the files we imported.
 *
 * Write first, delete second. Deleting first would lose the capture from the
 * inbox if the write then failed. Files we could not read are left in place
 * rather than quietly discarded.
 */
async function drainInbox({ force = false } = {}) {
  if (!app.client) return;
  if (!force && Date.now() - lastDrainAt < DRAIN_COOLDOWN_MS) return;
  lastDrainAt = Date.now();

  let files;
  try {
    files = await app.client.listDir('inbox');
  } catch {
    return; // Offline or unreachable; the next drain will pick it up.
  }
  if (files.length === 0) return;

  const plan = await planInboxDrain({
    files,
    readCapture: async (file) => {
      const blob = await app.client.readFile(file.path);
      return blob ? JSON.parse(blob.content) : null;
    },
    interpret: interpretCapture,
  });

  if (plan.mutations.length === 0) {
    if (plan.unreadable.length > 0) {
      flash(`${plan.unreadable.length} capture(s) could not be read. Left in the inbox.`, 'bad');
    }
    return;
  }

  const imported = new Set(plan.mutations.map((m) => m.id));
  for (const m of plan.mutations) commit(m);

  await flushQueue.request();

  // Only clear the inbox once the import is genuinely on GitHub.
  if (!log.isEmpty() || app.status !== 'synced') {
    flash(`${plan.mutations.length} capture(s) imported but not yet saved.`, 'bad');
    return;
  }

  for (const file of files) {
    const id = plan.mutations.find((m) => imported.has(m.id) && file.path.includes(m.id.replace('t_inbox_', '')));
    if (!id) continue;
    try {
      await app.client.deleteFile({
        path: file.path,
        sha: file.sha,
        message: `drain: ${file.name}`,
      });
    } catch {
      // The task is saved; a stuck inbox file is harmless because re-importing
      // it produces the same id and is a no-op.
    }
  }

  flash(`Imported ${plan.mutations.length} capture(s).`);
  if (plan.unreadable.length > 0) {
    flash(`${plan.unreadable.length} capture(s) could not be read. Left in the inbox.`, 'bad');
  }
}

// --------------------------------------------------------------- render

function render() {
  if (!app.config) {
    root.replaceChildren(
      renderSetup({
        storage,
        onDone: (message) => {
          flash(message);
          boot();
        },
      }),
    );
    return;
  }

  if (app.loading) {
    const loading = document.createElement('p');
    loading.className = 'meta';
    loading.textContent = 'Loading…';
    root.replaceChildren(loading);
    return;
  }

  if (app.loadError) {
    const wrap = document.createElement('section');
    wrap.className = 'setup';
    const h1 = document.createElement('h1');
    h1.textContent = 'Daily';
    const message = document.createElement('p');
    message.className = 'status is-bad';
    message.textContent = `Could not load your data: ${app.loadError.message}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => void reload());
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'quiet';
    settings.textContent = 'Settings';
    settings.addEventListener('click', showSettings);
    wrap.append(h1, message, retry, settings);
    root.replaceChildren(wrap);
    return;
  }

  const badge = syncBadge({
    status: /** @type {any} */ (app.status),
    pending: log.size(),
    lastSyncedAt: app.lastSyncedAt,
    onClick: () => void debouncer.flushNow(),
  });

  // Editing works identically in both views, so the callbacks are shared.
  const listCtx = {
    editingId: app.editingId,
    onToggle: handleToggle,
    onOpen: (id) => {
      app.editingId = id;
      hideToast();
      render();
    },
    onSaveEdit: handleSaveEdit,
    onDelete: handleDelete,
    onCancelEdit: () => {
      app.editingId = null;
      render();
    },
  };

  if (app.view === 'ideas') {
    root.replaceChildren(
      renderIdeas({
        state: app.local,
        today: todayIso(),
        badge,
        draft: app.ideaDraft,
        onDraft: (value) => {
          app.ideaDraft = value;
        },
        editingId: app.editingId,
        onOpen: listCtx.onOpen,
        onSaveEdit: handleSaveEdit,
        onDelete: handleDelete,
        onCancelEdit: listCtx.onCancelEdit,
        onAdd: handleAddIdea,
        onPromote: handlePromote,
        onArchive: handleArchiveIdea,
        onBack: () => {
          app.view = 'today';
          app.editingId = null;
          render();
        },
      }),
    );
    return;
  }

  if (app.view === 'calendar') {
    root.replaceChildren(
      renderCalendar({
        state: app.local,
        today: todayIso(),
        zoom: app.zoom,
        anchor: app.anchor,
        selected: app.selectedDay,
        badge,
        listCtx,
        onZoom: (zoom, target) => {
          app.zoom = zoom;
          app.anchor = normaliseAnchor(zoom, target ?? app.anchor);
          render();
        },
        onAnchor: (anchor) => {
          app.anchor = normaliseAnchor(app.zoom, anchor);
          render();
        },
        onSelectDay: (iso) => {
          // Tapping the selected day again closes the panel.
          app.selectedDay = app.selectedDay === iso ? null : iso;
          render();
        },
        onBack: () => {
          app.view = 'today';
          app.editingId = null;
          render();
        },
      }),
    );
    return;
  }

  root.replaceChildren(
    renderToday({
      state: app.local,
      today: todayIso(),
      badge,
      draft: app.draft,
      onDraft: (value) => {
        app.draft = value;
      },
      upcomingOpen: app.upcomingOpen,
      onUpcomingToggle: (open) => {
        app.upcomingOpen = open;
      },
      ...listCtx,
      onAdd: handleAdd,
      onSettings: showSettings,
      ideaCount: groupIdeas(app.local.tasks ?? []).open.length,
      onIdeas: () => {
        app.view = 'ideas';
        app.editingId = null;
        render();
      },
      onCalendar: () => {
        app.view = 'calendar';
        app.editingId = null;
        // Land on the period containing today, whatever was last looked at.
        app.anchor = normaliseAnchor(app.zoom, todayIso());
        app.selectedDay = todayIso();
        render();
      },
    }),
  );
}

function showSettings() {
  root.replaceChildren(
    renderSetup({
      storage,
      onDone: (message) => {
        flash(message);
        boot();
      },
    }),
  );
}

// -------------------------------------------------------------- actions

function handleToggle(id) {
  const task = app.local.tasks.find((t) => t.id === id);
  if (!task) return;

  if (task.done) {
    commit(mutation('uncomplete', id));
    return;
  }

  commit(mutation('complete', id));
  toast(`Completed “${task.title}”`, {
    label: 'Undo',
    onAction: () => commit(mutation('uncomplete', id)),
  });
}

/**
 * Save an edit. Field changes and date changes become separate mutations so the
 * commit message names what actually happened.
 * @param {string} id
 * @param {{edit?: object, due?: string|null}} changes
 */
function handleSaveEdit(id, changes) {
  app.editingId = null;

  if (changes.edit) commit(mutation('edit', id, changes.edit));
  if ('due' in changes) commit(mutation('reschedule', id, { due: changes.due }));

  if (!changes.edit && !('due' in changes)) render(); // nothing changed; just close
}

function handleDelete(id) {
  const task = app.local.tasks.find((t) => t.id === id);
  app.editingId = null;
  commit(mutation('delete', id));

  // Deletion is the one destructive action here, so keep a way back for a while.
  if (task) {
    toast(`Deleted “${task.title}”`, {
      label: 'Undo',
      onAction: () => commit(mutation('add', task.id, task)),
    });
  }
}

function handleAddIdea(idea) {
  commit(mutation('add', idea.id, idea));
  toast(`Saved “${idea.title}”`, {
    label: 'Undo',
    onAction: () => commit(mutation('delete', idea.id)),
  });
}

/**
 * Turn an idea into a task due today.
 *
 * Two mutations rather than one: the type change is an `edit` and the date is a
 * `reschedule`, so `git log` shows both for what they are.
 */
function handlePromote(id) {
  const idea = app.local.tasks.find((t) => t.id === id);
  if (!idea) return;

  commit(mutation('edit', id, { type: 'task' }));
  commit(mutation('reschedule', id, { due: todayIso() }));

  app.view = 'today';
  render();
  toast(`“${idea.title}” is now a task for today`, {
    label: 'Undo',
    onAction: () => {
      commit(mutation('edit', id, { type: 'idea' }));
      commit(mutation('reschedule', id, { due: null }));
    },
  });
}

/** Archive keeps the idea and its history; it is `done`, not deleted. */
function handleArchiveIdea(id) {
  const idea = app.local.tasks.find((t) => t.id === id);
  if (!idea) return;
  commit(mutation(idea.done ? 'uncomplete' : 'complete', id));
}

function handleAdd(task) {
  commit(mutation('add', task.id, task));
  // Most captures now skip the confirm step, so the toast is the feedback that
  // it landed — and the way back if it did not land the way you meant.
  toast(`Added “${task.title}”`, {
    label: 'Undo',
    onAction: () => commit(mutation('delete', task.id)),
  });
}

// ----------------------------------------------------------------- boot

function boot() {
  app.config = loadConfig(storage);
  if (!app.config) {
    app.client = null;
    render();
    return;
  }
  app.client = createGitHubClient({
    token: app.config.token,
    owner: app.config.owner,
    repo: app.config.repo,
  });
  void reload();
}

// Flush on the ways a phone actually leaves a page. `pagehide` is the reliable
// one on iOS; `beforeunload` is not.
globalThis.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !log.isEmpty()) debouncer.flushNow();
  // Coming back to the app is exactly when a dictated idea should appear.
  if (document.visibilityState === 'visible') void drainInbox();
});
globalThis.addEventListener('pagehide', () => {
  if (!log.isEmpty()) debouncer.flushNow();
});
globalThis.addEventListener('online', () => {
  if (!log.isEmpty()) void flushQueue.request();
});
globalThis.addEventListener('offline', () => {
  app.status = 'offline';
  render();
});

boot();
