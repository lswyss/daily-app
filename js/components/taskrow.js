/**
 * A task row, shaped like a pressed-specimen label: title in the body face, then
 * small-caps letter-spaced metadata underneath. Hairline rule, no fill, no shadow.
 *
 * @module components/taskrow
 */

import { daysBetween, localDateOf } from '../parse.js';

/**
 * Human date for the metadata line. Relative wording is fine *here* — this is
 * display only. The stored value is always absolute.
 * @param {string|null} due
 * @param {string} today
 * @returns {string}
 */
export function dueLabel(due, today) {
  if (!due) return 'no date';
  const delta = daysBetween(today, due);
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  if (delta === -1) return 'yesterday';
  if (delta < 0) return `${Math.abs(delta)} days overdue`;
  if (delta <= 6) {
    const [y, m, d] = due.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      weekday: 'long',
      timeZone: 'UTC',
    });
  }
  const [y, m, d] = due.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** A compact absolute date: "Aug 2". */
export function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * What the date part of a row says.
 *
 * A finished task reports when it was **finished**, because that is the day it now
 * sits on in the calendar — reading "3 days overdue" on a task filed under the day
 * you actually did it would contradict its own position.
 *
 * When the two dates differ the original due date is kept alongside, so moving a
 * completed task to its completion day does not lose the fact that it was late.
 *
 * @param {object} task
 * @param {string} today
 * @returns {string}
 */
export function statusLabel(task, today) {
  if (!task.done) return dueLabel(task.due, today);

  const doneOn = localDateOf(task.completedAt);
  if (!doneOn) return task.due ? `done · due ${shortDate(task.due)}` : 'done';

  const base = `done ${dueLabel(doneOn, today)}`;
  return task.due && task.due !== doneOn ? `${base} · due ${shortDate(task.due)}` : base;
}

/**
 * A heading for a day in the upcoming list: "Tomorrow · 1 Aug".
 * The relative word carries the meaning; the date removes the ambiguity.
 * @param {string|null} due
 * @param {string} today
 * @returns {string}
 */
export function dayHeading(due, today) {
  if (!due) return 'No date';
  const [y, m, d] = due.split('-').map(Number);
  const short = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const relative = dueLabel(due, today);
  return relative === short ? short : `${relative} · ${short}`;
}

/**
 * The metadata line: project · experiment · date, omitting what is absent.
 * @param {object} task
 * @param {string} today
 * @returns {string}
 */
export function metaLine(task, today) {
  return [task.project, task.experiment, statusLabel(task, today)]
    .filter(Boolean)
    .join(' · ');
}

/** The part of the metadata line before the date, if any. */
function metaPrefix(task) {
  const parts = [task.project, task.experiment].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' · ')} · ` : '';
}

/**
 * Two targets, both clearing 44px: the box completes, the text opens the editor.
 * A single whole-row target left no room for editing, and a typo you cannot fix
 * after the undo toast expires is worse than a slightly smaller complete target.
 *
 * @param {object} args
 * @param {object} args.task
 * @param {string} args.today
 * @param {(id: string) => void} args.onToggle
 * @param {(id: string) => void} [args.onOpen]
 * @returns {HTMLElement}
 */
export function taskRow({ task, today, onToggle, onOpen }) {
  const overdue = !task.done && task.due && task.due < today;

  const row = document.createElement('li');
  row.className = `task${overdue ? ' is-overdue' : ''}${task.done ? ' is-done' : ''}`;
  row.dataset.id = task.id;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'task-toggle';
  toggle.setAttribute('aria-pressed', String(Boolean(task.done)));
  toggle.setAttribute('aria-label', `${task.done ? 'Mark not done' : 'Complete'}: ${task.title}`);

  const mark = document.createElement('span');
  mark.className = 'task-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = task.done ? '✓' : '';
  toggle.append(mark);
  toggle.addEventListener('click', () => onToggle(task.id));

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'task-open';
  open.setAttribute('aria-label', `Edit: ${task.title}`);

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;

  // Only the date carries the overdue colour. Reddening the project and
  // experiment too reads as alarm, and this is a working record, not a nag.
  const meta = document.createElement('span');
  meta.className = 'meta task-meta';
  const due = document.createElement('span');
  due.className = 'task-due';
  due.textContent = statusLabel(task, today);
  meta.append(document.createTextNode(metaPrefix(task)), due);

  open.append(title, meta);
  if (onOpen) open.addEventListener('click', () => onOpen(task.id));
  else open.disabled = true;

  row.append(toggle, open);
  return row;
}
