import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addMonths,
  addYears,
  bucketByDate,
  placementDate,
  daysInMonth,
  endOfMonth,
  monthGrid,
  normaliseAnchor,
  periodLabel,
  rangeOf,
  shiftPeriod,
  startOfMonth,
  startOfWeek,
  weekDays,
  weekdayNames,
  yearMonths,
} from '../js/calendar.js';

import { dotClass, dominantDotClass, dotsFor, legendFor, PROJECT_SLOTS } from '../js/color.js';
import { localAt, seedTask } from './helpers.js';

// 2026-07-31 is a Friday.
const TODAY = '2026-07-31';

// ------------------------------------------------------------------ weeks

test('weeks start on Monday', () => {
  assert.equal(startOfWeek('2026-07-31'), '2026-07-27', 'Friday → that Monday');
  assert.equal(startOfWeek('2026-07-27'), '2026-07-27', 'Monday → itself');
  assert.equal(startOfWeek('2026-08-02'), '2026-07-27', 'Sunday belongs to the week before');
});

test('weekDays returns seven consecutive days from Monday', () => {
  const days = weekDays(TODAY);
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-07-27');
  assert.equal(days[6], '2026-08-02');
});

test('weekday names start on Monday', () => {
  const names = weekdayNames();
  assert.equal(names.length, 7);
  assert.match(names[0], /^M/i);
});

// ----------------------------------------------------------------- months

test('month boundaries, including leap years', () => {
  assert.equal(startOfMonth('2026-07-31'), '2026-07-01');
  assert.equal(endOfMonth('2026-07-15'), '2026-07-31');
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfMonth('2024-02-10'), '2024-02-29');
  assert.equal(daysInMonth('2026-09-01'), 30);
});

test('addMonths anchors to the first, so 31 January plus a month is not 3 March', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-01');
  assert.equal(addMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(addMonths('2026-01-01', -1), '2025-12-01');
  assert.equal(addMonths('2026-07-01', 12), '2027-07-01');
  assert.equal(addYears('2026-07-01', -2), '2024-07-01');
});

// ------------------------------------------------------------------- grid

test('the month grid is whole weeks with no holes', () => {
  const { weeks, month } = monthGrid('2026-08-10');

  assert.equal(month, '2026-08');
  for (const week of weeks) assert.equal(week.length, 7, 'every row has seven cells');

  const flat = weeks.flat();
  // August 2026 starts on a Saturday, so the grid opens with five padding days.
  assert.equal(flat[0].iso, '2026-07-27');
  assert.equal(flat[0].inMonth, false);
  assert.equal(flat.filter((c) => c.inMonth).length, 31, 'all 31 days of August appear once');

  // Consecutive with no gaps or repeats.
  for (let i = 1; i < flat.length; i += 1) {
    const prev = new Date(`${flat[i - 1].iso}T00:00:00Z`).getTime();
    const cur = new Date(`${flat[i].iso}T00:00:00Z`).getTime();
    assert.equal(cur - prev, 86_400_000, `gap before ${flat[i].iso}`);
  }
});

test('a month that starts on Monday needs no leading padding', () => {
  // 2026-06-01 is a Monday.
  const { weeks } = monthGrid('2026-06-15');
  assert.equal(weeks[0][0].iso, '2026-06-01');
  assert.equal(weeks[0][0].inMonth, true);
});

test('February 2026 fits in exactly four weeks', () => {
  // 1 Feb 2026 is a Sunday, so the grid runs 26 Jan – 1 Mar.
  const { weeks } = monthGrid('2026-02-05');
  assert.equal(weeks.flat().filter((c) => c.inMonth).length, 28);
});

test('yearMonths gives twelve first-of-month anchors', () => {
  const months = yearMonths('2026-08-10');
  assert.equal(months.length, 12);
  assert.equal(months[0], '2026-01-01');
  assert.equal(months[11], '2026-12-01');
});

// ------------------------------------------------------------ navigation

test('anchors normalise per zoom so navigation is stable', () => {
  assert.equal(normaliseAnchor('week', TODAY), '2026-07-27');
  assert.equal(normaliseAnchor('month', TODAY), '2026-07-01');
  assert.equal(normaliseAnchor('year', TODAY), '2026-07-01');
});

test('shifting a period moves by exactly one period', () => {
  assert.equal(shiftPeriod('week', TODAY, 1), '2026-08-03');
  assert.equal(shiftPeriod('week', TODAY, -1), '2026-07-20');
  assert.equal(shiftPeriod('month', TODAY, 1), '2026-08-01');
  assert.equal(shiftPeriod('month', TODAY, -7), '2025-12-01');
  assert.equal(shiftPeriod('year', TODAY, 1), '2027-07-01');
});

test('rangeOf covers the whole visible period', () => {
  assert.deepEqual(rangeOf('week', TODAY), { from: '2026-07-27', to: '2026-08-02' });
  assert.deepEqual(rangeOf('month', TODAY), { from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(rangeOf('year', TODAY), { from: '2026-01-01', to: '2026-12-31' });
});

test('period labels read like dates, not ISO strings', () => {
  assert.equal(periodLabel('year', TODAY), '2026');
  assert.match(periodLabel('month', TODAY), /July.*2026/);
  // A week spanning two months names both.
  assert.match(periodLabel('week', TODAY), /Jul.*–.*Aug/);
  // A week inside one month names it once.
  assert.match(periodLabel('week', '2026-07-08'), /^Jul \d+ – \d+$/);
});

// -------------------------------------------------------------- bucketing

test('open tasks sit on their due date', () => {
  const tasks = [
    seedTask({ id: 'a', due: '2026-08-03', createdAt: '2026-07-31T09:00:00Z' }),
    seedTask({ id: 'b', due: '2026-08-03', createdAt: '2026-07-31T08:00:00Z' }),
    seedTask({ id: 'd', due: null }),
  ];

  const { byDate, undated } = bucketByDate(tasks);

  assert.deepEqual(byDate.get('2026-08-03').map((t) => t.id), ['b', 'a'], 'sorted by creation');
  assert.deepEqual(undated.map((t) => t.id), ['d'], 'undated tasks are kept, not dropped');
});

test('a finished task sits on the day it was finished, not when it was due', () => {
  // Due the 4th, actually done on the 6th. The calendar must record the 6th.
  const late = seedTask({
    id: 'late',
    due: '2026-08-04',
    done: true,
    completedAt: localAt(2026, 8, 6, 17),
  });
  assert.equal(placementDate(late), '2026-08-06');

  const { byDate } = bucketByDate([late]);
  assert.equal(byDate.has('2026-08-04'), false, 'not on its due date');
  assert.deepEqual(byDate.get('2026-08-06').map((t) => t.id), ['late']);
});

test('a task finished early moves back to the day it was finished', () => {
  const early = seedTask({
    id: 'early',
    due: '2026-08-20',
    done: true,
    completedAt: localAt(2026, 8, 4, 15),
  });
  assert.equal(placementDate(early), '2026-08-04');
});

test('the completion day is the LOCAL day, not the UTC one', () => {
  // 6:30pm local on 4 August. In any timezone behind UTC the stored timestamp
  // reads as the 5th, and a naive slice would file the work under tomorrow.
  const evening = localAt(2026, 8, 4, 18, 30);
  const task = seedTask({ id: 'evening', due: '2026-08-04', done: true, completedAt: evening });

  assert.equal(placementDate(task), '2026-08-04');
});

test('a task done without a timestamp still lands somewhere', () => {
  // Should not happen, but silently vanishing from the calendar would be worse.
  const orphan = seedTask({ id: 'o', due: '2026-08-04', done: true, completedAt: null });
  assert.equal(placementDate(orphan), '2026-08-04');

  const nowhere = seedTask({ id: 'n', due: null, done: true, completedAt: null });
  assert.equal(placementDate(nowhere), null);
  assert.deepEqual(bucketByDate([nowhere]).undated.map((t) => t.id), ['n']);
});

// ----------------------------------------------------------------- colour

test('personal always gets the same colour, whatever else is set', () => {
  assert.equal(dotClass({ scope: 'personal' }, []), 'dot-personal');
  assert.equal(
    dotClass({ scope: 'personal', project: 'Globot' }, ['Globot']),
    'dot-personal',
    'scope wins over project',
  );
});

test('a lab task with no project gets the neutral default', () => {
  assert.equal(dotClass({ scope: 'lab', project: null }, []), 'dot-default');
});

test('projects take colours by their position, so a colour never moves', () => {
  const projects = ['Globot', 'PEG Treatment'];
  assert.equal(dotClass({ scope: 'lab', project: 'Globot' }, projects), 'dot-p1');
  assert.equal(dotClass({ scope: 'lab', project: 'PEG Treatment' }, projects), 'dot-p2');

  // Appending a project must not recolour the existing ones.
  const grown = [...projects, 'Root Atlas'];
  assert.equal(dotClass({ scope: 'lab', project: 'Globot' }, grown), 'dot-p1');
  assert.equal(dotClass({ scope: 'lab', project: 'Root Atlas' }, grown), 'dot-p3');
});

test('an unlisted project still gets a stable colour rather than none', () => {
  const a = dotClass({ scope: 'lab', project: 'Mystery' }, ['Globot']);
  const b = dotClass({ scope: 'lab', project: 'Mystery' }, ['Globot']);
  assert.equal(a, b);
  assert.match(a, /^dot-p[1-6]$/);
});

test('colours wrap around after the palette runs out', () => {
  const many = Array.from({ length: PROJECT_SLOTS + 1 }, (_, i) => `P${i}`);
  assert.equal(dotClass({ scope: 'lab', project: 'P0' }, many), 'dot-p1');
  assert.equal(
    dotClass({ scope: 'lab', project: `P${PROJECT_SLOTS}` }, many),
    'dot-p1',
    'the seventh project shares with the first',
  );
});

test('a day shows one dot per distinct colour, capped', () => {
  const projects = ['A', 'B', 'C', 'D', 'E'];
  const tasks = projects.map((p, i) => seedTask({ id: `t${i}`, project: p, scope: 'lab' }));
  // Two tasks in the same project must not produce two dots.
  tasks.push(seedTask({ id: 'dup', project: 'A', scope: 'lab' }));

  const dots = dotsFor(tasks, projects, 4);
  assert.equal(dots.classes.length, 4);
  assert.equal(dots.overflow, 1);
  assert.equal(dots.total, 6);
  assert.equal(new Set(dots.classes).size, 4, 'no repeated colours');
});

test('the year view picks the most common colour for a day', () => {
  const projects = ['A', 'B'];
  const tasks = [
    seedTask({ id: '1', project: 'B', scope: 'lab' }),
    seedTask({ id: '2', project: 'A', scope: 'lab' }),
    seedTask({ id: '3', project: 'A', scope: 'lab' }),
  ];
  assert.equal(dominantDotClass(tasks, projects), 'dot-p1', 'A appears twice');
  assert.equal(dominantDotClass([], projects), null);
});

test('the legend lists only what is on screen, personal last', () => {
  const projects = ['Globot', 'PEG Treatment'];
  const tasks = [
    seedTask({ id: '1', project: 'PEG Treatment', scope: 'lab' }),
    seedTask({ id: '2', scope: 'personal', project: null }),
    seedTask({ id: '3', project: 'Globot', scope: 'lab' }),
    seedTask({ id: '4', project: null, scope: 'lab' }),
  ];

  const legend = legendFor(tasks, projects);
  assert.deepEqual(legend.map((l) => l.label), ['Globot', 'Lab, no project', 'PEG Treatment', 'Personal']);
  assert.equal(legend.at(-1).cls, 'dot-personal');
});
