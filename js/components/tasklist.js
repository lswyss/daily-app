/**
 * Shared list rendering, so the Today view and the calendar behave identically:
 * the same rows, the same editor, the same targets. Divergence between the two
 * would be a bug the user experiences as the app being inconsistent.
 *
 * @module components/tasklist
 */

import { taskRow } from './taskrow.js';
import { taskEditor } from './taskeditor.js';

/**
 * @typedef {object} ListContext
 * @property {string} today
 * @property {string|null} editingId
 * @property {(id: string) => void} onToggle
 * @property {(id: string) => void} [onOpen]
 * @property {(id: string, changes: object) => void} [onSaveEdit]
 * @property {(id: string) => void} [onDelete]
 * @property {() => void} [onCancelEdit]
 */

/**
 * One task as either a row or, if it is the one being edited, the editor.
 * @param {object} task
 * @param {ListContext} ctx
 * @returns {HTMLElement}
 */
export function rowOrEditor(task, ctx) {
  if (ctx.editingId === task.id && ctx.onSaveEdit && ctx.onDelete && ctx.onCancelEdit) {
    return taskEditor({
      task,
      onSave: ctx.onSaveEdit,
      onDelete: ctx.onDelete,
      onCancel: ctx.onCancelEdit,
    });
  }
  return taskRow({ task, today: ctx.today, onToggle: ctx.onToggle, onOpen: ctx.onOpen });
}

/**
 * A `<ul>` of tasks.
 * @param {object[]} tasks
 * @param {ListContext} ctx
 * @returns {HTMLElement}
 */
export function taskList(tasks, ctx) {
  const list = document.createElement('ul');
  list.className = 'tasks';
  for (const task of tasks) list.append(rowOrEditor(task, ctx));
  return list;
}
