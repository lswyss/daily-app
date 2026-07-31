import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubClient } from '../js/github.js';
import { createMutationLog, mutation, parseState } from '../js/store.js';
import {
  MAX_REPLAYS,
  createDebouncer,
  createFlushQueue,
  planInboxDrain,
  pushMutations,
  statusFor,
} from '../js/sync.js';

import {
  createFetchMock,
  fakeResponse,
  fileResponse,
  writeResponse,
  conflictResponse,
  manualTimers,
  memoryStorage,
  seedState,
  seedTask,
} from './helpers.js';

const TS = '2026-07-31T09:00:00Z';
const CONFIG = { token: 'ghp_test', owner: 'lswyss', repo: 'daily-data' };

/**
 * Wire a client + log against a scripted sequence of GET/PUT responses.
 * @param {(call: {method: string, getCount: number, putCount: number}) => any} responder
 */
function harness(responder, { tasks = [] } = {}) {
  let getCount = 0;
  let putCount = 0;
  const mock = createFetchMock(({ options }) => {
    const method = options.method ?? 'GET';
    if (method === 'GET') getCount += 1;
    if (method === 'PUT') putCount += 1;
    return responder({ method, getCount, putCount });
  });

  const client = createGitHubClient({ ...CONFIG, fetch: mock.fetch });
  const log = createMutationLog({ storage: memoryStorage() });
  return {
    client,
    log,
    mock,
    gets: () => mock.calls.filter((c) => c.method === 'GET').length,
    puts: () => mock.calls.filter((c) => c.method === 'PUT').length,
    lastWritten: () => parseState(Buffer.from(mock.calls.at(-1).body.content, 'base64').toString('utf8')),
    seed: () => fileResponse({ content: JSON.stringify(seedState({ tasks })), sha: 'sha-remote' }),
  };
}

// ------------------------------------------------------------- happy path

test('an empty log is a no-op that touches the network zero times', async () => {
  const h = harness(() => {
    throw new Error('should not fetch');
  });
  const result = await pushMutations({ client: h.client, log: h.log });
  assert.equal(result.status, 'noop');
  assert.equal(h.mock.count(), 0);
});

test('a clean flush reads once, writes once, and clears the queue', async () => {
  const h = harness(({ method }) => (method === 'GET' ? h.seed() : writeResponse('sha-next')));

  h.log.append(mutation('add', 't1', seedTask({ id: 't1' }), TS));
  h.log.append(mutation('complete', 't1', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log, now: () => TS });

  assert.equal(result.status, 'synced');
  assert.equal(result.replays, 0);
  assert.equal(result.sha, 'sha-next');
  assert.equal(h.gets(), 1);
  assert.equal(h.puts(), 1);
  assert.equal(h.log.size(), 0, 'confirmed writes are dropped from the queue');

  const written = h.lastWritten();
  assert.equal(written.tasks.length, 1);
  assert.equal(written.tasks[0].done, true);
  assert.equal(written.updatedAt, TS);
});

test('the commit message describes the change', async () => {
  const h = harness(({ method }) => (method === 'GET' ? h.seed() : writeResponse()), {
    tasks: [seedTask({ id: 't1' })],
  });
  h.log.append(mutation('complete', 't1', null, TS));

  await pushMutations({ client: h.client, log: h.log, now: () => TS });
  assert.equal(h.mock.calls.at(-1).body.message, 'complete: Sow seeds for GB005');
});

// --------------------------------------------------- conflict: replay once

test('a rejected write re-reads, replays once, and succeeds against fresh state', async () => {
  // The phone added t_phone while this device was mid-edit. After the 409 we must
  // end up with BOTH that task and our own change.
  const h = harness(({ method, getCount, putCount }) => {
    if (method === 'GET') {
      return getCount === 1
        ? fileResponse({ content: JSON.stringify(seedState({ tasks: [seedTask({ id: 't1' })] })), sha: 'sha-stale' })
        : fileResponse({
            content: JSON.stringify(
              seedState({ tasks: [seedTask({ id: 't1' }), seedTask({ id: 't_phone', title: 'From phone' })] }),
            ),
            sha: 'sha-fresh',
          });
    }
    return putCount === 1 ? conflictResponse() : writeResponse('sha-merged');
  });

  h.log.append(mutation('complete', 't1', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log, now: () => TS });

  assert.equal(result.status, 'synced');
  assert.equal(result.replays, 1, 'exactly one replay');
  assert.equal(h.gets(), 2, 'one initial read plus one re-read');
  assert.equal(h.puts(), 2, 'one rejected write plus one retry');
  assert.equal(h.log.size(), 0);

  // The retry used the fresh sha, not the stale one.
  const retry = h.mock.calls.at(-1);
  assert.equal(retry.body.sha, 'sha-fresh');

  const written = h.lastWritten();
  assert.deepEqual(written.tasks.map((t) => t.id).sort(), ['t1', 't_phone']);
  assert.equal(written.tasks.find((t) => t.id === 't1').done, true, 'our change survived');
  assert.equal(written.tasks.find((t) => t.id === 't_phone').title, 'From phone', 'their change survived');
});

test('a second rejection surfaces a conflict after exactly one replay, and never loops', async () => {
  // This is the phase 2 acceptance test.
  const h = harness(({ method }) => (method === 'GET' ? h.seed() : conflictResponse()), {
    tasks: [seedTask({ id: 't1' })],
  });

  h.log.append(mutation('complete', 't1', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log, now: () => TS });

  assert.equal(result.status, 'conflict');
  assert.equal(result.replays, MAX_REPLAYS);
  assert.equal(result.replays, 1);
  assert.equal(h.puts(), 2, 'the initial write plus exactly one retry — no more');
  assert.equal(h.gets(), 2);
  assert.ok(result.error, 'the conflict error is handed back for the UI');
  assert.equal(h.log.size(), 1, 'the unconfirmed change stays queued — nothing is lost');
  assert.equal(statusFor(result), 'conflict');
});

test('taps made during a flush are not discarded when it succeeds', async () => {
  let latecomer;
  const h = harness(({ method }) => {
    if (method === 'GET') return h.seed();
    // The user taps another task while the PUT is in flight.
    latecomer = mutation('complete', 't2', null, TS);
    h.log.append(latecomer);
    return writeResponse();
  }, { tasks: [seedTask({ id: 't1' }), seedTask({ id: 't2' })] });

  h.log.append(mutation('complete', 't1', null, TS));
  const result = await pushMutations({ client: h.client, log: h.log, now: () => TS });

  assert.equal(result.status, 'synced');
  assert.equal(h.log.size(), 1, 'only the flushed entry was dropped');
  assert.deepEqual(h.log.all()[0], latecomer);
});

// ------------------------------------------------------------ failure modes

test('being offline is reported as offline, with the queue intact', async () => {
  const h = harness(() => new TypeError('Load failed'));
  h.log.append(mutation('complete', 't1', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log });

  assert.equal(result.status, 'offline');
  assert.equal(statusFor(result), 'offline');
  assert.equal(h.log.size(), 1);
});

test('a rate limit is not reported as success', async () => {
  const h = harness(() =>
    fakeResponse({
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0' },
    }),
  );
  h.log.append(mutation('complete', 't1', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log });
  assert.equal(result.status, 'error');
  assert.notEqual(statusFor(result), 'synced');
  assert.equal(h.log.size(), 1);
});

test('a missing data.json is an error, not an excuse to create one', async () => {
  // Auto-creating it would overwrite real data if the read failed for another reason.
  const h = harness(() => fakeResponse({ status: 404, body: { message: 'Not Found' } }));
  h.log.append(mutation('complete', 't1', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log });

  assert.equal(result.status, 'error');
  assert.match(result.error.message, /missing from lswyss\/daily-data/);
  assert.equal(h.puts(), 0, 'nothing was written');
  assert.equal(h.log.size(), 1);
});

test('unparseable remote data aborts the flush instead of overwriting it', async () => {
  const h = harness(({ method }) =>
    method === 'GET' ? fileResponse({ content: '{ truncated', sha: 'sha-bad' }) : writeResponse(),
  );
  h.log.append(mutation('complete', 't1', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log });
  assert.equal(result.status, 'error');
  assert.equal(h.puts(), 0);
  assert.equal(h.log.size(), 1);
});

test('ops against tasks that vanished remotely are surfaced, not swallowed', async () => {
  const h = harness(({ method }) => (method === 'GET' ? h.seed() : writeResponse()));
  h.log.append(mutation('complete', 'deleted-elsewhere', null, TS));

  const result = await pushMutations({ client: h.client, log: h.log, now: () => TS });

  assert.equal(result.status, 'synced');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'task-missing');
});

test('statusFor never reports success for a failure', () => {
  assert.equal(statusFor({ status: 'synced', error: null }), 'synced');
  assert.equal(statusFor({ status: 'noop', error: null }), 'synced');
  for (const status of ['offline', 'conflict', 'error']) {
    assert.notEqual(statusFor({ status, error: new Error('x') }), 'synced');
  }
});

// ---------------------------------------------------------------- debounce

test('rapid changes debounce into a single flush', () => {
  const timers = manualTimers();
  let flushes = 0;
  const debouncer = createDebouncer(() => (flushes += 1), 5000, timers);

  debouncer.schedule();
  debouncer.schedule();
  debouncer.schedule();
  assert.equal(flushes, 0, 'nothing runs until the window closes');
  assert.equal(timers.pendingCount(), 1, 'earlier timers are cancelled');

  timers.runAll();
  assert.equal(flushes, 1);
  assert.equal(debouncer.isPending(), false);
});

test('flushNow bypasses the window — what pagehide needs so taps are not lost', () => {
  const timers = manualTimers();
  let flushes = 0;
  const debouncer = createDebouncer(() => (flushes += 1), 5000, timers);

  debouncer.schedule();
  debouncer.flushNow();
  assert.equal(flushes, 1);
  assert.equal(timers.pendingCount(), 0, 'the pending timer was cancelled, so it cannot double-fire');

  timers.runAll();
  assert.equal(flushes, 1);
});

test('cancel discards a pending flush', () => {
  const timers = manualTimers();
  let flushes = 0;
  const debouncer = createDebouncer(() => (flushes += 1), 5000, timers);
  debouncer.schedule();
  debouncer.cancel();
  timers.runAll();
  assert.equal(flushes, 0);
});

// ------------------------------------------------------------- flush queue

test('overlapping flushes are serialised so two writes cannot share a base sha', async () => {
  let running = 0;
  let maxConcurrent = 0;
  let completed = 0;
  let release;

  const queue = createFlushQueue(async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((resolve) => {
      release = resolve;
    });
    running -= 1;
    completed += 1;
  });

  const first = queue.request();
  queue.request();
  queue.request();

  release();
  await first;
  // Let the coalesced follow-up start, then release it.
  await Promise.resolve();
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(maxConcurrent, 1, 'never two flushes at once');
  assert.equal(completed, 2, 'three requests coalesce into two runs, not three');
});

// ------------------------------------------------------------ inbox drain

test('the drain files clear captures and routes ambiguous ones to review', async () => {
  const files = [
    { name: 'a.json', path: 'inbox/a.json', sha: 's1' },
    { name: 'b.json', path: 'inbox/b.json', sha: 's2' },
    { name: '.gitkeep', path: 'inbox/.gitkeep', sha: 's3' },
  ];
  const captures = {
    'inbox/a.json': { raw: 'water GB005 tomorrow #lab', capturedAt: TS, source: 'shortcut' },
    'inbox/b.json': { raw: 'do the thing with the plates', capturedAt: TS, source: 'shortcut' },
  };

  const plan = await planInboxDrain({
    files,
    readCapture: async (file) => captures[file.path] ?? null,
    interpret: (capture, id) =>
      /GB005/.test(capture.raw)
        ? { task: seedTask({ id, title: capture.raw, source: 'shortcut' }) }
        : { needsReview: 'no-date' },
  });

  assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0].op, 'add');
  assert.equal(plan.mutations[0].id, 't_inbox_a', 'id derives from the filename');
  assert.equal(plan.review.length, 1);
  assert.equal(plan.review[0].reason, 'no-date');
  assert.equal(plan.unreadable.length, 0, '.gitkeep is skipped, not treated as a failed capture');
});

test('an unreadable capture is quarantined rather than losing the whole drain', async () => {
  const files = [
    { name: 'bad.json', path: 'inbox/bad.json', sha: 's1' },
    { name: 'empty.json', path: 'inbox/empty.json', sha: 's2' },
    { name: 'good.json', path: 'inbox/good.json', sha: 's3' },
  ];

  const plan = await planInboxDrain({
    files,
    readCapture: async (file) => {
      if (file.name === 'bad.json') throw new Error('not JSON');
      if (file.name === 'empty.json') return { raw: '   ' };
      return { raw: 'water GB005', capturedAt: TS };
    },
    interpret: (capture, id) => ({ task: seedTask({ id, title: capture.raw }) }),
  });

  assert.equal(plan.unreadable.length, 2);
  assert.equal(plan.mutations.length, 1, 'the good capture still files');
});

test('draining the same capture twice yields the same id, so the add deduplicates', async () => {
  const run = () =>
    planInboxDrain({
      files: [{ name: 'a.json', path: 'inbox/a.json', sha: 's1' }],
      readCapture: async () => ({ raw: 'water GB005', capturedAt: TS }),
      interpret: (capture, id) => ({ task: seedTask({ id, title: capture.raw }) }),
    });

  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.mutations[0].id, second.mutations[0].id);
});
