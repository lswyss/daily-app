import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMutation,
  applyMutations,
  assertMutation,
  createMutationLog,
  describeMutations,
  emptyState,
  isIsoDate,
  mutation,
  normaliseTask,
  parseState,
  serialiseState,
  taskIdFromInboxFilename,
  ValidationError,
  SCHEMA_VERSION,
} from '../js/store.js';

import { memoryStorage, failingStorage, seedTask } from './helpers.js';

const TS = '2026-07-31T09:00:00Z';

function stateWith(...tasks) {
  return { ...emptyState(TS), tasks };
}

// ---------------------------------------------------------------- validation

test('isIsoDate accepts real dates and rejects impossible ones', () => {
  assert.ok(isIsoDate('2026-08-01'));
  assert.ok(isIsoDate('2024-02-29'));
  assert.ok(!isIsoDate('2026-02-30'));
  assert.ok(!isIsoDate('2026-13-01'));
  assert.ok(!isIsoDate('tomorrow'));
  assert.ok(!isIsoDate('2026-08-01T00:00:00Z'));
});

test('normaliseTask fills defaults without inventing content', () => {
  const task = normaliseTask({ id: 't1', title: '  Water plants  ', scope: 'lab' });
  assert.equal(task.title, 'Water plants');
  assert.equal(task.type, 'task');
  assert.equal(task.source, 'app');
  assert.equal(task.done, false);
  assert.equal(task.completedAt, null);
  assert.equal(task.due, null);
  assert.equal(task.project, null);
  assert.equal(task.notes, '');
});

test('normaliseTask requires a title and a scope', () => {
  assert.throws(() => normaliseTask({ id: 't1', scope: 'lab' }), ValidationError);
  assert.throws(() => normaliseTask({ id: 't1', title: 'x' }), /scope must be one of/);
  assert.throws(() => normaliseTask({ id: 't1', title: 'x', scope: 'work' }), /scope must be one of/);
  assert.throws(() => normaliseTask({ title: 'x', scope: 'lab' }), /id is required/);
});

test('normaliseTask refuses relative dates — the store never holds "tomorrow"', () => {
  assert.throws(
    () => normaliseTask({ id: 't1', title: 'x', scope: 'lab', due: 'tomorrow' }),
    /absolute ISO date/,
  );
});

test('assertMutation rejects unknown ops and bad timestamps', () => {
  assert.throws(() => assertMutation({ op: 'archive', id: 't1', ts: TS }), /Unknown op/);
  assert.throws(() => assertMutation({ op: 'complete', id: 't1', ts: 'someday' }), /ISO timestamp/);
  assert.throws(() => assertMutation({ op: 'complete', ts: TS }), /id is required/);
});

test('an add mutation id must match its payload id', () => {
  assert.throws(
    () => mutation('add', 't1', seedTask({ id: 't2' }), TS),
    /must match payload.id/,
  );
});

test('edit may not rewrite identity or provenance fields', () => {
  for (const field of ['id', 'createdAt', 'source']) {
    assert.throws(
      () => mutation('edit', 't1', { [field]: 'tampered' }, TS),
      new RegExp(`edit may not change ${field}`),
    );
  }
});

test('edit and reschedule validate their dates', () => {
  assert.throws(() => mutation('reschedule', 't1', { due: 'friday' }, TS), /ISO date or null/);
  assert.throws(() => mutation('edit', 't1', { due: '2026-02-30' }, TS), /ISO date or null/);
  assert.doesNotThrow(() => mutation('reschedule', 't1', { due: null }, TS));
});

// ------------------------------------------------------------------- reducer

test('add appends a normalised task', () => {
  const { state, skipped } = applyMutation(emptyState(TS), mutation('add', 't1', seedTask({ id: 't1' }), TS));
  assert.equal(skipped, null);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].title, 'Sow seeds for GB005');
});

test('adding the same id twice is a no-op — this is what makes drains idempotent', () => {
  const start = stateWith(seedTask({ id: 't1' }));
  const { state, skipped } = applyMutation(start, mutation('add', 't1', seedTask({ id: 't1' }), TS));
  assert.equal(skipped, 'already-exists');
  assert.equal(state.tasks.length, 1);
  assert.equal(state, start, 'unchanged state should be returned by reference');
});

test('a confirmed tag is registered, so it is never asked about twice', () => {
  const first = applyMutation(
    emptyState(TS),
    mutation('add', 't1', seedTask({ id: 't1', experiment: 'GB005', project: 'Globot' }), TS),
  ).state;

  assert.deepEqual(first.projects, ['Globot']);
  assert.equal(first.experiments.length, 1);
  assert.equal(first.experiments[0].id, 'GB005');
  assert.equal(first.experiments[0].startDate, null, 'unknown until the user says');

  // A second task on the same experiment must not duplicate the registration.
  const second = applyMutation(
    first,
    mutation('add', 't2', seedTask({ id: 't2', experiment: 'GB005', project: 'Globot' }), TS),
  ).state;

  assert.deepEqual(second.projects, ['Globot']);
  assert.equal(second.experiments.length, 1);
});

test('an untagged task registers nothing', () => {
  const { state } = applyMutation(
    emptyState(TS),
    mutation('add', 't1', seedTask({ id: 't1', experiment: null, project: null }), TS),
  );
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.experiments, []);
});

test('complete records when it happened; uncomplete clears it', () => {
  const start = stateWith(seedTask({ id: 't1' }));
  const done = applyMutation(start, mutation('complete', 't1', null, TS)).state;
  assert.equal(done.tasks[0].done, true);
  assert.equal(done.tasks[0].completedAt, TS);

  const undone = applyMutation(done, mutation('uncomplete', 't1', null, TS)).state;
  assert.equal(undone.tasks[0].done, false);
  assert.equal(undone.tasks[0].completedAt, null);
});

test('the reducer never mutates its input', () => {
  const start = stateWith(seedTask({ id: 't1' }));
  const snapshot = JSON.stringify(start);
  applyMutation(start, mutation('complete', 't1', null, TS));
  applyMutation(start, mutation('delete', 't1', null, TS));
  assert.equal(JSON.stringify(start), snapshot);
});

test('reschedule and edit change only what they name', () => {
  const start = stateWith(seedTask({ id: 't1' }));
  const moved = applyMutation(start, mutation('reschedule', 't1', { due: '2026-08-05' }, TS)).state;
  assert.equal(moved.tasks[0].due, '2026-08-05');
  assert.equal(moved.tasks[0].title, 'Sow seeds for GB005');

  const edited = applyMutation(start, mutation('edit', 't1', { notes: 'use 0.7 MPa' }, TS)).state;
  assert.equal(edited.tasks[0].notes, 'use 0.7 MPa');
  assert.equal(edited.tasks[0].createdAt, '2026-07-31T08:12:00Z');
});

test('delete removes the row; git history keeps the record', () => {
  const start = stateWith(seedTask({ id: 't1' }));
  const { state } = applyMutation(start, mutation('delete', 't1', null, TS));
  assert.equal(state.tasks.length, 0);
});

test('an op against a vanished task is reported, never silently dropped', () => {
  const { state, skipped } = applyMutation(emptyState(TS), mutation('complete', 'gone', null, TS));
  assert.equal(skipped, 'task-missing');
  assert.equal(state.tasks.length, 0);
});

test('applyMutations replays in order and stamps updatedAt', () => {
  const { state, skipped } = applyMutations(
    emptyState(TS),
    [
      mutation('add', 't1', seedTask({ id: 't1' }), TS),
      mutation('add', 't2', seedTask({ id: 't2', title: 'Water GB005' }), TS),
      mutation('complete', 't1', null, TS),
      mutation('complete', 'ghost', null, TS),
    ],
    { now: '2026-07-31T10:00:00Z' },
  );

  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].done, true);
  assert.equal(state.tasks[1].done, false);
  assert.equal(state.updatedAt, '2026-07-31T10:00:00Z');
  assert.equal(state.version, SCHEMA_VERSION);
  assert.deepEqual(skipped.map((s) => s.reason), ['task-missing']);
});

// --------------------------------------------------------- parse / serialise

test('parseState rejects unusable data rather than returning a partial state', () => {
  assert.throws(() => parseState('{not json'), /not valid JSON/);
  assert.throws(() => parseState('[]'), /missing a tasks array/);
  assert.throws(() => parseState('{"tasks":"nope"}'), /missing a tasks array/);
});

test('parseState refuses a schema newer than this build understands', () => {
  // Writing our older shape back would silently drop whatever the newer app added.
  assert.throws(
    () => parseState(JSON.stringify({ version: 99, tasks: [] })),
    /schema version 99/,
  );
});

test('parseState tolerates missing optional collections', () => {
  const state = parseState(JSON.stringify({ version: 1, tasks: [] }));
  assert.deepEqual(state.experiments, []);
  assert.deepEqual(state.projects, []);
});

test('serialiseState round-trips and ends with a newline for clean diffs', () => {
  const state = stateWith(seedTask({ id: 't1' }));
  const text = serialiseState(state);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(parseState(text).tasks, state.tasks);
  assert.match(text, /^\{\n  "version": 1,\n  "updatedAt"/);
});

// ------------------------------------------------------------ mutation log

test('the log persists across a reload', () => {
  const storage = memoryStorage();
  const first = createMutationLog({ storage });
  first.append(mutation('add', 't1', seedTask({ id: 't1' }), TS));
  first.append(mutation('complete', 't1', null, TS));

  const restored = createMutationLog({ storage });
  assert.equal(restored.size(), 2);
  assert.equal(restored.all()[1].op, 'complete');
});

test('the log validates on append, so bad ops never reach storage', () => {
  const log = createMutationLog({ storage: memoryStorage() });
  assert.throws(() => log.append({ op: 'nope', id: 't1', ts: TS }), ValidationError);
  assert.equal(log.size(), 0);
});

test('dropFirst removes only the flushed entries', () => {
  const log = createMutationLog({ storage: memoryStorage() });
  log.append(mutation('add', 't1', seedTask({ id: 't1' }), TS));
  log.append(mutation('add', 't2', seedTask({ id: 't2' }), TS));
  log.append(mutation('complete', 't1', null, TS));

  log.dropFirst(2);
  assert.equal(log.size(), 1);
  assert.equal(log.all()[0].op, 'complete');
});

test('all() hands out a copy, so callers cannot corrupt the queue', () => {
  const log = createMutationLog({ storage: memoryStorage() });
  log.append(mutation('add', 't1', seedTask({ id: 't1' }), TS));
  log.all().pop();
  assert.equal(log.size(), 1);
});

test('one corrupt queued entry is reported and skipped, the rest survive', () => {
  const good = mutation('complete', 't1', null, TS);
  const storage = memoryStorage({
    'daily.mutations.v1': JSON.stringify([{ op: 'garbage' }, good]),
  });
  const errors = [];
  const log = createMutationLog({ storage, onError: (e) => errors.push(e) });

  assert.equal(log.size(), 1);
  assert.equal(log.all()[0].op, 'complete');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unreadable queued change/);
});

test('a storage that cannot write reports it instead of pretending to save', () => {
  const errors = [];
  const log = createMutationLog({ storage: failingStorage(), onError: (e) => errors.push(e) });
  log.append(mutation('complete', 't1', null, TS));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Could not persist/);
});

// --------------------------------------------------------------- messages

test('commit messages name the task so git log stays greppable', () => {
  const state = stateWith(seedTask({ id: 't1' }));
  assert.equal(
    describeMutations([mutation('complete', 't1', null, TS)], state),
    'complete: Sow seeds for GB005',
  );
  assert.equal(
    describeMutations([mutation('add', 't9', seedTask({ id: 't9', title: 'Read Zhu 2016' }), TS)], state),
    'add: Read Zhu 2016',
  );
});

test('a batch message summarises the ops it contains', () => {
  const state = stateWith(seedTask({ id: 't1' }), seedTask({ id: 't2' }));
  const message = describeMutations(
    [
      mutation('complete', 't1', null, TS),
      mutation('complete', 't2', null, TS),
      mutation('reschedule', 't1', { due: '2026-08-09' }, TS),
    ],
    state,
  );
  assert.equal(message, '3 changes (complete×2, reschedule×1)');
});

test('inbox filenames map to stable task ids', () => {
  assert.equal(
    taskIdFromInboxFilename('inbox/2026-07-31T0814-a3f.json'),
    't_inbox_2026-07-31T0814-a3f',
  );
  // Same capture, either writer, same id — so a double drain deduplicates.
  assert.equal(
    taskIdFromInboxFilename('2026-07-31T0814-a3f.json'),
    taskIdFromInboxFilename('inbox/2026-07-31T0814-a3f.json'),
  );
});
