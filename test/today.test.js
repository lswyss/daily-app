import test from 'node:test';
import assert from 'node:assert/strict';

import { groupForToday, needsConfirmation } from '../js/views/today.js';
import { parseCapture } from '../js/parse.js';
import { dueLabel, dayHeading, metaLine, statusLabel } from '../js/components/taskrow.js';
import { localDateOf } from '../js/parse.js';
import { badgeState } from '../js/components/syncbadge.js';
import { localAt, seedTask } from './helpers.js';

const TODAY = '2026-07-31';

// ------------------------------------------------------------- grouping

test('today means due today or overdue, lab before personal', () => {
  const tasks = [
    seedTask({ id: 'a', due: TODAY, scope: 'lab', createdAt: '2026-07-31T08:00:00Z' }),
    seedTask({ id: 'b', due: TODAY, scope: 'personal', createdAt: '2026-07-31T08:01:00Z' }),
    seedTask({ id: 'c', due: '2026-07-28', scope: 'lab' }),
    seedTask({ id: 'd', due: '2026-08-05', scope: 'lab' }),
  ];

  const groups = groupForToday(tasks, TODAY);

  assert.deepEqual(groups.overdue.map((t) => t.id), ['c']);
  assert.deepEqual(groups.lab.map((t) => t.id), ['a']);
  assert.deepEqual(groups.personal.map((t) => t.id), ['b']);
  assert.equal(groups.laterCount, 1, 'future tasks are counted, not listed');
});

test('overdue is sorted oldest first', () => {
  const tasks = [
    seedTask({ id: 'recent', due: '2026-07-30' }),
    seedTask({ id: 'ancient', due: '2026-07-02' }),
    seedTask({ id: 'middle', due: '2026-07-15' }),
  ];
  assert.deepEqual(
    groupForToday(tasks, TODAY).overdue.map((t) => t.id),
    ['ancient', 'middle', 'recent'],
  );
});

test('completed tasks leave the active groups', () => {
  const tasks = [
    seedTask({ id: 'a', due: TODAY, done: true, completedAt: '2026-07-31T09:00:00Z' }),
    seedTask({ id: 'b', due: TODAY }),
  ];
  const groups = groupForToday(tasks, TODAY);

  assert.deepEqual(groups.lab.map((t) => t.id), ['b']);
  assert.deepEqual(groups.doneToday.map((t) => t.id), ['a'], 'but today\'s stay visible for undo');
});

test('something ticked off in the evening still counts as done today', () => {
  // completedAt is UTC, so a 6:30pm local completion stores tomorrow's date in
  // timezones behind UTC. Slicing it would drop the task out of Done today.
  const evening = localAt(2026, 7, 31, 18, 30);
  const groups = groupForToday(
    [seedTask({ id: 'a', due: TODAY, done: true, completedAt: evening })],
    TODAY,
  );
  assert.deepEqual(groups.doneToday.map((t) => t.id), ['a']);
});

test('localDateOf reports the local day of an instant', () => {
  const evening = localAt(2026, 7, 31, 23, 45);
  assert.equal(localDateOf(evening), '2026-07-31');
  assert.equal(localDateOf(null), null);
  assert.equal(localDateOf('not a date'), null);
});

test('a finished task reports when it was finished, keeping the due date if it slipped', () => {
  const onTime = seedTask({ done: true, due: TODAY, completedAt: localAt(2026, 7, 31, 12) });
  assert.equal(statusLabel(onTime, TODAY), 'done today');

  // Due the 28th, done the 31st: the row must not claim to be overdue, but the
  // slip should still be visible.
  const late = seedTask({ done: true, due: '2026-07-28', completedAt: localAt(2026, 7, 31, 12) });
  const label = statusLabel(late, TODAY);
  assert.match(label, /^done today/);
  assert.match(label, /due Jul 28/);
  assert.doesNotMatch(label, /overdue/);

  const open = seedTask({ done: false, due: '2026-07-28' });
  assert.equal(statusLabel(open, TODAY), '3 days overdue');
});

test('tasks completed on an earlier day are gone entirely', () => {
  const tasks = [seedTask({ id: 'a', due: '2026-07-20', done: true, completedAt: '2026-07-20T09:00:00Z' })];
  const groups = groupForToday(tasks, TODAY);

  assert.equal(groups.doneToday.length, 0);
  assert.equal(groups.overdue.length, 0, 'a completed task is never overdue');
});

test('undated tasks are counted rather than silently invisible', () => {
  const groups = groupForToday([seedTask({ id: 'a', due: null })], TODAY);
  assert.equal(groups.lab.length, 0);
  assert.equal(groups.laterCount, 1);
});

test('future tasks are listed by day, not just counted', () => {
  // Adding something for Sunday and seeing only "3 scheduled later" gives you no
  // way to confirm it exists.
  const tasks = [
    seedTask({ id: 'sun', due: '2026-08-02', createdAt: '2026-07-31T08:00:00Z' }),
    seedTask({ id: 'mon', due: '2026-08-03' }),
    seedTask({ id: 'sun2', due: '2026-08-02', createdAt: '2026-07-31T09:00:00Z' }),
    seedTask({ id: 'today', due: TODAY }),
  ];

  const { upcoming, laterCount } = groupForToday(tasks, TODAY);

  assert.equal(laterCount, 3);
  assert.deepEqual(upcoming.map((d) => d.due), ['2026-08-02', '2026-08-03']);
  assert.deepEqual(upcoming[0].tasks.map((t) => t.id), ['sun', 'sun2'], 'sorted within a day');
});

test('undated tasks sit last in upcoming, under their own heading', () => {
  const tasks = [
    seedTask({ id: 'nodate', due: null }),
    seedTask({ id: 'friday', due: '2026-08-07' }),
  ];
  const { upcoming } = groupForToday(tasks, TODAY);

  assert.deepEqual(upcoming.map((d) => d.due), ['2026-08-07', null]);
  assert.equal(dayHeading(null, TODAY), 'No date');
});

test('completed future tasks do not appear in upcoming', () => {
  const tasks = [
    seedTask({ id: 'a', due: '2026-08-05', done: true, completedAt: '2026-07-31T09:00:00Z' }),
  ];
  const { upcoming, laterCount } = groupForToday(tasks, TODAY);
  assert.deepEqual(upcoming, []);
  assert.equal(laterCount, 0);
});

test('day headings pair the relative word with the actual date', () => {
  assert.match(dayHeading('2026-08-01', TODAY), /^tomorrow · /);
  assert.match(dayHeading('2026-08-02', TODAY), /^Sunday · /);
  // Beyond a week the relative label is already the date, so it is not repeated.
  assert.equal(dayHeading('2026-09-15', TODAY), dueLabel('2026-09-15', TODAY));
});

test('an empty list produces empty groups, not undefined', () => {
  const groups = groupForToday([], TODAY);
  assert.deepEqual(groups.overdue, []);
  assert.deepEqual(groups.lab, []);
  assert.equal(groups.laterCount, 0);
});

// ------------------------------------------------------ confirm-or-not

const parse = (text, extra = {}) => parseCapture(text, { today: TODAY, ...extra });

test('an ordinary capture files immediately — no confirm step', () => {
  assert.equal(needsConfirmation(parse('order more petri dishes'), TODAY), null);
  assert.equal(needsConfirmation(parse('email Jose tomorrow'), TODAY), null);
  assert.equal(needsConfirmation(parse('dentist tuesday #personal'), TODAY), null);
});

test('a missing date is not a reason to stop the user', () => {
  const parsed = parse('order more petri dishes');
  assert.equal(parsed.dueAssumed, true, 'today was assumed');
  assert.equal(needsConfirmation(parsed, TODAY), null, 'but that alone must not prompt');
});

test('an already-known tag files immediately', () => {
  const parsed = parse('water GB005 tomorrow', { experiments: ['GB005'] });
  assert.equal(parsed.experiment.status, 'known');
  assert.equal(needsConfirmation(parsed, TODAY), null);
});

test('an unrecognised or near-miss code still stops for confirmation', () => {
  assert.equal(needsConfirmation(parse('water GB005 tomorrow'), TODAY), 'experiment');
  assert.equal(
    needsConfirmation(parse('move e012 plates', { experiments: ['E0013_PegTreatment'] }), TODAY),
    'experiment',
  );
});

test('an empty title or a past date stops too', () => {
  assert.equal(needsConfirmation(parse('tomorrow'), TODAY), 'no-title');
  assert.equal(needsConfirmation(parse('logged the harvest yesterday'), TODAY), 'past-date');
});

// ---------------------------------------------------------------- labels

test('due dates read the way a person would say them', () => {
  assert.equal(dueLabel(TODAY, TODAY), 'today');
  assert.equal(dueLabel('2026-08-01', TODAY), 'tomorrow');
  assert.equal(dueLabel('2026-07-30', TODAY), 'yesterday');
  assert.equal(dueLabel('2026-07-25', TODAY), '6 days overdue');
  assert.equal(dueLabel(null, TODAY), 'no date');
});

test('dates within the week show the weekday', () => {
  // 2026-08-03 is a Monday.
  assert.match(dueLabel('2026-08-03', TODAY), /Monday/);
});

test('the metadata line omits what is absent', () => {
  assert.equal(
    metaLine(seedTask({ project: 'Globot', experiment: 'GB005', due: TODAY }), TODAY),
    'Globot · GB005 · today',
  );
  assert.equal(
    metaLine(seedTask({ project: null, experiment: null, due: TODAY }), TODAY),
    'today',
  );
});

// ------------------------------------------------------------ sync badge

test('the badge only says synced when nothing is queued', () => {
  assert.equal(badgeState({ status: 'synced', pending: 0 }).state, 'synced');
  assert.equal(
    badgeState({ status: 'synced', pending: 2 }).state,
    'unsaved',
    'a confirmed write plus a fresh tap is not "synced"',
  );
});

test('failure states outrank the queue count and never read as success', () => {
  for (const status of ['syncing', 'offline', 'conflict', 'error']) {
    const badge = badgeState({ status, pending: 3 });
    assert.equal(badge.state, status);
    assert.notEqual(badge.label, 'Synced');
  }
});

test('the conflict badge says where the changes actually are', () => {
  const badge = badgeState({ status: 'conflict', pending: 1 });
  assert.match(badge.detail, /still saved on this device/);
});

test('counts are pluralised', () => {
  assert.match(badgeState({ status: 'synced', pending: 1 }).detail, /1 change /);
  assert.match(badgeState({ status: 'synced', pending: 2 }).detail, /2 changes /);
});
