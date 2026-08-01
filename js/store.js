/**
 * State shape, validation, the mutation log, and the replay reducer.
 *
 * No DOM dependencies — storage is injected, so this runs under `node --test`
 * with a plain object standing in for localStorage.
 *
 * The central idea: user actions become *operations*, not state snapshots.
 * Replaying operations against freshly fetched remote state is what makes a
 * merge after a conflict sane. Never queue whole-state snapshots.
 *
 * @module store
 */

export const SCHEMA_VERSION = 1;

/** @type {readonly ['lab','personal']} */
export const SCOPES = /** @type {const} */ (['lab', 'personal']);

/** @type {readonly ['task','meeting','reading','idea','appointment']} */
export const TYPES = /** @type {const} */ ([
  'task',
  'meeting',
  'reading',
  'idea',
  'appointment',
]);

/** @type {readonly ['app','shortcut','claude-code']} */
export const SOURCES = /** @type {const} */ (['app', 'shortcut', 'claude-code']);

/** @type {readonly ['add','complete','uncomplete','edit','reschedule','delete']} */
export const OPS = /** @type {const} */ ([
  'add',
  'complete',
  'uncomplete',
  'edit',
  'reschedule',
  'delete',
]);

/** Fields a mutation may never change. `id` identifies the row; the rest are history. */
const IMMUTABLE_TASK_FIELDS = ['id', 'createdAt', 'source'];

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {'lab'|'personal'} scope
 * @property {'task'|'meeting'|'reading'|'idea'|'appointment'} type
 * @property {string|null} project
 * @property {string|null} experiment
 * @property {string|null} due        Absolute ISO date, never relative wording.
 * @property {boolean} done
 * @property {string|null} completedAt
 * @property {string} createdAt
 * @property {'app'|'shortcut'|'claude-code'} source
 * @property {string} notes
 */

/**
 * @typedef {object} Milestone
 * @property {number} day
 * @property {string} label
 */

/**
 * @typedef {object} Experiment
 * @property {string} id
 * @property {string} label
 * @property {string|null} project
 * @property {string} startDate
 * @property {boolean} active
 * @property {Milestone[]} milestones
 */

/**
 * @typedef {object} DailyState
 * @property {number} version
 * @property {string} updatedAt
 * @property {Task[]} tasks
 * @property {Experiment[]} experiments
 * @property {string[]} projects
 */

/**
 * @typedef {object} Mutation
 * @property {'add'|'complete'|'uncomplete'|'edit'|'reschedule'|'delete'} op
 * @property {string} id       Task id the op targets. For `add`, matches payload.id.
 * @property {any} [payload]
 * @property {string} ts       ISO timestamp of when the user acted.
 */

/** Raised when a mutation is structurally invalid. Never silently dropped. */
export class ValidationError extends Error {
  /** @param {string} message @param {{field?: string, value?: unknown}} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ValidationError';
    this.field = info.field ?? null;
    this.value = info.value ?? null;
  }
}

/** @returns {DailyState} */
export function emptyState(now = new Date().toISOString()) {
  return { version: SCHEMA_VERSION, updatedAt: now, tasks: [], experiments: [], projects: [] };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this an absolute ISO calendar date (YYYY-MM-DD) that actually exists?
 * Rejects "tomorrow" and "2026-02-30" alike.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/**
 * Normalise and validate a task, filling defaults. Throws rather than guessing.
 * @param {Partial<Task>} input
 * @returns {Task}
 */
export function normaliseTask(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('Task must be an object', { value: input });
  }
  const { id, title, scope } = input;

  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('Task id is required', { field: 'id', value: id });
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new ValidationError('Task title is required', { field: 'title', value: title });
  }
  if (!SCOPES.includes(/** @type {any} */ (scope))) {
    throw new ValidationError(`Task scope must be one of ${SCOPES.join(' | ')}`, {
      field: 'scope',
      value: scope,
    });
  }

  const type = input.type ?? 'task';
  if (!TYPES.includes(/** @type {any} */ (type))) {
    throw new ValidationError(`Task type must be one of ${TYPES.join(' | ')}`, {
      field: 'type',
      value: type,
    });
  }

  const source = input.source ?? 'app';
  if (!SOURCES.includes(/** @type {any} */ (source))) {
    throw new ValidationError(`Task source must be one of ${SOURCES.join(' | ')}`, {
      field: 'source',
      value: source,
    });
  }

  const due = input.due ?? null;
  if (due !== null && !isIsoDate(due)) {
    throw new ValidationError(
      `Task due must be an absolute ISO date (YYYY-MM-DD), got ${JSON.stringify(due)}. ` +
        'Relative wording must be resolved before it reaches the store.',
      { field: 'due', value: due },
    );
  }

  return {
    id: id.trim(),
    title: title.trim(),
    scope: /** @type {any} */ (scope),
    type: /** @type {any} */ (type),
    project: input.project ?? null,
    experiment: input.experiment ?? null,
    due,
    done: input.done ?? false,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: /** @type {any} */ (source),
    notes: input.notes ?? '',
  };
}

/**
 * Validate a mutation's shape. Throws ValidationError.
 * @param {Mutation} m
 * @returns {Mutation}
 */
export function assertMutation(m) {
  if (!m || typeof m !== 'object') {
    throw new ValidationError('Mutation must be an object', { value: m });
  }
  if (!OPS.includes(/** @type {any} */ (m.op))) {
    throw new ValidationError(`Unknown op ${JSON.stringify(m.op)}`, { field: 'op', value: m.op });
  }
  if (typeof m.ts !== 'string' || Number.isNaN(Date.parse(m.ts))) {
    throw new ValidationError('Mutation ts must be an ISO timestamp', {
      field: 'ts',
      value: m.ts,
    });
  }
  if (typeof m.id !== 'string' || m.id.trim() === '') {
    throw new ValidationError('Mutation id is required', { field: 'id', value: m.id });
  }
  if (m.op === 'add') {
    const task = normaliseTask(m.payload);
    if (task.id !== m.id) {
      throw new ValidationError(
        `add mutation id (${m.id}) must match payload.id (${task.id})`,
        { field: 'id', value: m.id },
      );
    }
  }
  if (m.op === 'reschedule') {
    const due = m.payload?.due ?? null;
    if (due !== null && !isIsoDate(due)) {
      throw new ValidationError('reschedule payload.due must be an ISO date or null', {
        field: 'payload.due',
        value: due,
      });
    }
  }
  if (m.op === 'edit') {
    if (!m.payload || typeof m.payload !== 'object') {
      throw new ValidationError('edit mutation requires a payload object', {
        field: 'payload',
        value: m.payload,
      });
    }
    for (const field of IMMUTABLE_TASK_FIELDS) {
      if (field in m.payload) {
        throw new ValidationError(`edit may not change ${field}`, { field, value: m.payload[field] });
      }
    }
    if ('due' in m.payload && m.payload.due !== null && !isIsoDate(m.payload.due)) {
      throw new ValidationError('edit payload.due must be an ISO date or null', {
        field: 'payload.due',
        value: m.payload.due,
      });
    }
    if ('scope' in m.payload && !SCOPES.includes(m.payload.scope)) {
      throw new ValidationError(`edit payload.scope must be one of ${SCOPES.join(' | ')}`, {
        field: 'payload.scope',
        value: m.payload.scope,
      });
    }
  }
  return m;
}

/**
 * Build a mutation, validating as it is created so bad ops never enter the log.
 * @param {Mutation['op']} op
 * @param {string} id
 * @param {any} [payload]
 * @param {string} [ts]
 * @returns {Mutation}
 */
export function mutation(op, id, payload = null, ts = new Date().toISOString()) {
  return assertMutation({ op, id, payload, ts });
}

/**
 * Apply one mutation. Pure: returns a new state, never touches the input.
 *
 * `skipped` is non-null when the op could not be applied — almost always because
 * the target task no longer exists remotely. That is a real conflict, so it is
 * reported upward rather than swallowed.
 *
 * @param {DailyState} state
 * @param {Mutation} m
 * @returns {{state: DailyState, skipped: string|null}}
 */
export function applyMutation(state, m) {
  assertMutation(m);

  const index = state.tasks.findIndex((t) => t.id === m.id);

  if (m.op === 'add') {
    if (index !== -1) {
      // Idempotent by design: a double inbox drain, or a replay of an op that
      // already landed, must not create a duplicate task.
      return { state, skipped: 'already-exists' };
    }
    const task = normaliseTask(m.payload);

    // Register tags the user confirmed, so they are offered next time instead of
    // being asked about again. This is not auto-creation: a tag only reaches a
    // task after an explicit choice in the capture preview. Deterministic, so
    // replaying this mutation against fresh state produces the same result.
    let { projects, experiments } = state;
    if (task.project && !projects.includes(task.project)) {
      projects = [...projects, task.project];
    }
    if (task.experiment && !experiments.some((e) => e.id === task.experiment)) {
      experiments = [
        ...experiments,
        {
          id: task.experiment,
          label: task.experiment,
          project: task.project ?? null,
          // Unknown until the user says. Phase 7's day counter must handle null
          // rather than assume a start date it was never told.
          startDate: null,
          active: true,
          milestones: [],
        },
      ];
    }

    return {
      state: { ...state, tasks: [...state.tasks, task], projects, experiments },
      skipped: null,
    };
  }

  if (index === -1) {
    return { state, skipped: 'task-missing' };
  }

  /** @param {(t: Task) => Task} fn */
  const replace = (fn) => {
    const tasks = state.tasks.slice();
    tasks[index] = fn(tasks[index]);
    return { state: { ...state, tasks }, skipped: null };
  };

  switch (m.op) {
    case 'complete':
      return replace((t) => ({ ...t, done: true, completedAt: m.ts }));
    case 'uncomplete':
      return replace((t) => ({ ...t, done: false, completedAt: null }));
    case 'reschedule':
      return replace((t) => ({ ...t, due: m.payload?.due ?? null }));
    case 'edit':
      // Immutable fields are rejected in assertMutation, but re-pin them here so
      // a future caller cannot route around validation.
      return replace((t) => ({
        ...t,
        ...m.payload,
        id: t.id,
        createdAt: t.createdAt,
        source: t.source,
      }));
    case 'delete':
      return {
        state: { ...state, tasks: state.tasks.filter((t) => t.id !== m.id) },
        skipped: null,
      };
    default:
      // Unreachable: assertMutation gates the op list.
      throw new ValidationError(`Unhandled op ${m.op}`, { field: 'op', value: m.op });
  }
}

/**
 * Replay a batch of mutations against a state.
 *
 * @param {DailyState} state
 * @param {Mutation[]} mutations
 * @param {{now?: string}} [options]
 * @returns {{state: DailyState, skipped: Array<{mutation: Mutation, reason: string}>}}
 */
export function applyMutations(state, mutations, options = {}) {
  /** @type {Array<{mutation: Mutation, reason: string}>} */
  const skipped = [];
  let next = state;
  for (const m of mutations) {
    const result = applyMutation(next, m);
    if (result.skipped) skipped.push({ mutation: m, reason: result.skipped });
    next = result.state;
  }
  const now = options.now ?? new Date().toISOString();
  return { state: { ...next, version: SCHEMA_VERSION, updatedAt: now }, skipped };
}

/**
 * Parse and sanity-check a remote data.json. Throws rather than returning a
 * half-valid state, because writing a misparsed state back would destroy data.
 * @param {string} json
 * @returns {DailyState}
 */
export function parseState(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new ValidationError(`data.json is not valid JSON: ${cause.message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('data.json must contain an object');
  }
  if (!Array.isArray(raw.tasks)) {
    throw new ValidationError('data.json is missing a tasks array');
  }
  if (raw.version != null && raw.version > SCHEMA_VERSION) {
    // A newer device wrote a schema this build does not understand. Writing our
    // older shape back would silently drop whatever it added.
    throw new ValidationError(
      `data.json is schema version ${raw.version}, but this app understands ${SCHEMA_VERSION}. Update the app before writing.`,
      { field: 'version', value: raw.version },
    );
  }
  return {
    version: raw.version ?? SCHEMA_VERSION,
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    tasks: raw.tasks,
    experiments: Array.isArray(raw.experiments) ? raw.experiments : [],
    projects: Array.isArray(raw.projects) ? raw.projects : [],
  };
}

/**
 * Serialise state for committing. Stable key order and a trailing newline keep
 * git diffs small and readable, which matters because the diffs are the archive.
 * @param {DailyState} state
 * @returns {string}
 */
export function serialiseState(state) {
  const ordered = {
    version: state.version ?? SCHEMA_VERSION,
    updatedAt: state.updatedAt,
    tasks: state.tasks,
    experiments: state.experiments,
    projects: state.projects,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * An in-memory mutation log that survives a reload via injected storage.
 *
 * Append-only from the caller's view. `dropFirst` exists rather than `clear`
 * because mutations can be appended while a flush is in flight — clearing
 * wholesale would discard the user's most recent taps.
 *
 * @param {{storage: {getItem(k: string): string|null, setItem(k: string, v: string): void}, key?: string, onError?: (e: Error) => void}} options
 */
export function createMutationLog(options) {
  const { storage } = options;
  const key = options.key ?? 'daily.mutations.v1';
  const onError = options.onError ?? (() => {});

  /** @type {Mutation[]} */
  let entries = [];

  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Drop only individually-corrupt entries, and report it. Silently
        // discarding the whole queue would lose real work.
        for (const candidate of parsed) {
          try {
            entries.push(assertMutation(candidate));
          } catch (err) {
            onError(
              new ValidationError(
                `Discarded an unreadable queued change: ${err.message}`,
                { value: candidate },
              ),
            );
          }
        }
      }
    }
  } catch (err) {
    onError(new ValidationError(`Could not restore the offline queue: ${err.message}`));
  }

  function persist() {
    try {
      storage.setItem(key, JSON.stringify(entries));
    } catch (err) {
      // Private browsing or a full quota. The caller needs to know the queue is
      // no longer durable, so surface it instead of pretending it saved.
      onError(new Error(`Could not persist the offline queue: ${err.message}`));
    }
  }

  return {
    /** @returns {Mutation[]} A snapshot; mutating it does not affect the log. */
    all: () => entries.slice(),
    size: () => entries.length,
    isEmpty: () => entries.length === 0,

    /** @param {Mutation} m @returns {Mutation} */
    append(m) {
      const valid = assertMutation(m);
      entries.push(valid);
      persist();
      return valid;
    },

    /**
     * Remove the first n entries — the ones just flushed successfully.
     * @param {number} n
     */
    dropFirst(n) {
      if (n <= 0) return;
      entries = entries.slice(n);
      persist();
    },

    /** Drop everything. Only for sign-out. */
    clear() {
      entries = [];
      persist();
    },
  };
}

/**
 * A greppable commit message, per the README's `complete: sow seeds GB005` rule.
 * @param {Mutation[]} mutations
 * @param {DailyState} state State containing the affected tasks (for titles).
 * @returns {string}
 */
export function describeMutations(mutations, state) {
  if (mutations.length === 0) return 'no-op';

  const titleFor = (m) => {
    if (m.op === 'add' && m.payload?.title) return m.payload.title;
    const task = state.tasks.find((t) => t.id === m.id);
    return task?.title ?? m.id;
  };

  if (mutations.length === 1) {
    return `${mutations[0].op}: ${titleFor(mutations[0])}`;
  }

  const counts = new Map();
  for (const m of mutations) counts.set(m.op, (counts.get(m.op) ?? 0) + 1);
  const summary = [...counts.entries()].map(([op, n]) => `${op}×${n}`).join(', ');
  return `${mutations.length} changes (${summary})`;
}

/**
 * Derive a task id from an inbox filename.
 *
 * This is what makes draining idempotent: if the phone and the Mac drain the
 * same capture concurrently, both produce the same task id, and the second
 * `add` is skipped as `already-exists` instead of duplicating the task.
 *
 * @param {string} filename e.g. "inbox/2026-07-31T0814-a3f.json"
 * @returns {string}
 */
export function taskIdFromInboxFilename(filename) {
  const base = String(filename)
    .replace(/^.*\//, '')
    .replace(/\.json$/i, '');
  if (base === '') throw new ValidationError(`Cannot derive a task id from ${filename}`);
  return `t_inbox_${base}`;
}
