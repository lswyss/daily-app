/**
 * Inline task editor: fix a title, move a date, set a repeat, switch scope,
 * record the day it was actually done, or delete.
 *
 * Emits *which fields changed* rather than a whole task, so the mutation log
 * stays a log of intent. A date change becomes `reschedule` and everything else
 * becomes `edit`, which keeps `git log` readable — the commit says
 * "reschedule: Sow seeds GB005", not "edit: …".
 *
 * @module components/taskeditor
 */

import { SCOPES } from '../store.js';
import { REPEAT_CHOICES, sameRepeat } from '../repeat.js';
import { addDays, localDateOf, todayIso, weekdayOf } from '../parse.js';

/**
 * One-tap date moves. Each resolves against today, except "+1 day" and
 * "+1 week", which push the task's *current* date — that is what "a day later"
 * means when a timeline slips.
 * @param {string|null} due
 * @param {string} today
 * @returns {Array<{label: string, value: string}>}
 */
export function quickDates(due, today) {
  const base = due ?? today;
  const nextMonday = addDays(today, ((1 - weekdayOf(today) + 7) % 7) || 7);
  const options = [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: addDays(today, 1) },
    { label: '+1 day', value: addDays(base, 1) },
    { label: '+1 week', value: addDays(base, 7) },
    { label: 'Next Mon', value: nextMonday },
  ];
  // Drop the ones that would not move it, and duplicates of earlier chips.
  const seen = new Set([due]);
  return options.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
}

/**
 * @param {object} args
 * @param {object} args.task
 * @param {(id: string, changes: {edit?: object, due?: string|null, completedOn?: string|null}) => void} args.onSave
 * @param {(id: string) => void} args.onDelete
 * @param {() => void} args.onCancel
 * @returns {HTMLElement}
 */
export function taskEditor({ task, onSave, onDelete, onCancel, today = todayIso() }) {
  const row = document.createElement('li');
  row.className = 'task is-editing';
  row.dataset.id = task.id;

  const form = document.createElement('form');
  form.className = 'editor';
  form.noValidate = true;

  // --- title -------------------------------------------------------------
  const titleLabel = document.createElement('label');
  titleLabel.className = 'meta';
  titleLabel.htmlFor = `edit-title-${task.id}`;
  titleLabel.textContent = 'Task';

  const title = document.createElement('input');
  title.type = 'text';
  title.id = `edit-title-${task.id}`;
  title.value = task.title;
  title.autocomplete = 'off';
  title.setAttribute('autocapitalize', 'none');
  title.setAttribute('autocorrect', 'off');

  // --- date --------------------------------------------------------------
  const dueLabelEl = document.createElement('label');
  dueLabelEl.className = 'meta';
  dueLabelEl.htmlFor = `edit-due-${task.id}`;
  dueLabelEl.textContent = 'Date';

  // A native date input gives iOS its own picker, which beats anything built here.
  const due = document.createElement('input');
  due.type = 'date';
  due.id = `edit-due-${task.id}`;
  due.value = task.due ?? '';

  // Tapping a chip saves straight away: moving a date should be one tap, not
  // chip-then-Save. Any other edits in the form are saved with it.
  const dueChips = document.createElement('div');
  dueChips.className = 'chips quick-dates';
  for (const option of quickDates(task.due ?? null, today)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip is-choice';
    button.textContent = option.label;
    button.addEventListener('click', () => {
      due.value = option.value;
      form.requestSubmit();
    });
    dueChips.append(button);
  }

  // --- repeat ------------------------------------------------------------
  const repeatLabelEl = document.createElement('label');
  repeatLabelEl.className = 'meta';
  repeatLabelEl.htmlFor = `edit-repeat-${task.id}`;
  repeatLabelEl.textContent = 'Repeat';

  const repeat = document.createElement('select');
  repeat.id = `edit-repeat-${task.id}`;
  REPEAT_CHOICES.forEach((choice, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = choice.label;
    option.selected = sameRepeat(choice.value, task.repeat ?? null);
    repeat.append(option);
  });
  // A rule this editor does not offer (say, every 5 weeks from the capture box)
  // is shown as itself rather than silently reset.
  if (task.repeat && !REPEAT_CHOICES.some((c) => sameRepeat(c.value, task.repeat))) {
    const option = document.createElement('option');
    option.value = 'current';
    option.textContent = `Every ${task.repeat.every} ${task.repeat.unit}s`;
    option.selected = true;
    repeat.append(option);
  }

  // --- done on -----------------------------------------------------------
  // For the day you forgot to tick it: set the day it was really done. Clearing
  // it on a finished task marks it not done again.
  const doneLabel = document.createElement('label');
  doneLabel.className = 'meta';
  doneLabel.htmlFor = `edit-done-${task.id}`;
  doneLabel.textContent = task.done ? 'Done on' : 'Already done? Pick the day';

  const doneOn = document.createElement('input');
  doneOn.type = 'date';
  doneOn.id = `edit-done-${task.id}`;
  const originalDoneOn = task.done ? (localDateOf(task.completedAt) ?? '') : '';
  doneOn.value = originalDoneOn;
  doneOn.max = today;

  // --- scope -------------------------------------------------------------
  const scopeLabel = document.createElement('p');
  scopeLabel.className = 'meta';
  scopeLabel.textContent = 'Scope';

  const scopes = document.createElement('div');
  scopes.className = 'chips';
  let scope = task.scope;
  const scopeButtons = [];
  for (const option of SCOPES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip is-choice';
    button.textContent = option;
    button.setAttribute('aria-pressed', String(option === scope));
    button.addEventListener('click', () => {
      scope = option;
      for (const other of scopeButtons) {
        other.setAttribute('aria-pressed', String(other.textContent === scope));
      }
    });
    scopeButtons.push(button);
    scopes.append(button);
  }

  // --- actions -----------------------------------------------------------
  const actions = document.createElement('div');
  actions.className = 'preview-actions';

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = 'Save';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'quiet';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', onCancel);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Delete';
  remove.addEventListener('click', () => {
    // Irreversible from the UI's point of view — git history keeps it, but the
    // user cannot see git. Confirm.
    if (!globalThis.confirm(`Delete “${task.title}”?`)) return;
    onDelete(task.id);
  });

  actions.append(save, cancel, remove);

  const status = document.createElement('p');
  status.className = 'status';

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const nextTitle = title.value.trim();
    if (nextTitle === '') {
      status.textContent = 'A task needs a title. Use Delete to remove it.';
      status.className = 'status is-bad';
      title.focus();
      return;
    }

    /** @type {{edit?: object, due?: string|null}} */
    const changes = {};
    /** @type {Record<string, unknown>} */
    const edited = {};
    if (nextTitle !== task.title) edited.title = nextTitle;
    if (scope !== task.scope) edited.scope = scope;
    if (Object.keys(edited).length > 0) changes.edit = edited;

    if (repeat.value !== 'current') {
      const nextRepeat = REPEAT_CHOICES[Number(repeat.value)].value;
      if (!sameRepeat(nextRepeat, task.repeat ?? null)) {
        edited.repeat = nextRepeat ? { ...nextRepeat } : null;
        changes.edit = edited;
      }
    }

    const nextDue = due.value === '' ? null : due.value;
    if (nextDue !== (task.due ?? null)) changes.due = nextDue;

    if (doneOn.value > today) {
      status.textContent = 'The done date cannot be in the future.';
      status.className = 'status is-bad';
      doneOn.focus();
      return;
    }
    if (doneOn.value !== originalDoneOn) changes.completedOn = doneOn.value === '' ? null : doneOn.value;

    onSave(task.id, changes);
  });

  form.append(
    titleLabel,
    title,
    dueLabelEl,
    due,
    dueChips,
    repeatLabelEl,
    repeat,
    scopeLabel,
    scopes,
    doneLabel,
    doneOn,
    status,
    actions,
  );
  row.append(form);

  // Put the cursor where the fix probably is.
  globalThis.requestAnimationFrame?.(() => {
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);
  });

  return row;
}
