import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  classifyTag,
  daysBetween,
  editDistance,
  findDate,
  newTaskId,
  parseCapture,
  toTask,
  todayIso,
  weekdayOf,
} from '../js/parse.js';

// 2026-07-31 is a Friday.
const TODAY = '2026-07-31';
const ctx = (extra = {}) => ({ today: TODAY, ...extra });

// ------------------------------------------------------------- date maths

test('addDays crosses months and years without drifting', () => {
  assert.equal(addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-08', -1), '2026-03-07', 'a US DST boundary must not shift the date');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
});

test('weekdayOf and daysBetween agree with the calendar', () => {
  assert.equal(weekdayOf('2026-07-31'), 5, '2026-07-31 is a Friday');
  assert.equal(daysBetween('2026-07-31', '2026-08-03'), 3);
  assert.equal(daysBetween('2026-08-03', '2026-07-31'), -3);
});

test('todayIso uses the local date, not UTC', () => {
  // 23:30 local on the 31st is already the 1st in UTC; "today" must stay the 31st.
  const lateEvening = new Date(2026, 6, 31, 23, 30, 0);
  assert.equal(todayIso(lateEvening), '2026-07-31');
});

// ------------------------------------------------------------ date phrases

test('the everyday relative words resolve', () => {
  assert.equal(findDate('water plants today', TODAY).due, TODAY);
  assert.equal(findDate('water plants tomorrow', TODAY).due, '2026-08-01');
  assert.equal(findDate('sow seeds tonight', TODAY).due, TODAY);
  assert.equal(findDate('logged yesterday', TODAY).due, '2026-07-30');
  assert.equal(findDate('harvest day after tomorrow', TODAY).due, '2026-08-02');
});

test('dictation misspellings of tomorrow still land', () => {
  for (const word of ['tomorow', 'tommorow', 'tmrw', 'tmw']) {
    assert.equal(findDate(`sow seeds ${word}`, TODAY).due, '2026-08-01', word);
  }
});

test('durations resolve', () => {
  assert.equal(findDate('check in 3 days', TODAY).due, '2026-08-03');
  assert.equal(findDate('check in a week', TODAY).due, '2026-08-07');
  assert.equal(findDate('check in 2 weeks', TODAY).due, '2026-08-14');
  assert.equal(findDate('check next week', TODAY).due, '2026-08-07');
});

test('a bare weekday means the coming one, and today counts', () => {
  // Today is Friday.
  assert.equal(findDate('meeting monday', TODAY).due, '2026-08-03');
  assert.equal(findDate('meeting friday', TODAY).due, TODAY, 'today is Friday');
  assert.equal(findDate('meeting on sunday', TODAY).due, '2026-08-02');
  assert.equal(findDate('meeting weds', TODAY).due, '2026-08-05');
});

test('"next friday" skips the Friday that is today', () => {
  assert.equal(findDate('meeting next friday', TODAY).due, '2026-08-07');
  assert.equal(findDate('meeting next monday', TODAY).due, '2026-08-10');
});

test('month-and-day forms resolve, in either order', () => {
  assert.equal(findDate('transfer aug 5', TODAY).due, '2026-08-05');
  assert.equal(findDate('transfer August 5th', TODAY).due, '2026-08-05');
  assert.equal(findDate('transfer 5 august', TODAY).due, '2026-08-05');
  assert.equal(findDate('transfer 5th of august', TODAY).due, '2026-08-05');
  assert.equal(findDate('conference sept 12 2027', TODAY).due, '2027-09-12');
});

test('a month-day already past rolls to next year', () => {
  assert.equal(findDate('renew jan 5', TODAY).due, '2027-01-05');
  assert.equal(findDate('renew dec 1', TODAY).due, '2026-12-01');
});

test('slash and ISO dates parse', () => {
  assert.equal(findDate('due 8/5', TODAY).due, '2026-08-05');
  assert.equal(findDate('due 8/5/27', TODAY).due, '2027-08-05');
  assert.equal(findDate('due 2026-09-09', TODAY).due, '2026-09-09');
});

test('impossible dates are not accepted as dates', () => {
  assert.equal(findDate('feb 30', TODAY), null);
  assert.equal(findDate('2026-02-30', TODAY), null);
});

test('text with no date returns null rather than guessing', () => {
  assert.equal(findDate('sow seeds for the new line', TODAY), null);
});

// ------------------------------------------------------------ tag matching

test('editDistance behaves', () => {
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('GB005', 'GB006'), 1);
  assert.equal(editDistance('', 'abc'), 3);
});

test('an exact match, ignoring case and punctuation, is known', () => {
  const result = classifyTag('gb005', ['GB005', 'PEG Treatment']);
  assert.equal(result.status, 'known');
  assert.equal(result.value, 'GB005', 'the canonical stored spelling is returned');
});

test('E012 against E0013_PegTreatment prompts — the spec requires this pair to', () => {
  const result = classifyTag('E012', ['E0013_PegTreatment']);
  assert.equal(result.status, 'near');
  assert.deepEqual(result.suggestions, ['E0013_PegTreatment']);
});

test('a one-character slip prompts rather than creating a second experiment', () => {
  const result = classifyTag('GB006', ['GB005']);
  assert.equal(result.status, 'near');
  assert.deepEqual(result.suggestions, ['GB005']);
});

test('something genuinely unrelated is new', () => {
  const result = classifyTag('XY99', ['GB005', 'E0013_PegTreatment']);
  assert.equal(result.status, 'new');
  assert.deepEqual(result.suggestions, []);
});

test('with nothing known yet, everything is new', () => {
  assert.equal(classifyTag('GB005', []).status, 'new');
});

// --------------------------------------------------------------- capturing

test('the spec\'s own example parses', () => {
  const parsed = parseCapture('sow seeds GB005 tomorrow #lab', ctx());

  assert.equal(parsed.title, 'Sow seeds GB005');
  assert.equal(parsed.scope, 'lab');
  assert.equal(parsed.due, '2026-08-01');
  assert.equal(parsed.dueAssumed, false);
  assert.equal(parsed.experiment.value, 'GB005');
  assert.equal(parsed.experiment.status, 'new', 'nothing known yet, so it must ask');
});

test('run-on dictation with no punctuation still parses', () => {
  const parsed = parseCapture('sow seeds for gb 005 tomorrow', ctx({ experiments: ['GB005'] }));

  assert.equal(parsed.due, '2026-08-01');
  assert.equal(parsed.experiment.status, 'known');
  assert.equal(parsed.experiment.value, 'GB005', 'a dictated space inside the code is tolerated');
});

test('the date phrase is removed from the title but the code is kept', () => {
  const parsed = parseCapture('move GB005 plates to recovery on wednesday', ctx());
  assert.equal(parsed.title, 'Move GB005 plates to recovery');
  assert.equal(parsed.due, '2026-08-05');
});

test('a dictated code is normalised where it sits in the title', () => {
  // "e012" and "gb 005" are what dictation actually produces.
  assert.equal(parseCapture('move e012 plates to recovery', ctx()).title, 'Move E012 plates to recovery');
  assert.equal(parseCapture('sow seeds for gb 005', ctx()).title, 'Sow seeds for GB005');
});

test('personal scope, however it is said', () => {
  assert.equal(parseCapture('dentist tuesday #personal', ctx()).scope, 'personal');
  assert.equal(parseCapture('call mum #home', ctx()).scope, 'personal');
  assert.equal(parseCapture('order plates #work', ctx()).scope, 'lab');
  assert.equal(parseCapture('order plates', ctx()).scope, 'lab', 'lab is the default');
  assert.equal(
    parseCapture('groceries', ctx({ defaultScope: 'personal' })).scope,
    'personal',
    'the default is overridable so the UI can offer a toggle',
  );
});

test('explicit type tags are honoured; nothing else is guessed', () => {
  assert.equal(parseCapture('lab meeting friday #meeting', ctx()).type, 'meeting');
  assert.equal(parseCapture('read Zhu 2016', ctx()).type, 'task', 'no guessing from wording');
});

test('a missing date is assumed to be today, and says so', () => {
  const parsed = parseCapture('order more petri dishes', ctx());
  assert.equal(parsed.due, TODAY);
  assert.equal(parsed.dueAssumed, true);
  assert.match(parsed.notes.join(' '), /No date heard/);
});

test('a past date is flagged rather than quietly accepted', () => {
  const parsed = parseCapture('logged the harvest yesterday', ctx());
  assert.equal(parsed.due, '2026-07-30');
  assert.match(parsed.notes.join(' '), /in the past/);
});

test('explicit @experiment and +project markers are extracted from the title', () => {
  const parsed = parseCapture('check plates @GB005 +Globot tomorrow', ctx({
    experiments: ['GB005'],
    projects: ['Globot'],
  }));
  assert.equal(parsed.title, 'Check plates');
  assert.equal(parsed.experiment.status, 'known');
  assert.equal(parsed.project.status, 'known');
});

test('an explicit @tag that is unknown still has to be confirmed', () => {
  const parsed = parseCapture('check plates @GB009', ctx({ experiments: ['GB005'] }));
  assert.equal(parsed.experiment.status, 'near');
  assert.match(parsed.notes.join(' '), /confirm which you meant/);
});

test('innocent numbers are not mistaken for experiment codes', () => {
  for (const phrase of ['water on day 14', 'run 12 samples', 'set 30 plates', 'check ph 5.8']) {
    const parsed = parseCapture(phrase, ctx());
    assert.equal(parsed.experiment, null, phrase);
  }
});

test('a single digit is not a code', () => {
  assert.equal(parseCapture('move tray 3', ctx()).experiment, null);
});

test('empty input is reported, not silently accepted', () => {
  const parsed = parseCapture('   ', ctx());
  assert.equal(parsed.title, '');
  assert.match(parsed.notes.join(' '), /No title left/);
});

test('a capture that is only a date leaves no title', () => {
  const parsed = parseCapture('tomorrow', ctx());
  assert.equal(parsed.title, '');
  assert.equal(parsed.due, '2026-08-01');
});

// ------------------------------------------------------------- committing

test('toTask attaches a known tag automatically', () => {
  const parsed = parseCapture('water GB005 tomorrow', ctx({ experiments: ['GB005'] }));
  const task = toTask(parsed, { id: 't1', now: '2026-07-31T09:00:00Z' });

  assert.equal(task.experiment, 'GB005');
  assert.equal(task.due, '2026-08-01');
  assert.equal(task.done, false);
  assert.equal(task.source, 'app');
});

test('toTask drops an unconfirmed tag — never auto-create', () => {
  const parsed = parseCapture('water GB009 tomorrow', ctx({ experiments: ['GB005'] }));
  assert.equal(parsed.experiment.status, 'near');

  const unconfirmed = toTask(parsed, { id: 't1' });
  assert.equal(unconfirmed.experiment, null, 'a near match must not be attached by default');

  const confirmed = toTask(parsed, { id: 't1', acceptExperiment: 'GB005' });
  assert.equal(confirmed.experiment, 'GB005', 'accepting the suggestion attaches it');

  const created = toTask(parsed, { id: 't1', acceptExperiment: 'GB009' });
  assert.equal(created.experiment, 'GB009', 'explicitly creating the new tag also works');
});

test('task ids are unique and readable', () => {
  const a = newTaskId('2026-07-31T08:12:00.000Z', () => 0.1);
  assert.match(a, /^t_20260731T081200_[0-9a-f]{3}$/);
  assert.notEqual(
    newTaskId('2026-07-31T08:12:00Z', () => 0.1),
    newTaskId('2026-07-31T08:12:00Z', () => 0.9),
  );
});
