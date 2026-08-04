/**
 * Calendar arithmetic and bucketing. Pure and DOM-free, so the grid maths is
 * tested rather than eyeballed — off-by-one week boundaries are the classic bug
 * in a hand-rolled calendar.
 *
 * All dates are ISO `YYYY-MM-DD` strings and all maths runs in UTC, so a
 * daylight-saving boundary cannot shift a cell.
 *
 * @module calendar
 */

import { addDays, weekdayOf } from './parse.js';

/** Monday. Lab weeks start Monday, and ISO agrees. */
export const WEEK_STARTS_ON = 1;

/** @typedef {'week'|'month'|'year'} Zoom */

/** @type {readonly Zoom[]} */
export const ZOOMS = /** @type {const} */ (['week', 'month', 'year']);

/**
 * @param {string} iso
 * @param {number} [weekStartsOn]
 * @returns {string}
 */
export function startOfWeek(iso, weekStartsOn = WEEK_STARTS_ON) {
  const offset = (weekdayOf(iso) - weekStartsOn + 7) % 7;
  return addDays(iso, -offset);
}

/**
 * The seven dates of the week containing `iso`.
 * @param {string} iso
 * @returns {string[]}
 */
export function weekDays(iso) {
  const start = startOfWeek(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** @param {string} iso */
export function startOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`;
}

/** @param {string} iso */
export function daysInMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** @param {string} iso */
export function endOfMonth(iso) {
  return `${iso.slice(0, 7)}-${String(daysInMonth(iso)).padStart(2, '0')}`;
}

/**
 * Add months to a date, anchored to the first of the month. Anchors are always
 * normalised, which sidesteps the "31 January plus one month" problem entirely.
 * @param {string} iso
 * @param {number} n
 */
export function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** @param {string} iso @param {number} n */
export function addYears(iso, n) {
  return addMonths(iso, n * 12);
}

/**
 * A month laid out as whole weeks, so every row has seven cells.
 * Cells outside the month are included and flagged, which is what lets the grid
 * render without holes.
 *
 * @param {string} iso Any date in the month.
 * @returns {{month: string, weeks: Array<Array<{iso: string, inMonth: boolean}>>}}
 */
export function monthGrid(iso) {
  const first = startOfMonth(iso);
  const last = endOfMonth(iso);
  const gridStart = startOfWeek(first);

  /** @type {Array<Array<{iso: string, inMonth: boolean}>>} */
  const weeks = [];
  let cursor = gridStart;
  // Keep adding weeks until the last day of the month is covered.
  do {
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const day = addDays(cursor, i);
        return { iso: day, inMonth: day >= first && day <= last };
      }),
    );
    cursor = addDays(cursor, 7);
  } while (cursor <= last);

  return { month: first.slice(0, 7), weeks };
}

/**
 * The twelve months of the year containing `iso`, each as a first-of-month date.
 * @param {string} iso
 * @returns {string[]}
 */
export function yearMonths(iso) {
  const year = iso.slice(0, 4);
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}-01`);
}

/**
 * Normalise an anchor for a zoom level, so navigation is stable: weeks anchor to
 * their Monday, months and years to the first of the month.
 * @param {Zoom} zoom
 * @param {string} iso
 */
export function normaliseAnchor(zoom, iso) {
  if (zoom === 'week') return startOfWeek(iso);
  return startOfMonth(iso);
}

/**
 * Move one period forward or back.
 * @param {Zoom} zoom
 * @param {string} iso
 * @param {number} delta
 */
export function shiftPeriod(zoom, iso, delta) {
  if (zoom === 'week') return addDays(startOfWeek(iso), delta * 7);
  if (zoom === 'month') return addMonths(iso, delta);
  return addYears(startOfMonth(iso), delta);
}

/**
 * The inclusive date range a period covers. Used to decide whether "today" is
 * on screen and therefore whether to offer a jump back to it.
 * @param {Zoom} zoom
 * @param {string} iso
 * @returns {{from: string, to: string}}
 */
export function rangeOf(zoom, iso) {
  if (zoom === 'week') {
    const days = weekDays(iso);
    return { from: days[0], to: days[6] };
  }
  if (zoom === 'month') {
    return { from: startOfMonth(iso), to: endOfMonth(iso) };
  }
  const year = iso.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * Group tasks by the date they sit on.
 *
 * Placement is by `due`, including for completed tasks — a task due Monday and
 * ticked off on Tuesday belongs on Monday, the way a calendar normally reads.
 * `completedAt` is the archive's business, not the calendar's.
 *
 * Undated tasks are returned separately rather than dropped.
 *
 * @param {object[]} tasks
 * @returns {{byDate: Map<string, object[]>, undated: object[]}}
 */
export function bucketByDue(tasks) {
  /** @type {Map<string, object[]>} */
  const byDate = new Map();
  const undated = [];

  for (const task of tasks) {
    if (!task.due) {
      undated.push(task);
      continue;
    }
    if (!byDate.has(task.due)) byDate.set(task.due, []);
    byDate.get(task.due).push(task);
  }

  const byCreated = (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  for (const group of byDate.values()) group.sort(byCreated);
  undated.sort(byCreated);

  return { byDate, undated };
}

/** Month and year, e.g. "August 2026". */
function monthName(iso, options) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d || 1)).toLocaleDateString(undefined, {
    ...options,
    timeZone: 'UTC',
  });
}

/**
 * The heading for a period.
 * @param {Zoom} zoom
 * @param {string} iso
 */
export function periodLabel(zoom, iso) {
  if (zoom === 'year') return iso.slice(0, 4);
  if (zoom === 'month') return monthName(iso, { month: 'long', year: 'numeric' });

  const days = weekDays(iso);
  const sameMonth = days[0].slice(0, 7) === days[6].slice(0, 7);
  const from = monthName(days[0], { day: 'numeric', month: 'short' });
  const to = monthName(days[6], sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  return `${from} – ${to}`;
}

/** Short weekday names in display order, starting Monday. */
export function weekdayNames() {
  // 2026-06-01 is a Monday; any known Monday works as the seed.
  return Array.from({ length: 7 }, (_, i) =>
    monthName(addDays('2026-06-01', i), { weekday: 'short' }),
  );
}
