/**
 * Test doubles: a recording fetch mock, a memory storage, and manual timers.
 * Nothing here touches the network, the DOM, or the clock.
 */

import { encodeBase64 } from '../js/github.js';

/**
 * Build a Response-like object matching the subset github.js uses.
 * @param {{status?: number, body?: unknown, headers?: Record<string,string>}} spec
 */
export function fakeResponse(spec = {}) {
  const status = spec.status ?? 200;
  const headers = new Map(
    Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const text = spec.body === undefined ? '' : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => text,
  };
}

/**
 * A fetch mock that records every call and delegates to `responder`.
 * @param {(call: {url: string, options: any, index: number}) => any} responder
 */
export function createFetchMock(responder) {
  /** @type {Array<{url: string, method: string, body: any, headers: any}>} */
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    const index = calls.length;
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null,
      headers: options.headers ?? {},
    });
    const result = responder({ url: String(url), options, index });
    if (result instanceof Error) throw result;
    return result;
  };

  return {
    fetch: fetchImpl,
    calls,
    callsMatching: (method) => calls.filter((c) => c.method === method),
    count: () => calls.length,
  };
}

/**
 * The GET-a-file response shape from the contents API.
 * @param {{content: string, sha: string, path?: string}} spec
 */
export function fileResponse({ content, sha, path = 'data.json' }) {
  return fakeResponse({
    body: {
      type: 'file',
      encoding: 'base64',
      // GitHub wraps base64 at 60 chars; include a newline so decoding is
      // exercised the way it really arrives.
      content: encodeBase64(content).replace(/(.{60})/g, '$1\n'),
      sha,
      path,
      size: content.length,
    },
  });
}

/** The PUT-success response shape. */
export function writeResponse(sha = 'newsha') {
  return fakeResponse({
    status: 200,
    body: { content: { sha }, commit: { sha: `commit-${sha}` } },
  });
}

/** A 409 the way GitHub sends it when the SHA is stale. */
export function conflictResponse() {
  return fakeResponse({
    status: 409,
    body: { message: 'data.json does not match 0123456789abcdef' },
  });
}

/** localStorage-compatible in-memory storage. */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get size() {
      return map.size;
    },
    raw: map,
  };
}

/** Storage that refuses to write, to test the not-durable path. */
export function failingStorage(initial = {}) {
  const inner = memoryStorage(initial);
  return {
    getItem: inner.getItem,
    setItem: () => {
      throw new Error('quota exceeded');
    },
    removeItem: inner.removeItem,
  };
}

/** Manually-advanced timers so debounce tests do not sleep. */
export function manualTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => void scheduled.delete(id),
    /** Run every pending callback. */
    runAll() {
      const entries = [...scheduled.values()];
      scheduled.clear();
      for (const { fn } of entries) fn();
      return entries.length;
    },
    pendingCount: () => scheduled.size,
  };
}

/**
 * An ISO timestamp for a given **local** wall-clock time.
 *
 * Use this for `completedAt` in tests. A hardcoded `…T17:00:00Z` names a different
 * local day depending on the machine's timezone, so assertions about "which day
 * was this done on" pass in California and fail in Kiritimati. Building from local
 * time makes the intended day unambiguous everywhere.
 *
 * @param {number} year @param {number} month 1-12 @param {number} day
 * @param {number} [hour] @param {number} [minute]
 */
export function localAt(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

/** A minimal valid data.json body. */
export function seedState(overrides = {}) {
  return {
    version: 1,
    updatedAt: '2026-07-31T00:00:00Z',
    tasks: [],
    experiments: [],
    projects: [],
    ...overrides,
  };
}

/** A valid task, with overrides. */
export function seedTask(overrides = {}) {
  return {
    id: 't_2026-07-31T081200_a3f',
    title: 'Sow seeds for GB005',
    scope: 'lab',
    type: 'task',
    project: 'Globot',
    experiment: 'GB005',
    due: '2026-08-01',
    done: false,
    completedAt: null,
    createdAt: '2026-07-31T08:12:00Z',
    source: 'app',
    notes: '',
    ...overrides,
  };
}
