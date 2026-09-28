/**
 * The quick-capture box: one line in, a task out.
 *
 * Shared by the Today view, the day planner under the week strip, and the
 * calendar's day panels, so capture behaves identically wherever you type.
 * When the box belongs to a particular day, a capture with no date phrase is
 * filed on *that* day instead of today — tapping Thursday and typing
 * "water plants" means Thursday.
 *
 * @module components/capture
 */

import { newTaskId, parseCapture, toTask } from '../parse.js';
import { repeatLabel } from '../repeat.js';

/**
 * Is there anything here worth stopping the user for?
 *
 * The confirm step exists to catch a misheard construct code — not to make every
 * capture a two-step form. When nothing is ambiguous, the task is filed straight
 * away and the toast offers an undo instead.
 *
 * A missing date is deliberately *not* a reason to stop: filing under today is
 * the documented default and stopping for it every time would be the friction
 * this app is trying to avoid.
 *
 * A past date *is* a reason — unless it came from a day the user tapped on
 * deliberately, which is what `allowPast` says.
 *
 * @param {import('../parse.js').ParsedCapture} parsed
 * @param {string} today
 * @param {{allowPast?: boolean}} [options]
 * @returns {string|null} the reason to confirm, or null to file immediately
 */
export function needsConfirmation(parsed, today, options = {}) {
  if (parsed.title === '') return 'no-title';
  // An idea is never blocked on a tag. Nothing is attached unless the code is
  // already known, so a misheard code just stays in the text — harmless, and
  // stopping to confirm would defeat the point of capturing a thought fast.
  if (parsed.type === 'idea') return null;
  if (parsed.experiment && parsed.experiment.status !== 'known') return 'experiment';
  if (parsed.project && parsed.project.status !== 'known') return 'project';
  if (!options.allowPast && parsed.due < today) return 'past-date';
  return null;
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
  if (parsed.repeat) chips.append(chip(`↻ ${repeatLabel(parsed.repeat)}`));
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
 * @param {string} args.id            DOM id for the input; must be unique on screen.
 * @param {string} args.label
 * @param {string} [args.placeholder]
 * @param {import('../store.js').DailyState} args.state
 * @param {string} args.today
 * @param {string|null} [args.day]    Default date for captures with no date phrase.
 * @param {string} [args.draft]
 * @param {(value: string) => void} [args.onDraft]
 * @param {(task: object) => void} args.onAdd
 * @param {boolean} [args.autofocus]
 * @returns {HTMLFormElement}
 */
export function captureForm({
  id,
  label: labelText,
  placeholder = 'sow seeds GB005 tomorrow',
  state,
  today,
  day = null,
  draft = '',
  onDraft = () => {},
  onAdd,
  autofocus = false,
}) {
  const capture = document.createElement('form');
  capture.className = 'capture';
  capture.noValidate = true;

  // Without a label the borderless input reads as an example task rather than a
  // field, and on an empty list there is nothing else to tell you where to type.
  const label = document.createElement('label');
  label.className = 'meta capture-label';
  label.htmlFor = id;
  label.textContent = labelText;

  const input = document.createElement('input');
  input.type = 'text';
  input.id = id;
  input.className = 'capture-input';
  input.placeholder = placeholder;
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

  capture.append(label, input, previewSlot);

  const clearPreview = () => previewSlot.replaceChildren();
  const reset = () => {
    input.value = '';
    onDraft('');
    clearPreview();
  };

  capture.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = input.value.trim();
    if (raw === '') return;

    let parsed = parseCapture(raw, {
      today,
      projects: state.projects ?? [],
      experiments: (state.experiments ?? []).map((e) => e.id),
    });

    // The day this box belongs to stands in for "today" when no date was said.
    const dueFromDay = Boolean(day && parsed.dueAssumed && parsed.type !== 'idea');
    if (dueFromDay) {
      parsed = {
        ...parsed,
        due: day,
        dueAssumed: false,
        notes: parsed.notes.filter((note) => !note.startsWith('No date heard')),
      };
    }

    // Nothing ambiguous: file it and get out of the way.
    if (!needsConfirmation(parsed, today, { allowPast: dueFromDay })) {
      const task = toTask(parsed, { id: newTaskId() });
      reset();
      onAdd(task);
      return;
    }

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
        reset();
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

  if (autofocus) globalThis.requestAnimationFrame?.(() => input.focus());

  return capture;
}
