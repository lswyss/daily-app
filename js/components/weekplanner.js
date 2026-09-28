/**
 * The week on the Today view: a seven-day strip to see the shape of the week,
 * and a day-by-day list underneath where tapping a day's `+` opens a capture box
 * that files straight onto that day.
 *
 * Planning happens here rather than in the calendar because Today is where you
 * already are. The calendar is still the place for looking back.
 *
 * Tasks already shown higher up on Today (overdue, due today, done today) are
 * not repeated here — two copies of a row would mean two editors for one task.
 *
 * @module components/weekplanner
 */

import { periodLabel, placementDate, shiftPeriod, weekDays } from '../calendar.js';
import { dotsFor } from '../color.js';
import { dayHeading } from './taskrow.js';
import { taskList } from './tasklist.js';
import { captureForm } from './capture.js';

/**
 * What each day of the week shows. Pure, so it is unit-tested.
 *
 * @param {object[]} tasks
 * @param {string} weekStart Monday, ISO.
 * @param {Set<string>} [shownAbove] Ids already rendered elsewhere on the page.
 * @returns {Array<{iso: string, tasks: object[], all: object[], aboveCount: number}>}
 */
export function weekAgenda(tasks, weekStart, shownAbove = new Set()) {
  const days = weekDays(weekStart);
  /** @type {Map<string, object[]>} */
  const byDay = new Map(days.map((iso) => [iso, []]));

  for (const task of tasks) {
    // Ideas have no day. A finished one still has a completion stamp, which is
    // exactly why it has to be excluded by type rather than by date.
    if (task.type === 'idea') continue;
    const day = placementDate(task);
    if (day && byDay.has(day)) byDay.get(day).push(task);
  }

  const byCreated = (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  return days.map((iso) => {
    const all = byDay.get(iso).sort((a, b) => Number(a.done) - Number(b.done) || byCreated(a, b));
    const tasksHere = all.filter((t) => !shownAbove.has(t.id));
    return { iso, tasks: tasksHere, all, aboveCount: all.length - tasksHere.length };
  });
}

/** "Mon", "Tue" for the strip. */
function shortWeekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

/** "Thursday" for the capture label. */
function longWeekday(iso, today) {
  if (iso === today) return 'today';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * @param {object} args
 * @param {import('../store.js').DailyState} args.state
 * @param {string} args.today
 * @param {string} args.weekStart
 * @param {string} args.thisWeekStart
 * @param {Set<string>} args.shownAbove
 * @param {string|null} args.planDay  Day whose capture box is open.
 * @param {string} args.planDraft
 * @param {(value: string) => void} args.onPlanDraft
 * @param {(iso: string|null) => void} args.onPlanDay
 * @param {(weekStart: string) => void} args.onWeek
 * @param {(task: object) => void} args.onAdd
 * @param {object} args.ctx Shared row/editor callbacks.
 * @returns {HTMLElement}
 */
export function weekPlanner({
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
}) {
  const projects = state.projects ?? [];
  const agenda = weekAgenda(state.tasks ?? [], weekStart, shownAbove);

  const section = document.createElement('section');
  section.className = 'week';

  // ---- heading with week navigation -----------------------------------
  const nav = document.createElement('div');
  nav.className = 'week-nav';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'quiet glyph';
  prev.textContent = '‹';
  prev.setAttribute('aria-label', 'Previous week');
  prev.addEventListener('click', () => onWeek(shiftPeriod('week', weekStart, -1)));

  const title = document.createElement('h2');
  title.className = 'meta week-title';
  title.textContent = weekStart === thisWeekStart ? `This week · ${periodLabel('week', weekStart)}` : periodLabel('week', weekStart);

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'quiet glyph';
  next.textContent = '›';
  next.setAttribute('aria-label', 'Next week');
  next.addEventListener('click', () => onWeek(shiftPeriod('week', weekStart, 1)));

  nav.append(prev, title, next);
  section.append(nav);

  if (weekStart !== thisWeekStart) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'quiet week-back';
    back.textContent = weekStart > thisWeekStart ? '‹ Back to this week' : 'Forward to this week ›';
    back.addEventListener('click', () => onWeek(thisWeekStart));
    section.append(back);
  }

  // ---- the strip ------------------------------------------------------
  const strip = document.createElement('div');
  strip.className = 'week-strip';

  for (const day of agenda) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = [
      'week-cell',
      day.iso === today ? 'is-today' : '',
      day.iso === planDay ? 'is-selected' : '',
      day.iso < today ? 'is-past' : '',
      day.all.length > 0 ? 'has-tasks' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const open = day.all.filter((t) => !t.done).length;
    cell.setAttribute(
      'aria-label',
      `${longWeekday(day.iso, today)}: ${day.all.length} task${day.all.length === 1 ? '' : 's'}, ${open} open. Add a task to this day.`,
    );

    const name = document.createElement('span');
    name.className = 'week-dow';
    name.textContent = shortWeekday(day.iso);

    const number = document.createElement('span');
    number.className = 'cal-num';
    number.textContent = String(Number(day.iso.slice(8, 10)));

    const dots = document.createElement('span');
    dots.className = 'dots';
    const { classes, overflow } = dotsFor(day.all, projects, 3);
    for (const cls of classes) {
      const dot = document.createElement('span');
      dot.className = `dot ${cls}`;
      dots.append(dot);
    }
    if (overflow > 0) {
      const more = document.createElement('span');
      more.className = 'dots-more';
      more.textContent = '+';
      dots.append(more);
    }

    cell.append(name, number, dots);
    cell.addEventListener('click', () => {
      onPlanDay(planDay === day.iso ? null : day.iso);
      // After the re-render, bring that day's box into view.
      globalThis.requestAnimationFrame?.(() => {
        document.getElementById(`plan-${day.iso}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
    strip.append(cell);
  }
  section.append(strip);

  // ---- day by day -----------------------------------------------------
  for (const day of agenda) {
    const block = document.createElement('div');
    block.className = `week-day${day.iso === today ? ' is-today' : ''}${day.iso < today ? ' is-past' : ''}`;

    const head = document.createElement('div');
    head.className = 'week-day-head';

    const heading = document.createElement('h3');
    heading.className = 'meta day-title';
    heading.textContent = dayHeading(day.iso, today);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'quiet week-add';
    add.textContent = planDay === day.iso ? '×' : '+';
    add.setAttribute(
      'aria-label',
      planDay === day.iso ? 'Close' : `Add a task to ${longWeekday(day.iso, today)}`,
    );
    add.setAttribute('aria-expanded', String(planDay === day.iso));
    add.addEventListener('click', () => onPlanDay(planDay === day.iso ? null : day.iso));

    head.append(heading, add);
    block.append(head);

    if (planDay === day.iso) {
      block.append(
        captureForm({
          id: `plan-${day.iso}`,
          label: `Add to ${longWeekday(day.iso, today)}`,
          placeholder: day.iso < today ? 'something you did that day' : 'water GB005',
          state,
          today,
          day: day.iso,
          draft: planDraft,
          onDraft: onPlanDraft,
          onAdd,
          autofocus: true,
        }),
      );
    }

    if (day.tasks.length > 0) block.append(taskList(day.tasks, ctx));
    if (day.aboveCount > 0) {
      const note = document.createElement('p');
      note.className = 'meta week-above';
      note.textContent = `${day.aboveCount} shown above`;
      block.append(note);
    }

    section.append(block);
  }

  return section;
}
