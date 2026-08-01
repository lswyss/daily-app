import test from 'node:test';
import assert from 'node:assert/strict';

import { groupForToday } from '../js/views/today.js';
import { dueLabel, metaLine } from '../js/components/taskrow.js';
import { badgeState } from '../js/components/syncbadge.js';
import { seedTask } from './helpers.js';

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

test('an empty list produces empty groups, not undefined', () => {
  const groups = groupForToday([], TODAY);
  assert.deepEqual(groups.overdue, []);
  assert.deepEqual(groups.lab, []);
  assert.equal(groups.laterCount, 0);
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
