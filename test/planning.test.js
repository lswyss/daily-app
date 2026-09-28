import test from 'node:test';
import assert from 'node:assert/strict';

import { applyMutation, emptyState, mutation, normaliseTask, ValidationError } from '../js/store.js';
import { isRepeat, nextDue, occurrenceId, repeatLabel } from '../js/repeat.js';
import { findRepeat, localDateOf, parseCapture, timestampOn, toTask } from '../js/parse.js';
import { groupForToday, needsConfirmation } from '../js/views/today.js';
import { weekAgenda } from '../js/components/weekplanner.js';
import { quickDates } from '../js/components/taskeditor.js';
import { localAt, seedTask } from './helpers.js';

const MON = '2026-09-28';

const withTasks = (...tasks) => ({ ...emptyState('2026-09-28T00:00:00Z'), tasks });

// ---------------------------------------------------------------- repeat

test('next occurrence keeps the rhythm of the due date, not the day it was done', () => {
  const weekly = { due: MON, repeat: { every: 1, unit: 'week' } };
  assert.equal(nextDue(weekly, MON), '2026-10-05', 'done on the day');
  assert.equal(nextDue(weekly, '2026-09-30'), '2026-10-05', 'done two days late, still Monday');
  assert.equal(nextDue(weekly, '2026-09-26'), '2026-10-05', 'done early');
});

test('missed occurrences are skipped, not stacked up as overdue', () => {
  const weekly = { due: '2026-09-07', repeat: { every: 1, unit: 'week' } };
  assert.equal(nextDue(weekly, MON), '2026-10-05');
  const fortnightly = { due: '2026-09-07', repeat: { every: 2, unit: 'week' } };
  assert.equal(nextDue(fortnightly, MON), '2026-10-05');
  assert.equal(nextDue(fortnightly, '2026-09-20'), '2026-09-21');
});

test('an undated repeating task counts from the day it was done', () => {
  assert.equal(nextDue({ due: null, repeat: { every: 3, unit: 'day' } }, MON), '2026-10-01');
});

test('occurrence ids stay stable across the series', () => {
  assert.equal(occurrenceId('t_abc', '2026-10-05'), 't_abc~2026-10-05');
  assert.equal(occurrenceId('t_abc~2026-10-05', '2026-10-12'), 't_abc~2026-10-12');
});

test('repeat rules are validated and labelled', () => {
  assert.ok(isRepeat({ every: 2, unit: 'week' }));
  assert.ok(!isRepeat({ every: 0, unit: 'week' }));
  assert.ok(!isRepeat({ every: 1, unit: 'month' }));
  assert.equal(repeatLabel({ every: 1, unit: 'week' }), 'weekly');
  assert.equal(repeatLabel({ every: 2, unit: 'week' }), 'every 2 weeks');
  assert.throws(() => normaliseTask(seedTask({ repeat: { every: 'x', unit: 'week' } })), ValidationError);
});

test('a task that never repeats keeps its old shape', () => {
  assert.ok(!('repeat' in normaliseTask(seedTask({}))));
});

// ------------------------------------------------------ store: completing

test('completing a repeating task creates the next occurrence, once', () => {
  const task = seedTask({ id: 't1', due: MON, repeat: { every: 2, unit: 'week' } });
  const done = mutation('complete', 't1', null, localAt(2026, 9, 28, 15));
  let { state } = applyMutation(withTasks(task), done);

  const next = state.tasks.find((t) => t.id === 't1~2026-10-12');
  assert.ok(next, 'next occurrence exists');
  assert.equal(next.done, false);
  assert.deepEqual(next.repeat, { every: 2, unit: 'week' });
  assert.equal(state.tasks.length, 2);

  // A replay of the same completion must not add a third.
  ({ state } = applyMutation(state, done));
  assert.equal(state.tasks.length, 2);
});

test('undoing a completion takes back the occurrence it created', () => {
  const task = seedTask({ id: 't1', due: MON, repeat: { every: 1, unit: 'week' } });
  let { state } = applyMutation(withTasks(task), mutation('complete', 't1', null, localAt(2026, 9, 28, 15)));
  assert.equal(state.tasks.length, 2);
  ({ state } = applyMutation(state, mutation('uncomplete', 't1')));
  assert.deepEqual(state.tasks.map((t) => t.id), ['t1']);
  assert.equal(state.tasks[0].done, false);
});

test('a backdated completion lands on the chosen day', () => {
  const task = seedTask({ id: 't1', due: '2026-09-24' });
  const { state } = applyMutation(
    withTasks(task),
    mutation('complete', 't1', { completedAt: localAt(2026, 9, 24, 12) }, localAt(2026, 9, 28, 9)),
  );
  assert.equal(localDateOf(state.tasks[0].completedAt), '2026-09-24');
});

test('re-dating a finished repeating task does not spawn another occurrence', () => {
  const task = seedTask({ id: 't1', due: '2026-09-21', repeat: { every: 1, unit: 'week' } });
  let { state } = applyMutation(withTasks(task), mutation('complete', 't1', null, localAt(2026, 9, 28, 9)));
  assert.equal(state.tasks.length, 2);
  ({ state } = applyMutation(
    state,
    mutation('complete', 't1', { completedAt: localAt(2026, 9, 21, 12) }, localAt(2026, 9, 28, 9, 1)),
  ));
  assert.equal(state.tasks.length, 2);
  assert.equal(localDateOf(state.tasks[0].completedAt), '2026-09-21');
});

test('a completion date that is not a timestamp is refused', () => {
  assert.throws(() => mutation('complete', 't1', { completedAt: 'last tuesday' }), ValidationError);
});

test('repeat can be set and cleared by edit, and bad rules are refused', () => {
  const task = seedTask({ id: 't1', due: MON });
  let { state } = applyMutation(withTasks(task), mutation('edit', 't1', { repeat: { every: 1, unit: 'week' } }));
  assert.deepEqual(state.tasks[0].repeat, { every: 1, unit: 'week' });
  ({ state } = applyMutation(state, mutation('edit', 't1', { repeat: null })));
  assert.equal(state.tasks[0].repeat, null);
  assert.throws(() => mutation('edit', 't1', { repeat: { every: 1, unit: 'fortnight' } }), ValidationError);
});

test('timestampOn round-trips through localDateOf', () => {
  for (const day of ['2026-09-24', '2026-03-08', '2026-11-01', '2026-12-31']) {
    assert.equal(localDateOf(timestampOn(day, new Date(2027, 0, 5, 9))), day);
  }
  const now = new Date(2026, 8, 28, 18, 30);
  assert.equal(timestampOn('2026-09-28', now), now.toISOString(), 'today keeps the real time');
});

// --------------------------------------------------------------- parsing

test('repeat phrases are understood and removed from the title', () => {
  const cases = [
    ['water plants every week', 'Water plants', { every: 1, unit: 'week' }, MON],
    ['check plates every 2 weeks', 'Check plates', { every: 2, unit: 'week' }, MON],
    ['check plates every other week', 'Check plates', { every: 2, unit: 'week' }, MON],
    ['journal club biweekly', 'Journal club', { every: 2, unit: 'week' }, MON],
    ['take meds daily', 'Take meds', { every: 1, unit: 'day' }, MON],
    ['lab meeting every wednesday', 'Lab meeting', { every: 1, unit: 'week' }, '2026-09-30'],
    ['repot every other friday', 'Repot', { every: 2, unit: 'week' }, '2026-10-02'],
  ];
  for (const [raw, title, repeat, due] of cases) {
    const parsed = parseCapture(raw, { today: MON });
    assert.equal(parsed.title, title, raw);
    assert.deepEqual(parsed.repeat, repeat, raw);
    assert.equal(parsed.due, due, raw);
  }
});

test('no repeat phrase means no repeat', () => {
  assert.equal(findRepeat('sow seeds GB005 tomorrow'), null);
  assert.ok(!('repeat' in toTask(parseCapture('sow seeds', { today: MON }), { id: 'x' })));
});

test('ideas never pick up a repeat', () => {
  assert.equal(parseCapture('idea weekly check-ins with Ana', { today: MON }).repeat, null);
});

// ------------------------------------------------------- week planning

test('a day box may file into the past without asking', () => {
  const parsed = { ...parseCapture('scan plates', { today: MON }), due: '2026-09-25', dueAssumed: false };
  assert.equal(needsConfirmation(parsed, MON), 'past-date');
  assert.equal(needsConfirmation(parsed, MON, { allowPast: true }), null);
});

test('the week shows open tasks on their date and finished ones on the day they were done', () => {
  const tasks = [
    seedTask({ id: 'open', due: '2026-10-01' }),
    seedTask({ id: 'done', due: '2026-09-20', done: true, completedAt: localAt(2026, 9, 29, 20) }),
    seedTask({ id: 'idea', type: 'idea', due: null, done: true, completedAt: localAt(2026, 9, 29, 10) }),
    seedTask({ id: 'next', due: '2026-10-06' }),
  ];
  const days = weekAgenda(tasks, MON);
  assert.equal(days.length, 7);
  assert.deepEqual(days[1].tasks.map((t) => t.id), ['done']);
  assert.deepEqual(days[3].tasks.map((t) => t.id), ['open']);
  assert.ok(!days.some((d) => d.all.some((t) => t.id === 'idea' || t.id === 'next')));
});

test('tasks already shown higher up are counted, not listed twice', () => {
  const tasks = [seedTask({ id: 'a', due: MON }), seedTask({ id: 'b', due: MON })];
  const [monday] = weekAgenda(tasks, MON, new Set(['a']));
  assert.deepEqual(monday.tasks.map((t) => t.id), ['b']);
  assert.equal(monday.aboveCount, 1);
});

test('Later skips what the week planner already shows', () => {
  const tasks = [
    seedTask({ id: 'thisweek', due: '2026-10-01' }),
    seedTask({ id: 'nextweek', due: '2026-10-07' }),
    seedTask({ id: 'undated', due: null }),
  ];
  const { upcoming, laterCount } = groupForToday(tasks, MON, { laterAfter: '2026-10-04' });
  assert.deepEqual(upcoming.flatMap((d) => d.tasks.map((t) => t.id)), ['nextweek', 'undated']);
  assert.equal(laterCount, 2);
});

test('quick dates push the current date and drop no-op choices', () => {
  const chips = quickDates('2026-10-01', MON);
  const byLabel = Object.fromEntries(chips.map((c) => [c.label, c.value]));
  assert.equal(byLabel['+1 day'], '2026-10-02');
  assert.equal(byLabel['+1 week'], '2026-10-08');
  assert.equal(byLabel.Today, MON);
  assert.equal(byLabel['Next Mon'], '2026-10-05', 'on a Monday, next Monday is a week out');

  const dueToday = quickDates(MON, MON).map((c) => c.label);
  assert.ok(!dueToday.includes('Today'), 'no chip that would not move it');
  assert.ok(!dueToday.includes('+1 day'), 'no duplicate of Tomorrow');
});
