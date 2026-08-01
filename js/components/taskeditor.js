/**
 * Inline task editor: fix a title, move a date, switch scope, or delete.
 *
 * Emits *which fields changed* rather than a whole task, so the mutation log
 * stays a log of intent. A date change becomes `reschedule` and everything else
 * becomes `edit`, which keeps `git log` readable — the commit says
 * "reschedule: Sow seeds GB005", not "edit: …".
 *
 * @module components/taskeditor
 */

import { SCOPES } from '../store.js';

/**
 * @param {object} args
 * @param {object} args.task
 * @param {(id: string, changes: {edit?: object, due?: string|null}) => void} args.onSave
 * @param {(id: string) => void} args.onDelete
 * @param {() => void} args.onCancel
 * @returns {HTMLElement}
 */
export function taskEditor({ task, onSave, onDelete, onCancel }) {
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

    const nextDue = due.value === '' ? null : due.value;
    if (nextDue !== (task.due ?? null)) changes.due = nextDue;

    onSave(task.id, changes);
  });

  form.append(titleLabel, title, dueLabelEl, due, scopeLabel, scopes, status, actions);
  row.append(form);

  // Put the cursor where the fix probably is.
  globalThis.requestAnimationFrame?.(() => {
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);
  });

  return row;
}
