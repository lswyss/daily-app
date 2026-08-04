/**
 * Ideas: a quiet list of things worth remembering, with no dates and no nagging.
 *
 * Deliberately not part of Today. An idea is not owed to anyone on a particular
 * day, and putting it in a list of things due would turn it into guilt. This is a
 * place you visit when you want it.
 *
 * An idea that turns into work gets promoted to a task in one tap.
 *
 * @module views/ideas
 */

import { localDateOf, newTaskId, parseCapture, toTask, todayIso } from '../parse.js';
import { shortDate } from '../components/taskrow.js';
import { taskEditor } from '../components/taskeditor.js';

/**
 * Split tasks into live ideas and ideas already dealt with. Pure, so it is tested.
 *
 * @param {object[]} tasks
 * @returns {{open: object[], archived: object[]}}
 */
export function groupIdeas(tasks) {
  const open = [];
  const archived = [];
  for (const task of tasks) {
    if (task.type !== 'idea') continue;
    (task.done ? archived : open).push(task);
  }
  // Newest first: a fresh thought is the one you are most likely to act on.
  const byCreated = (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  open.sort(byCreated);
  archived.sort(byCreated);
  return { open, archived };
}

/** One idea, as a specimen-label row with its own actions. */
function ideaRow({ idea, today, onPromote, onOpen, onArchive }) {
  const row = document.createElement('li');
  row.className = `idea${idea.done ? ' is-done' : ''}`;

  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'idea-body';
  body.setAttribute('aria-label', `Edit idea: ${idea.title}`);

  const title = document.createElement('span');
  title.className = 'idea-title';
  title.textContent = idea.title;

  const meta = document.createElement('span');
  meta.className = 'meta idea-meta';
  const captured = localDateOf(idea.createdAt);
  meta.textContent = [idea.project, idea.experiment, captured ? shortDate(captured) : null]
    .filter(Boolean)
    .join(' · ');

  body.append(title, meta);
  body.addEventListener('click', () => onOpen(idea.id));
  row.append(body);

  const actions = document.createElement('div');
  actions.className = 'idea-actions';

  if (!idea.done) {
    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'quiet idea-action';
    promote.textContent = 'Make a task';
    promote.title = `Turn into a task due ${today}`;
    promote.addEventListener('click', () => onPromote(idea.id));

    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'quiet idea-action';
    archive.textContent = 'Archive';
    archive.title = 'Keep it, but move it out of the list';
    archive.addEventListener('click', () => onArchive(idea.id));

    actions.append(promote, archive);
  } else {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'quiet idea-action';
    restore.textContent = 'Restore';
    restore.addEventListener('click', () => onArchive(idea.id));
    actions.append(restore);
  }

  row.append(actions);
  return row;
}

/**
 * @param {object} args
 * @param {import('../store.js').DailyState} args.state
 * @param {string} [args.today]
 * @param {(task: object) => void} args.onAdd
 * @param {(id: string) => void} args.onPromote
 * @param {(id: string) => void} args.onArchive
 * @param {(id: string) => void} args.onOpen
 * @param {() => void} args.onBack
 * @param {HTMLElement} [args.badge]
 * @param {string} [args.draft]
 * @param {(value: string) => void} [args.onDraft]
 * @returns {HTMLElement}
 */
export function renderIdeas({
  state,
  today = todayIso(),
  onAdd,
  onPromote,
  onArchive,
  onOpen,
  onBack,
  badge,
  draft = '',
  onDraft = () => {},
  editingId = null,
  onSaveEdit = () => {},
  onDelete = () => {},
  onCancelEdit = () => {},
}) {
  // Dictated ideas will contain mangled words, so editing is not optional here.
  const render = (idea) =>
    editingId === idea.id
      ? taskEditor({ task: idea, onSave: onSaveEdit, onDelete, onCancel: onCancelEdit })
      : ideaRow({ idea, today, onPromote, onOpen, onArchive });
  const view = document.createElement('div');
  view.className = 'ideas';

  const top = document.createElement('div');
  top.className = 'cal-top';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'quiet icon';
  back.textContent = '← Tasks';
  back.addEventListener('click', onBack);
  top.append(back);
  if (badge) top.append(badge);
  view.append(top);

  const heading = document.createElement('h1');
  heading.textContent = 'Ideas';
  view.append(heading);

  const blurb = document.createElement('p');
  blurb.className = 'meta';
  blurb.textContent = 'No dates. Nothing due. Promote one when it becomes work.';
  view.append(blurb);

  // ---- capture ----------------------------------------------------------
  const form = document.createElement('form');
  form.className = 'capture';
  form.noValidate = true;

  const label = document.createElement('label');
  label.className = 'meta capture-label';
  label.htmlFor = 'idea-input';
  label.textContent = 'Capture an idea';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'idea-input';
  input.className = 'capture-input';
  input.placeholder = 'try a shallower PEG gradient';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'sentences');
  input.enterKeyHint = 'done';
  input.value = draft;
  input.addEventListener('input', () => onDraft(input.value));

  form.append(label, input);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = input.value.trim();
    if (raw === '') return;

    // forceType, not a post-hoc override: the parser has to know it is an idea
    // before it decides whether to pull a date out of the text.
    const parsed = parseCapture(raw, {
      today,
      forceType: 'idea',
      projects: state.projects ?? [],
      experiments: (state.experiments ?? []).map((e) => e.id),
    });
    const idea = toTask(parsed, { id: newTaskId() });

    input.value = '';
    onDraft('');
    onAdd(idea);
  });
  view.append(form);

  // ---- list -------------------------------------------------------------
  const { open, archived } = groupIdeas(state.tasks ?? []);

  if (open.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No ideas yet. Add one above, or dictate one to Siri.';
    view.append(empty);
  } else {
    const heading2 = document.createElement('h2');
    heading2.className = 'meta group-title';
    heading2.textContent = `Ideas · ${open.length}`;

    const list = document.createElement('ul');
    list.className = 'idea-list';
    for (const idea of open) list.append(render(idea));
    view.append(heading2, list);
  }

  if (archived.length > 0) {
    const box = document.createElement('details');
    box.className = 'upcoming';
    const summary = document.createElement('summary');
    summary.textContent = `Archived · ${archived.length}`;
    box.append(summary);

    const list = document.createElement('ul');
    list.className = 'idea-list';
    for (const idea of archived) list.append(render(idea));
    box.append(list);
    view.append(box);
  }

  return view;
}
