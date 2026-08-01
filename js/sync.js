/**
 * Sync: debounced flushing, conflict detection, and the retry-once replay.
 *
 * The pure parts here take an injected client and timers, so everything below is
 * testable under `node --test` with no DOM.
 *
 * The one rule this module exists to enforce: **never silently resolve a data
 * conflict.** On a rejected write we re-read, replay the pending operations
 * against fresh state, and retry exactly once. If that also fails, we return a
 * conflict status and keep the queue intact so the UI can show it. We never loop,
 * and we never drop a mutation we did not confirm landed.
 *
 * @module sync
 */

import { ConflictError, NetworkError, RateLimitError } from './github.js';
import {
  applyMutations,
  describeMutations,
  parseState,
  serialiseState,
  taskIdFromInboxFilename,
  mutation,
} from './store.js';

/** Retry budget after a rejected write. One. Deliberately not configurable upward. */
export const MAX_REPLAYS = 1;

/** Debounce window: batch rapid taps into a single commit. */
export const FLUSH_DEBOUNCE_MS = 5000;

/**
 * @typedef {'synced'|'syncing'|'offline'|'conflict'|'error'} SyncStatus
 */

/**
 * @typedef {object} PushResult
 * @property {'noop'|'synced'|'conflict'|'offline'|'error'} status
 * @property {number} replays        How many times we re-read and replayed. 0 or 1.
 * @property {string|null} sha       New blob SHA on success.
 * @property {Array<{mutation: any, reason: string}>} skipped
 * @property {Error|null} error
 * @property {import('./store.js').DailyState|null} state The state actually written.
 */

/**
 * Flush the pending mutation log to `data.json`.
 *
 * On success the flushed entries are dropped from the log. On conflict or any
 * other failure the log is left untouched, so nothing is lost and a later flush
 * retries. That asymmetry is the whole safety property.
 *
 * @param {object} args
 * @param {ReturnType<import('./github.js').createGitHubClient>} args.client
 * @param {ReturnType<import('./store.js').createMutationLog>} args.log
 * @param {string} [args.path]
 * @param {() => string} [args.now]
 * @returns {Promise<PushResult>}
 */
export async function pushMutations({ client, log, path = 'data.json', now = () => new Date().toISOString() }) {
  /** @type {PushResult} */
  const base = { status: 'noop', replays: 0, sha: null, skipped: [], error: null, state: null };

  const pending = log.all();
  if (pending.length === 0) return base;

  let replays = 0;

  try {
    let remote = await readState(client, path);

    // Bounded loop: at most 1 + MAX_REPLAYS write attempts. Cannot spin.
    for (;;) {
      const { state, skipped } = applyMutations(remote.state, pending, { now: now() });
      const message = describeMutations(pending, state);

      try {
        const written = await client.writeFile({
          path,
          content: serialiseState(state),
          sha: remote.sha,
          message,
        });
        // Only now is it safe to forget these. Anything appended during the
        // await stays queued, which is why this is dropFirst and not clear.
        log.dropFirst(pending.length);
        // Hand back what was actually written. After a replay this contains the
        // other device's changes too, so the caller must adopt it rather than
        // keep rendering its own optimistic copy.
        return { status: 'synced', replays, sha: written.sha ?? null, skipped, error: null, state };
      } catch (err) {
        if (!(err instanceof ConflictError) || replays >= MAX_REPLAYS) {
          if (err instanceof ConflictError) {
            // Two rejections in a row. Something else is writing actively.
            // Surface it; do not keep trying.
            return { status: 'conflict', replays, sha: null, skipped, error: err, state: null };
          }
          throw err;
        }
        replays += 1;
        remote = await readState(client, path);
      }
    }
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ...base, status: 'offline', replays, error: err };
    }
    return { ...base, status: 'error', replays, error: /** @type {Error} */ (err) };
  }
}

/**
 * Read and parse remote state. Throws if `data.json` is missing, because
 * inventing an empty one here would overwrite the real file on the next write.
 * @param {ReturnType<import('./github.js').createGitHubClient>} client
 * @param {string} path
 */
async function readState(client, path) {
  const file = await client.readFile(path);
  if (file === null) {
    throw new Error(
      `${path} is missing from ${client.owner}/${client.repo}. Refusing to create it automatically — ` +
        'that would overwrite real data if the read failed for another reason.',
    );
  }
  return { state: parseState(file.content), sha: file.sha };
}

/**
 * Drain the capture inbox into `data.json`.
 *
 * Split into two halves so the decision-making is pure and testable: this
 * function classifies captures into ready-to-file mutations and a review queue,
 * and leaves the actual writing and deleting to the caller.
 *
 * Anything ambiguous goes to review rather than being guessed at. iOS dictation
 * will mangle construct codes like GB005, so confirm-before-file is not optional.
 *
 * @param {object} args
 * @param {Array<{path: string, sha: string, name: string}>} args.files
 * @param {(file: {path: string, sha: string, name: string}) => Promise<{raw: string, capturedAt?: string, source?: string}|null>} args.readCapture
 * @param {(capture: {raw: string, capturedAt?: string, source?: string}, id: string) => {task?: any, needsReview?: string}} args.interpret
 * @returns {Promise<{mutations: any[], review: Array<{file: any, capture: any, reason: string}>, unreadable: Array<{file: any, error: Error}>}>}
 */
export async function planInboxDrain({ files, readCapture, interpret }) {
  /** @type {any[]} */
  const mutations = [];
  /** @type {Array<{file: any, capture: any, reason: string}>} */
  const review = [];
  /** @type {Array<{file: any, error: Error}>} */
  const unreadable = [];

  for (const file of files) {
    if (!file.name.endsWith('.json')) continue;
    let capture;
    try {
      capture = await readCapture(file);
    } catch (err) {
      unreadable.push({ file, error: /** @type {Error} */ (err) });
      continue;
    }
    if (!capture || typeof capture.raw !== 'string' || capture.raw.trim() === '') {
      unreadable.push({ file, error: new Error('Capture has no raw text') });
      continue;
    }

    const id = taskIdFromInboxFilename(file.path);
    const verdict = interpret(capture, id);

    if (verdict.needsReview || !verdict.task) {
      review.push({ file, capture, reason: verdict.needsReview ?? 'could-not-parse' });
      continue;
    }
    mutations.push(
      mutation('add', id, verdict.task, capture.capturedAt ?? new Date().toISOString()),
    );
  }

  return { mutations, review, unreadable };
}

/**
 * Debounce a flush, with injectable timers for tests.
 *
 * `schedule` resets the window; `flushNow` cancels it and runs immediately —
 * that is what `visibilitychange`→hidden and `pagehide` call, so closing the tab
 * does not lose the last few taps.
 *
 * @param {() => any} fn
 * @param {number} [waitMs]
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [timers]
 */
export function createDebouncer(fn, waitMs = FLUSH_DEBOUNCE_MS, timers = {}) {
  const setT = timers.setTimeout ?? globalThis.setTimeout;
  const clearT = timers.clearTimeout ?? globalThis.clearTimeout;

  /** @type {any} */
  let handle = null;

  function cancel() {
    if (handle !== null) {
      clearT(handle);
      handle = null;
    }
  }

  return {
    schedule() {
      cancel();
      handle = setT(() => {
        handle = null;
        fn();
      }, waitMs);
    },
    flushNow() {
      cancel();
      return fn();
    },
    cancel,
    isPending: () => handle !== null,
  };
}

/**
 * Serialise flushes so two overlapping calls cannot both write with the same
 * base SHA — that would manufacture the exact conflict we are trying to avoid.
 * A second call while one is in flight is coalesced into one follow-up run.
 *
 * @param {() => Promise<any>} flush
 */
export function createFlushQueue(flush) {
  /** @type {Promise<any>|null} */
  let running = null;
  let queued = false;

  async function run() {
    try {
      return await flush();
    } finally {
      running = null;
      if (queued) {
        queued = false;
        // Chain rather than recurse so the queue depth stays 1.
        running = run();
      }
    }
  }

  return {
    request() {
      if (running) {
        queued = true;
        return running;
      }
      running = run();
      return running;
    },
    isRunning: () => running !== null,
  };
}

/**
 * Map a push result to the badge state. Never returns 'synced' for anything that
 * did not actually land — a stale "synced" badge is the worst failure this app
 * can have.
 *
 * @param {PushResult} result
 * @returns {SyncStatus}
 */
export function statusFor(result) {
  switch (result.status) {
    case 'synced':
      return 'synced';
    case 'noop':
      return 'synced';
    case 'offline':
      return 'offline';
    case 'conflict':
      return 'conflict';
    default:
      return result.error instanceof RateLimitError ? 'offline' : 'error';
  }
}
