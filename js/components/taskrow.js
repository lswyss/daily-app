/**
 * A task row, shaped like a pressed-specimen label: title in the body face, then
 * small-caps letter-spaced metadata underneath. Hairline rule, no fill, no shadow.
 *
 * @module components/taskrow
 */

import { daysBetween } from '../parse.js';

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

/**
 * The metadata line: project · experiment · date, omitting what is absent.
 * @param {object} task
 * @param {string} today
 * @returns {string}
 */
export function metaLine(task, today) {
  return [task.project, task.experiment, dueLabel(task.due, today)]
    .filter(Boolean)
    .join(' · ');
}

/** The part of the metadata line before the date, if any. */
function metaPrefix(task) {
  const parts = [task.project, task.experiment].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' · ')} · ` : '';
}

/**
 * @param {object} args
 * @param {object} args.task
 * @param {string} args.today
 * @param {(id: string) => void} args.onToggle
 * @returns {HTMLElement}
 */
export function taskRow({ task, today, onToggle }) {
  const overdue = !task.done && task.due && task.due < today;

  const row = document.createElement('li');
  row.className = `task${overdue ? ' is-overdue' : ''}${task.done ? ' is-done' : ''}`;
  row.dataset.id = task.id;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'task-toggle';
  // The whole row is the target, so the tap area clears 44px on a phone.
  button.setAttribute('aria-pressed', String(Boolean(task.done)));
  button.setAttribute(
    'aria-label',
    `${task.done ? 'Mark not done' : 'Complete'}: ${task.title}`,
  );

  const mark = document.createElement('span');
  mark.className = 'task-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = task.done ? '✓' : '';

  const body = document.createElement('span');
  body.className = 'task-body';

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;

  // Only the date carries the overdue colour. Reddening the project and
  // experiment too reads as alarm, and this is a working record, not a nag.
  const meta = document.createElement('span');
  meta.className = 'meta task-meta';
  const due = document.createElement('span');
  due.className = 'task-due';
  due.textContent = dueLabel(task.due, today);
  meta.append(document.createTextNode(metaPrefix(task)), due);

  body.append(title, meta);
  button.append(mark, body);
  button.addEventListener('click', () => onToggle(task.id));

  row.append(button);
  return row;
}
