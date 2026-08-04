import test from 'node:test';
import assert from 'node:assert/strict';

import { groupIdeas } from '../js/views/ideas.js';
import { groupForToday } from '../js/views/today.js';
import { parseCapture, toTask } from '../js/parse.js';
import { applyMutation, emptyState, mutation, ValidationError } from '../js/store.js';
import { bucketByDate } from '../js/calendar.js';
import { seedTask } from './helpers.js';

const TODAY = '2026-08-04';
const ctx = (extra = {}) => ({ today: TODAY, ...extra });
const idea = (over = {}) => seedTask({ type: 'idea', due: null, ...over });

// ----------------------------------------------------------- capturing

test('a spoken "idea ..." becomes an idea with no date', () => {
  // Dictation will never produce "#idea".
  for (const phrase of ['idea try a shallower PEG gradient', 'idea: try a shallower PEG gradient', 'thought - try a shallower gradient']) {
    const parsed = parseCapture(phrase, ctx());
    assert.equal(parsed.type, 'idea', phrase);
    assert.equal(parsed.due, null, 'ideas carry no date');
    assert.equal(parsed.dueAssumed, false, 'and today was not assumed');
    assert.doesNotMatch(parsed.title, /^idea|^thought/i, 'the keyword is stripped');
  }
});

test('#idea still works for typing', () => {
  const parsed = parseCapture('shallower PEG gradient #idea', ctx());
  assert.equal(parsed.type, 'idea');
  assert.equal(parsed.due, null);
});

test('a date inside an idea is left in the text rather than parsed away', () => {
  // Silently dropping "on monday" would lose part of the thought.
  const parsed = parseCapture('idea try the PEG series on monday', ctx());
  assert.equal(parsed.due, null);
  assert.match(parsed.title, /monday/i);
  assert.equal(parsed.matched.date, null);
});

test('forceType keeps the date in the text, not just off the task', () => {
  // The Ideas screen forces the type. If that happened after parsing, "on monday"
  // would already have been cut out of the title — losing part of the thought.
  const parsed = parseCapture('try the PEG series on monday', ctx({ forceType: 'idea' }));
  assert.equal(parsed.type, 'idea');
  assert.equal(parsed.due, null);
  assert.match(parsed.title, /on monday/i);
  assert.equal(parsed.matched.date, null, 'no date was consumed');
});

test('forceType still strips a spoken keyword', () => {
  const parsed = parseCapture('idea try a shallower gradient', ctx({ forceType: 'idea' }));
  assert.equal(parsed.title, 'Try a shallower gradient');
});

test('an ordinary task is unaffected by any of this', () => {
  const parsed = parseCapture('water GB005 tomorrow', ctx());
  assert.equal(parsed.type, 'task');
  assert.equal(parsed.due, '2026-08-05');
});

test('"ideas" as an ordinary word does not hijack the capture', () => {
  const parsed = parseCapture('ideation meeting friday', ctx());
  assert.equal(parsed.type, 'task', 'only a whole word "idea" counts');
});

test('an idea never blocks on an unknown code', () => {
  // Confirming a tag defeats the point of capturing a thought in five seconds.
  const parsed = parseCapture('idea try GB009 with less PEG', ctx({ experiments: ['GB005'] }));
  const task = toTask(parsed, { id: 'i1' });
  assert.equal(task.experiment, null, 'nothing is attached without confirmation');
  assert.match(task.title, /GB009/, 'but the code stays in the text');
});

// ------------------------------------------------------------ grouping

test('ideas are kept out of Today entirely', () => {
  const tasks = [
    idea({ id: 'i1', title: 'Shallower gradient' }),
    idea({ id: 'i2', title: 'Ask about the scanner', due: TODAY }),
    seedTask({ id: 't1', due: TODAY }),
  ];

  const groups = groupForToday(tasks, TODAY);

  assert.deepEqual(groups.lab.map((t) => t.id), ['t1']);
  assert.equal(groups.laterCount, 0, 'not even in the undated count');
  assert.deepEqual(groups.upcoming, [], 'and not under "No date"');
});

test('an idea with a stray date is still not shown as due', () => {
  const groups = groupForToday([idea({ id: 'i', due: '2026-08-10' })], TODAY);
  assert.equal(groups.laterCount, 0);
});

test('ideas separate into open and archived, newest first', () => {
  const tasks = [
    idea({ id: 'old', createdAt: '2026-08-01T08:00:00Z' }),
    idea({ id: 'new', createdAt: '2026-08-04T08:00:00Z' }),
    idea({ id: 'gone', done: true, completedAt: '2026-08-03T08:00:00Z' }),
    seedTask({ id: 'task' }),
  ];

  const { open, archived } = groupIdeas(tasks);

  assert.deepEqual(open.map((t) => t.id), ['new', 'old']);
  assert.deepEqual(archived.map((t) => t.id), ['gone']);
});

test('an empty list gives empty groups', () => {
  assert.deepEqual(groupIdeas([]), { open: [], archived: [] });
});

// ----------------------------------------------------------- promoting

test('promoting an idea makes it a dated task', () => {
  const start = { ...emptyState(TODAY), tasks: [idea({ id: 'i1', title: 'Shallower gradient' })] };

  const typed = applyMutation(start, mutation('edit', 'i1', { type: 'task' }, `${TODAY}T09:00:00Z`)).state;
  const dated = applyMutation(typed, mutation('reschedule', 'i1', { due: TODAY }, `${TODAY}T09:00:00Z`)).state;

  assert.equal(dated.tasks[0].type, 'task');
  assert.equal(dated.tasks[0].due, TODAY);
  // It should now be visible in Today, which is the whole point.
  assert.deepEqual(groupForToday(dated.tasks, TODAY).lab.map((t) => t.id), ['i1']);
  assert.deepEqual(groupIdeas(dated.tasks).open, [], 'and gone from Ideas');
});

test('an invalid type is refused rather than written', () => {
  assert.throws(() => mutation('edit', 'i1', { type: 'notathing' }), ValidationError);
});

test('archiving an idea keeps it, marked done', () => {
  const start = { ...emptyState(TODAY), tasks: [idea({ id: 'i1' })] };
  const { state } = applyMutation(start, mutation('complete', 'i1', null, `${TODAY}T09:00:00Z`));

  assert.equal(state.tasks.length, 1, 'never deleted');
  assert.equal(state.tasks[0].done, true);
  assert.deepEqual(groupIdeas(state.tasks).archived.map((t) => t.id), ['i1']);
});

// ------------------------------------------------------------ calendar

test('an undated idea does not clutter the calendar grid', () => {
  const { byDate, undated } = bucketByDate([idea({ id: 'i1' }), seedTask({ id: 't1', due: TODAY })]);
  assert.deepEqual([...byDate.keys()], [TODAY]);
  assert.deepEqual(undated.map((t) => t.id), ['i1'], 'it shows under "No date" instead');
});
