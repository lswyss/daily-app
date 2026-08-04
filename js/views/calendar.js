/**
 * Calendar view: past and future at three zoom levels.
 *
 * Week shows titles, month shows dots, year shows density. The Today view stays
 * the landing page; this is a place you go deliberately and come back from.
 *
 * All grid arithmetic lives in `calendar.js` and all colour rules in `color.js`,
 * both pure and tested. This file is only DOM.
 *
 * @module views/calendar
 */

import {
  ZOOMS,
  bucketByDue,
  monthGrid,
  periodLabel,
  rangeOf,
  shiftPeriod,
  weekDays,
  weekdayNames,
  yearMonths,
} from '../calendar.js';
import { dominantDotClass, dotsFor, legendFor } from '../color.js';
import { dayHeading } from '../components/taskrow.js';
import { taskList } from '../components/tasklist.js';

/** @param {string} iso */
function dayNumber(iso) {
  return String(Number(iso.slice(8, 10)));
}

/** A row of coloured dots for a day cell. */
function dotRow(tasks, projects, max) {
  const wrap = document.createElement('span');
  wrap.className = 'dots';
  if (tasks.length === 0) return wrap;

  const { classes, overflow } = dotsFor(tasks, projects, max);
  for (const cls of classes) {
    const dot = document.createElement('span');
    dot.className = `dot ${cls}`;
    wrap.append(dot);
  }
  if (overflow > 0) {
    const more = document.createElement('span');
    more.className = 'dots-more';
    more.textContent = '+';
    wrap.append(more);
  }
  return wrap;
}

/** Accessible summary for a day cell, so it is not just coloured dots. */
function daySummary(iso, tasks) {
  if (tasks.length === 0) return `${iso}, nothing scheduled`;
  const open = tasks.filter((t) => !t.done).length;
  return `${iso}, ${tasks.length} task${tasks.length === 1 ? '' : 's'}, ${open} open`;
}

// ------------------------------------------------------------------- week

function weekView({ anchor, byDate, ctx, projects }) {
  const wrap = document.createElement('div');
  wrap.className = 'cal-week';

  for (const iso of weekDays(anchor)) {
    const tasks = byDate.get(iso) ?? [];

    const section = document.createElement('section');
    section.className = `cal-day${iso === ctx.today ? ' is-today' : ''}`;

    const heading = document.createElement('h3');
    heading.className = 'meta day-title';
    heading.textContent = dayHeading(iso, ctx.today);
    if (tasks.length > 0) heading.append(dotRow(tasks, projects, 6));
    section.append(heading);

    if (tasks.length === 0) {
      const none = document.createElement('p');
      none.className = 'cal-empty meta';
      none.textContent = '—';
      section.append(none);
    } else {
      section.append(taskList(tasks, ctx));
    }

    wrap.append(section);
  }
  return wrap;
}

// ------------------------------------------------------------------ month

function monthView({ anchor, byDate, ctx, projects, selected, onSelectDay }) {
  const wrap = document.createElement('div');
  wrap.className = 'cal-month';

  const header = document.createElement('div');
  header.className = 'cal-dow';
  for (const name of weekdayNames()) {
    const cell = document.createElement('span');
    cell.className = 'meta';
    cell.textContent = name;
    header.append(cell);
  }
  wrap.append(header);

  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  for (const week of monthGrid(anchor).weeks) {
    for (const cell of week) {
      const tasks = byDate.get(cell.iso) ?? [];

      const button = document.createElement('button');
      button.type = 'button';
      button.className = [
        'cal-cell',
        cell.inMonth ? '' : 'is-outside',
        cell.iso === ctx.today ? 'is-today' : '',
        cell.iso === selected ? 'is-selected' : '',
        tasks.length === 0 ? 'is-empty' : '',
      ]
        .filter(Boolean)
        .join(' ');
      button.setAttribute('aria-label', daySummary(cell.iso, tasks));
      button.setAttribute('aria-pressed', String(cell.iso === selected));

      const number = document.createElement('span');
      number.className = 'cal-num';
      number.textContent = dayNumber(cell.iso);

      button.append(number, dotRow(tasks, projects, 4));
      button.addEventListener('click', () => onSelectDay(cell.iso));
      grid.append(button);
    }
  }
  wrap.append(grid);

  // The selected day's tasks, below the grid rather than in a popover — a
  // popover on a 375px screen would cover the calendar it came from.
  if (selected) {
    const tasks = byDate.get(selected) ?? [];
    const panel = document.createElement('section');
    panel.className = 'cal-selected';

    const heading = document.createElement('h3');
    heading.className = 'meta day-title';
    heading.textContent = dayHeading(selected, ctx.today);
    panel.append(heading);

    if (tasks.length === 0) {
      const none = document.createElement('p');
      none.className = 'cal-empty';
      none.textContent = 'Nothing scheduled.';
      panel.append(none);
    } else {
      panel.append(taskList(tasks, ctx));
    }
    wrap.append(panel);
  }

  return wrap;
}

// ------------------------------------------------------------------- year

function yearView({ anchor, byDate, ctx, projects, onZoomTo }) {
  const wrap = document.createElement('div');
  wrap.className = 'cal-year';

  for (const monthAnchor of yearMonths(anchor)) {
    const block = document.createElement('section');
    block.className = 'cal-mini';

    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'cal-mini-title meta';
    heading.textContent = periodLabel('month', monthAnchor).replace(/\s\d{4}$/, '');
    heading.addEventListener('click', () => onZoomTo('month', monthAnchor));
    block.append(heading);

    const grid = document.createElement('div');
    grid.className = 'cal-mini-grid';

    for (const week of monthGrid(monthAnchor).weeks) {
      for (const cell of week) {
        const tasks = cell.inMonth ? (byDate.get(cell.iso) ?? []) : [];
        const pip = document.createElement('span');
        const cls = dominantDotClass(tasks, projects);
        pip.className = [
          'cal-pip',
          cell.inMonth ? '' : 'is-outside',
          cell.iso === ctx.today ? 'is-today' : '',
          cls ? `dot ${cls}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        if (tasks.length > 0) pip.title = daySummary(cell.iso, tasks);
        grid.append(pip);
      }
    }

    block.append(grid);
    wrap.append(block);
  }

  return wrap;
}

// ------------------------------------------------------------------- shell

/**
 * @param {object} args
 * @param {import('../store.js').DailyState} args.state
 * @param {string} args.today
 * @param {'week'|'month'|'year'} args.zoom
 * @param {string} args.anchor
 * @param {string|null} args.selected
 * @param {(zoom: string, anchor?: string) => void} args.onZoom
 * @param {(anchor: string) => void} args.onAnchor
 * @param {(iso: string) => void} args.onSelectDay
 * @param {() => void} args.onBack
 * @param {HTMLElement} [args.badge]
 * @param {object} args.listCtx Shared row/editor callbacks.
 * @returns {HTMLElement}
 */
export function renderCalendar({
  state,
  today,
  zoom,
  anchor,
  selected,
  onZoom,
  onAnchor,
  onSelectDay,
  onBack,
  badge,
  listCtx,
}) {
  const view = document.createElement('div');
  view.className = 'calendar';

  const projects = state.projects ?? [];
  const { byDate, undated } = bucketByDue(state.tasks ?? []);
  const ctx = { ...listCtx, today };

  // ---- header ----------------------------------------------------------
  const header = document.createElement('header');
  header.className = 'cal-header';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'quiet icon';
  back.textContent = '← Tasks';
  back.addEventListener('click', onBack);

  const top = document.createElement('div');
  top.className = 'cal-top';
  top.append(back);
  if (badge) top.append(badge);
  view.append(top);

  const nav = document.createElement('div');
  nav.className = 'cal-nav';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'quiet glyph';
  prev.textContent = '‹';
  prev.setAttribute('aria-label', 'Previous');
  prev.addEventListener('click', () => onAnchor(shiftPeriod(zoom, anchor, -1)));

  const title = document.createElement('h1');
  title.className = 'cal-title';
  title.textContent = periodLabel(zoom, anchor);

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'quiet glyph';
  next.textContent = '›';
  next.setAttribute('aria-label', 'Next');
  next.addEventListener('click', () => onAnchor(shiftPeriod(zoom, anchor, 1)));

  nav.append(prev, title, next);
  header.append(nav);

  // Zoom control. Explicit buttons rather than pinch: pinch is undiscoverable
  // and unusable with a keyboard.
  const zooms = document.createElement('div');
  zooms.className = 'cal-zooms';
  for (const level of ZOOMS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip is-choice';
    button.textContent = level;
    button.setAttribute('aria-pressed', String(level === zoom));
    button.addEventListener('click', () => onZoom(level));
    zooms.append(button);
  }
  header.append(zooms);
  view.append(header);

  // A way back to now, shown only when now is off screen.
  const { from, to } = rangeOf(zoom, anchor);
  if (today < from || today > to) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'quiet cal-jump';
    jump.textContent = today < from ? '‹ Back to today' : 'Jump to today ›';
    jump.addEventListener('click', () => onAnchor(today));
    view.append(jump);
  }

  // ---- body ------------------------------------------------------------
  if (zoom === 'week') {
    view.append(weekView({ anchor, byDate, ctx, projects }));
  } else if (zoom === 'month') {
    view.append(monthView({ anchor, byDate, ctx, projects, selected, onSelectDay }));
  } else {
    view.append(
      yearView({
        anchor,
        byDate,
        ctx,
        projects,
        onZoomTo: (level, target) => onZoom(level, target),
      }),
    );
  }

  // ---- legend ----------------------------------------------------------
  // Only what is visible in this period, so it never lists projects off screen.
  const visible = [];
  for (const [iso, tasks] of byDate) {
    if (iso >= from && iso <= to) visible.push(...tasks);
  }
  const legend = legendFor(visible, projects);
  if (legend.length > 0) {
    const box = document.createElement('div');
    box.className = 'cal-legend';
    for (const entry of legend) {
      const item = document.createElement('span');
      item.className = 'cal-legend-item meta';
      const dot = document.createElement('span');
      dot.className = `dot ${entry.cls}`;
      item.append(dot, document.createTextNode(entry.label));
      box.append(item);
    }
    view.append(box);
  }

  // Undated tasks have no cell to live in, so surface them rather than hide them.
  if (undated.length > 0) {
    const box = document.createElement('details');
    box.className = 'upcoming';
    const summary = document.createElement('summary');
    summary.textContent = `No date · ${undated.length}`;
    box.append(summary, taskList(undated, ctx));
    view.append(box);
  }

  return view;
}
