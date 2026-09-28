/**
 * Today view: what is due now, and one input to add more.
 *
 * Lab first, personal in a secondary group below. Overdue is visually distinct
 * but not alarming — this is a working record, not a nag.
 *
 * @module views/today
 */

import { addDays as addDaysIso, localDateOf, todayIso } from '../parse.js';
import { dayHeading } from '../components/taskrow.js';
import { taskList } from '../components/tasklist.js';
import { captureForm, needsConfirmation } from '../components/capture.js';
import { weekPlanner } from '../components/weekplanner.js';
import { startOfWeek } from '../calendar.js';

// Moved to components/capture.js so every capture box shares it; re-exported
// because main.js and the tests have always imported it from here.
export { needsConfirmation };

/**
 * Split tasks into the groups the view renders. Pure, so it is unit-tested.
 *
 * `laterAfter` keeps the Later list from repeating what the week planner above
 * it already shows: only tasks due after that date are listed there.
 *
 * @param {object[]} tasks
 * @param {string} today ISO date
 * @param {{laterAfter?: string}} [options]
 * @returns {{overdue: object[], lab: object[], personal: object[], doneToday: object[], upcoming: Array<{due: string|null, tasks: object[]}>, laterCount: number}}
 */
export function groupForToday(tasks, today, options = {}) {
  const laterAfter = options.laterAfter ?? today;
  const overdue = [];
  const lab = [];
  const personal = [];
  const doneToday = [];
  /** @type {Map<string, object[]>} */
  const byDay = new Map();
  const undated = [];
  let laterCount = 0;

  for (const task of tasks) {
    // Ideas never appear here, not even under "No date". They have no deadline and
    // must not sit in a list that reads as things owed today.
    if (task.type === 'idea' && !task.done) continue;

    if (task.done) {
      // Completed items leave the active list, but today's stay visible so the
      // day reads as progress and an accidental tap is still undoable.
      // localDateOf, not a slice: completedAt is UTC, so anything ticked off in
      // the evening would otherwise count as tomorrow and vanish from here.
      if (localDateOf(task.completedAt) === today) doneToday.push(task);
      continue;
    }
    if (!task.due) {
      // Only reachable via the inbox or a manual edit — capture defaults to today.
      undated.push(task);
      laterCount += 1;
      continue;
    }
    if (task.due > today) {
      if (task.due <= laterAfter) continue; // in the week planner instead
      // Kept as a list rather than a bare count: a task you just added for
      // Sunday would otherwise vanish with no way to confirm it exists.
      if (!byDay.has(task.due)) byDay.set(task.due, []);
      byDay.get(task.due).push(task);
      laterCount += 1;
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

  const upcoming = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([due, group]) => ({ due, tasks: group.sort(byCreated) }));
  // Undated last: it is a holding pen, not a day.
  if (undated.length > 0) upcoming.push({ due: null, tasks: undated.sort(byCreated) });

  return { overdue, lab, personal, doneToday, upcoming, laterCount };
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

/** @param {string} title @param {object[]} tasks @param {object} ctx */
function taskGroup(title, tasks, ctx, tone = '', action = null) {
  if (tasks.length === 0) return null;

  const section = document.createElement('section');
  section.className = `group${tone ? ` is-${tone}` : ''}`;

  const heading = document.createElement('h2');
  heading.className = 'meta group-title';
  heading.textContent = `${title} · ${tasks.length}`;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet group-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    heading.append(button);
  }

  section.append(heading, taskList(tasks, ctx));
  return section;
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
 * @param {boolean} [args.upcomingOpen] Whether the upcoming list is expanded.
 * @param {(open: boolean) => void} [args.onUpcomingToggle]
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
  upcomingOpen = false,
  onUpcomingToggle = () => {},
  editingId = null,
  onOpen = () => {},
  onSaveEdit = () => {},
  onDelete = () => {},
  onCancelEdit = () => {},
  onCalendar = () => {},
  onIdeas = () => {},
  ideaCount = 0,
  weekStart = startOfWeek(today),
  onWeek = () => {},
  planDay = null,
  onPlanDay = () => {},
  planDraft = '',
  onPlanDraft = () => {},
  onMoveAllToToday = () => {},
}) {
  const ctx = { today, editingId, onToggle, onOpen, onSaveEdit, onDelete, onCancelEdit };
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

  // A glyph rather than a word: the header is already busy, and this is the one
  // control that needs to be reachable without reading.
  const calendar = document.createElement('button');
  calendar.type = 'button';
  calendar.className = 'quiet glyph';
  calendar.innerHTML =
    '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">' +
    '<rect x="2.5" y="4" width="15" height="13" rx="1.5"/><path d="M2.5 8h15"/>' +
    '<path d="M6.5 2.5v3M13.5 2.5v3"/>' +
    '<circle cx="7" cy="11.5" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="10.5" cy="11.5" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="14" cy="11.5" r="1" fill="currentColor" stroke="none"/></svg>';
  calendar.title = 'Calendar view';
  calendar.setAttribute('aria-label', 'Calendar view');
  calendar.addEventListener('click', onCalendar);

  // A bud, not a lightbulb: same idea, right dialect.
  const ideas = document.createElement('button');
  ideas.type = 'button';
  ideas.className = 'quiet glyph';
  ideas.innerHTML =
    '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">' +
    '<path d="M10 17.5V9"/>' +
    '<path d="M10 9c0-3 1.6-5.4 4.4-6.4C14.7 5.7 13.2 8.4 10 9Z"/>' +
    '<path d="M10 11.5c-2.6-.5-4-2.6-4-5 2.3.8 3.7 2.6 4 5Z"/></svg>';
  ideas.title = 'Ideas';
  ideas.setAttribute('aria-label', 'Ideas');
  ideas.addEventListener('click', onIdeas);
  if (ideaCount > 0) {
    const count = document.createElement('span');
    count.className = 'glyph-count';
    count.textContent = String(ideaCount);
    ideas.append(count);
    ideas.setAttribute('aria-label', `Ideas, ${ideaCount} saved`);
  }

  // Settings becomes a glyph too: four controls plus the badge will not fit at
  // 375px with two of them spelled out.
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'quiet glyph';
  settings.innerHTML =
    '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">' +
    '<circle cx="10" cy="10" r="2.6"/>' +
    '<path d="M10 2.6v2.2M10 15.2v2.2M2.6 10h2.2M15.2 10h2.2M4.8 4.8l1.6 1.6M13.6 13.6l1.6 1.6M15.2 4.8l-1.6 1.6M6.4 13.6l-1.6 1.6"/></svg>';
  settings.title = 'Settings';
  settings.setAttribute('aria-label', 'Settings');
  settings.addEventListener('click', onSettings);

  controls.append(ideas, calendar, settings);

  header.append(headings, controls);
  view.append(header);

  // ---- quick capture ----------------------------------------------------
  view.append(
    captureForm({
      id: 'capture-input',
      label: 'Add a task',
      state,
      today,
      draft,
      onDraft,
      onAdd,
    }),
  );

  // ---- groups -----------------------------------------------------------
  // Later starts after whichever week is further out — this one, or the one the
  // planner is showing — so no task is listed twice.
  const thisWeekStart = startOfWeek(today);
  const shownWeekEnd = addDaysIso(weekStart > thisWeekStart ? weekStart : thisWeekStart, 6);
  const { overdue, lab, personal, doneToday, upcoming, laterCount } = groupForToday(
    state.tasks ?? [],
    today,
    { laterAfter: shownWeekEnd },
  );

  const groups = [
    taskGroup('Overdue', overdue, ctx, 'overdue', overdue.length > 1
      ? { label: 'Move all to today', onClick: () => onMoveAllToToday(overdue.map((t) => t.id)) }
      : null),
    taskGroup('Lab', lab, ctx),
    taskGroup('Personal', personal, ctx),
  ].filter(Boolean);

  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      doneToday.length > 0
        ? 'Everything due today is done.'
        : 'Nothing due today. Add one above.';
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

    done.append(taskList(doneToday, ctx));
    view.append(done);
  }

  const shownAbove = new Set([...overdue, ...lab, ...personal, ...doneToday].map((t) => t.id));
  view.append(
    weekPlanner({
      state,
      today,
      weekStart,
      thisWeekStart,
      shownAbove,
      planDay,
      planDraft,
      onPlanDraft,
      onPlanDay,
      onWeek,
      onAdd,
      ctx,
    }),
  );

  if (laterCount > 0) {
    const later = document.createElement('details');
    later.className = 'upcoming';
    // Collapsed by default so Today stays the focus, but the open/closed choice
    // survives a re-render — completing a task must not fold the list back up.
    later.open = upcomingOpen;
    later.addEventListener('toggle', () => onUpcomingToggle(later.open));

    const summary = document.createElement('summary');
    summary.textContent = `Later · ${laterCount}`;
    later.append(summary);

    for (const day of upcoming) {
      const heading = document.createElement('h3');
      heading.className = 'meta day-title';
      heading.textContent = `${dayHeading(day.due, today)} · ${day.tasks.length}`;

      later.append(heading, taskList(day.tasks, ctx));
    }

    view.append(later);
  }

  return view;
}
