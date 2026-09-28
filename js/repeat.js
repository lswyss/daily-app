/**
 * Repeating tasks. Pure and DOM-free.
 *
 * A repeating task is an ordinary task with a `repeat` rule. Only **one**
 * occurrence exists at a time: completing it creates the next. Projecting every
 * future occurrence into `data.json` would bloat the file and turn "stop
 * repeating" into a mass delete.
 *
 * The next occurrence keeps the rhythm of the *due date*, not of the day it was
 * finished: a weekly Monday task ticked off on Wednesday comes back on Monday.
 * Occurrences missed entirely are skipped rather than stacked up as overdue.
 *
 * @module repeat
 */

import { addDays, daysBetween } from './parse.js';

/** @typedef {{every: number, unit: 'day'|'week'}} Repeat */

/** @type {readonly ['day','week']} */
export const REPEAT_UNITS = /** @type {const} */ (['day', 'week']);

/** The choices the editor offers, in order. `null` means no repeat. */
export const REPEAT_CHOICES = /** @type {const} */ ([
  { label: 'Does not repeat', value: null },
  { label: 'Every day', value: { every: 1, unit: 'day' } },
  { label: 'Every week', value: { every: 1, unit: 'week' } },
  { label: 'Every 2 weeks', value: { every: 2, unit: 'week' } },
  { label: 'Every 3 weeks', value: { every: 3, unit: 'week' } },
  { label: 'Every 4 weeks', value: { every: 4, unit: 'week' } },
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRepeat(value) {
  if (!value || typeof value !== 'object') return false;
  const r = /** @type {any} */ (value);
  return (
    Number.isInteger(r.every) &&
    r.every >= 1 &&
    r.every <= 52 &&
    REPEAT_UNITS.includes(r.unit)
  );
}

/** @param {Repeat|null|undefined} a @param {Repeat|null|undefined} b */
export function sameRepeat(a, b) {
  if (!a || !b) return !a && !b;
  return a.every === b.every && a.unit === b.unit;
}

/** @param {Repeat} repeat */
function stepDays(repeat) {
  return repeat.unit === 'week' ? repeat.every * 7 : repeat.every;
}

/**
 * "weekly", "every 2 weeks", "daily".
 * @param {Repeat|null|undefined} repeat
 * @returns {string}
 */
export function repeatLabel(repeat) {
  if (!isRepeat(repeat)) return '';
  const { every, unit } = /** @type {Repeat} */ (repeat);
  if (every === 1) return unit === 'week' ? 'weekly' : 'daily';
  return `every ${every} ${unit}s`;
}

/**
 * The due date of the next occurrence.
 *
 * Steps forward from `due` until it lands after the day the task was finished.
 * With no due date, counts from the day it was finished.
 *
 * @param {{due?: string|null, repeat?: Repeat|null}} task
 * @param {string} doneOn ISO date the occurrence was finished (local).
 * @returns {string|null}
 */
export function nextDue(task, doneOn) {
  if (!isRepeat(task.repeat)) return null;
  const step = stepDays(/** @type {Repeat} */ (task.repeat));
  const from = task.due ?? doneOn;
  if (from > doneOn) return addDays(from, step);
  // Skip any occurrences missed entirely, in one jump rather than a loop.
  const missed = Math.floor(daysBetween(from, doneOn) / step) + 1;
  return addDays(from, missed * step);
}

/**
 * A stable id for an occurrence, so completing (or replaying the completion of)
 * the same occurrence twice cannot create two copies of the next one.
 *
 * @param {string} id Id of any occurrence in the series.
 * @param {string} due Due date of the occurrence wanted.
 */
export function occurrenceId(id, due) {
  return `${id.replace(/~\d{4}-\d{2}-\d{2}$/, '')}~${due}`;
}

/**
 * The task that follows `task` once it is finished on `doneOn`, or null.
 *
 * @param {object} task
 * @param {string} doneOn
 * @param {string} now ISO timestamp for createdAt.
 * @returns {object|null}
 */
export function nextOccurrence(task, doneOn, now) {
  const due = nextDue(task, doneOn);
  if (!due) return null;
  return {
    ...task,
    id: occurrenceId(task.id, due),
    due,
    done: false,
    completedAt: null,
    createdAt: now,
    source: task.source,
  };
}
