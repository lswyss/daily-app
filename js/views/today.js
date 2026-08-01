/**
 * Today view: what is due now, and one input to add more.
 *
 * Lab first, personal in a secondary group below. Overdue is visually distinct
 * but not alarming — this is a working record, not a nag.
 *
 * @module views/today
 */

import { parseCapture, toTask, newTaskId, todayIso } from '../parse.js';
import { taskRow } from '../components/taskrow.js';

/**
 * Split tasks into the groups the view renders. Pure, so it is unit-tested.
 *
 * @param {object[]} tasks
 * @param {string} today ISO date
 * @returns {{overdue: object[], lab: object[], personal: object[], doneToday: object[], laterCount: number}}
 */
export function groupForToday(tasks, today) {
  const overdue = [];
  const lab = [];
  const personal = [];
  const doneToday = [];
  let laterCount = 0;

  for (const task of tasks) {
    if (task.done) {
      // Completed items leave the active list, but today's stay visible so the
      // day reads as progress and an accidental tap is still undoable.
      if (task.completedAt?.slice(0, 10) === today) doneToday.push(task);
      continue;
    }
    if (!task.due || task.due > today) {
      if (task.due && task.due > today) laterCount += 1;
      else if (!task.due) laterCount += 1;
      continue;
    }
    if (task.due < today) overdue.push(task);
    else if (task.scope === 'personal') personal.push(task);
    else lab.push(task);
  }

  const byDue = (a, b) => (a.due ?? '').localeCompare(b.due ?? '');
  const byCreated = (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '');

  overdue.sort((a, b) => byDue(a, b) || byCreated(a, b));
  lab.sort(byCreated);
  personal.sort(byCreated);
  doneToday.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  return { overdue, lab, personal, doneToday, laterCount };
}

/** A long, human date for the header. */
function headerDate(today) {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** @param {string} title @param {object[]} tasks @param {object} options */
function taskGroup(title, tasks, { today, onToggle, tone = '' }) {
  if (tasks.length === 0) return null;

  const section = document.createElement('section');
  section.className = `group${tone ? ` is-${tone}` : ''}`;

  const heading = document.createElement('h2');
  heading.className = 'meta group-title';
  heading.textContent = `${title} · ${tasks.length}`;

  const list = document.createElement('ul');
  list.className = 'tasks';
  for (const task of tasks) list.append(taskRow({ task, today, onToggle }));

  section.append(heading, list);
  return section;
}

/**
 * Build the confirm-before-file panel for a parsed capture.
 * Nothing is committed until the user presses Add.
 */
function capturePreview({ parsed, onAdd, onCancel }) {
  const panel = document.createElement('div');
  panel.className = 'preview';

  const accepted = {
    experiment: parsed.experiment?.status === 'known' ? parsed.experiment.value : null,
    project: parsed.project?.status === 'known' ? parsed.project.value : null,
    scope: parsed.scope,
  };

  const title = document.createElement('p');
  title.className = 'preview-title';
  title.textContent = parsed.title || '(no title)';

  const chips = document.createElement('div');
  chips.className = 'chips';

  /** @param {string} text @param {string} [tone] */
  const chip = (text, tone = '') => {
    const span = document.createElement('span');
    span.className = `chip${tone ? ` is-${tone}` : ''}`;
    span.textContent = text;
    return span;
  };

  // Scope is a toggle: dictation cannot say "#personal" reliably.
  const scopeButton = document.createElement('button');
  scopeButton.type = 'button';
  scopeButton.className = 'chip is-toggle';
  scopeButton.textContent = accepted.scope;
  scopeButton.title = 'Switch between lab and personal';
  scopeButton.addEventListener('click', () => {
    accepted.scope = accepted.scope === 'lab' ? 'personal' : 'lab';
    scopeButton.textContent = accepted.scope;
  });

  chips.append(scopeButton, chip(parsed.dueAssumed ? `${parsed.due} (assumed)` : parsed.due, parsed.dueAssumed ? 'soft' : ''));
  if (parsed.type !== 'task') chips.append(chip(parsed.type));

  panel.append(title, chips);

  /**
   * Tag chooser. A near or new tag starts unselected — the app never creates a
   * tag on the user's behalf, it only offers.
   */
  const tagChooser = (label, candidate, key) => {
    if (!candidate) return;

    const wrap = document.createElement('div');
    wrap.className = 'chooser';

    const caption = document.createElement('p');
    caption.className = 'meta';
    caption.textContent =
      candidate.status === 'known'
        ? `${label}: ${candidate.value}`
        : candidate.status === 'near'
          ? `${label}? heard "${candidate.value}"`
          : `${label}? "${candidate.value}" is new`;
    wrap.append(caption);

    if (candidate.status === 'known') {
      panel.append(wrap);
      return;
    }

    const options = document.createElement('div');
    options.className = 'chips';

    /** @type {Array<{label: string, value: string|null}>} */
    const choices = [
      ...candidate.suggestions.map((s) => ({ label: s, value: s })),
      { label: `Create ${candidate.value}`, value: candidate.value },
      { label: 'None', value: null },
    ];

    const buttons = [];
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip is-choice';
      button.textContent = choice.label;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        accepted[key] = choice.value;
        for (const other of buttons) other.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
      });
      buttons.push(button);
      options.append(button);
    }

    wrap.append(options);
    panel.append(wrap);
  };

  tagChooser('Experiment', parsed.experiment, 'experiment');
  tagChooser('Project', parsed.project, 'project');

  if (parsed.notes.length > 0) {
    const notes = document.createElement('ul');
    notes.className = 'preview-notes';
    for (const note of parsed.notes) {
      const item = document.createElement('li');
      item.textContent = note;
      notes.append(item);
    }
    panel.append(notes);
  }

  const actions = document.createElement('div');
  actions.className = 'preview-actions';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'primary';
  add.textContent = 'Add';
  add.disabled = parsed.title === '';
  add.addEventListener('click', () => onAdd(accepted));

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'quiet';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', onCancel);

  actions.append(add, cancel);
  panel.append(actions);

  return { panel, focus: () => add.focus() };
}

/**
 * @param {object} args
 * @param {import('../store.js').DailyState} args.state
 * @param {string} [args.today]
 * @param {(id: string) => void} args.onToggle
 * @param {(task: object) => void} args.onAdd
 * @param {() => void} args.onSettings
 * @param {HTMLElement} [args.badge]
 * @param {string} [args.draft] In-progress capture text, preserved across renders.
 * @param {(value: string) => void} [args.onDraft]
 * @returns {HTMLElement}
 */
export function renderToday({
  state,
  today = todayIso(),
  onToggle,
  onAdd,
  onSettings,
  badge,
  draft = '',
  onDraft = () => {},
}) {
  const view = document.createElement('div');
  view.className = 'today';

  // ---- header -----------------------------------------------------------
  const header = document.createElement('header');
  header.className = 'today-header';

  const headings = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = 'Daily';
  const date = document.createElement('p');
  date.className = 'meta';
  date.textContent = headerDate(today);
  headings.append(h1, date);

  const controls = document.createElement('div');
  controls.className = 'today-controls';
  if (badge) controls.append(badge);

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'quiet icon';
  settings.textContent = 'Settings';
  settings.addEventListener('click', onSettings);
  controls.append(settings);

  header.append(headings, controls);
  view.append(header);

  // ---- quick capture ----------------------------------------------------
  const capture = document.createElement('form');
  capture.className = 'capture';
  capture.noValidate = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'capture-input';
  input.placeholder = 'sow seeds GB005 tomorrow';
  input.setAttribute('aria-label', 'Quick capture');
  input.autocomplete = 'off';
  input.spellcheck = false;
  // Dictation and lab codes both suffer from autocapitalise and autocorrect.
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.enterKeyHint = 'done';
  // A tap on a task re-renders the whole view; a half-typed capture must survive it.
  input.value = draft;
  input.addEventListener('input', () => onDraft(input.value));

  const previewSlot = document.createElement('div');
  previewSlot.className = 'preview-slot';

  capture.append(input, previewSlot);

  const clearPreview = () => previewSlot.replaceChildren();

  capture.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = input.value.trim();
    if (raw === '') return;

    const parsed = parseCapture(raw, {
      today,
      projects: state.projects ?? [],
      experiments: (state.experiments ?? []).map((e) => e.id),
    });

    const { panel, focus } = capturePreview({
      parsed,
      onAdd: (accepted) => {
        const task = toTask(
          { ...parsed, scope: accepted.scope },
          {
            id: newTaskId(),
            acceptExperiment: accepted.experiment,
            acceptProject: accepted.project,
          },
        );
        input.value = '';
        onDraft('');
        clearPreview();
        onAdd(task);
      },
      onCancel: () => {
        clearPreview();
        input.focus();
      },
    });

    previewSlot.replaceChildren(panel);
    focus();
  });

  view.append(capture);

  // ---- groups -----------------------------------------------------------
  const { overdue, lab, personal, doneToday, laterCount } = groupForToday(state.tasks ?? [], today);

  const groups = [
    taskGroup('Overdue', overdue, { today, onToggle, tone: 'overdue' }),
    taskGroup('Lab', lab, { today, onToggle }),
    taskGroup('Personal', personal, { today, onToggle }),
  ].filter(Boolean);

  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      doneToday.length > 0 ? 'Everything due today is done.' : 'Nothing due today.';
    view.append(empty);
  } else {
    view.append(...groups);
  }

  if (doneToday.length > 0) {
    const done = document.createElement('details');
    done.className = 'done-today';
    const summary = document.createElement('summary');
    summary.textContent = `Done today · ${doneToday.length}`;
    done.append(summary);

    const list = document.createElement('ul');
    list.className = 'tasks';
    for (const task of doneToday) list.append(taskRow({ task, today, onToggle }));
    done.append(list);
    view.append(done);
  }

  if (laterCount > 0) {
    const later = document.createElement('p');
    later.className = 'meta later';
    later.textContent = `${laterCount} scheduled later`;
    view.append(later);
  }

  return view;
}
