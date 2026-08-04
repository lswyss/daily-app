/**
 * Dot colours for the calendar.
 *
 * Rules, in order:
 *   1. Anything personal gets one fixed colour, always.
 *   2. A lab task with a project gets that project's colour.
 *   3. A lab task with no project gets a neutral default.
 *
 * Colours are assigned by the project's position in `state.projects`, which is
 * append-only, so a project keeps its colour for good. A project not in that list
 * falls back to a hash so it still gets a stable colour rather than none.
 *
 * The palette is deliberately desaturated. This view has more colour than the
 * rest of the app by necessity; it should still look like a field notebook.
 *
 * @module color
 */

/** Number of distinct project colours before they start repeating. */
export const PROJECT_SLOTS = 6;

/** Stable small hash, so an unlisted project still gets a consistent colour. */
function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) % 100_003;
  }
  return h;
}

/**
 * The CSS class carrying this task's dot colour.
 * @param {{scope?: string, project?: string|null}} task
 * @param {string[]} projects Known projects, in `state.projects` order.
 * @returns {string}
 */
export function dotClass(task, projects = []) {
  if (task.scope === 'personal') return 'dot-personal';
  if (!task.project) return 'dot-default';

  const index = projects.indexOf(task.project);
  const slot = (index >= 0 ? index : hash(task.project)) % PROJECT_SLOTS;
  return `dot-p${slot + 1}`;
}

/**
 * The distinct dot colours present in a day's tasks, in a stable order, capped so
 * a busy day does not turn into a smear.
 *
 * @param {object[]} tasks
 * @param {string[]} projects
 * @param {number} [max]
 * @returns {{classes: string[], overflow: number, total: number}}
 */
export function dotsFor(tasks, projects = [], max = 4) {
  /** @type {string[]} */
  const ordered = [];
  for (const task of tasks) {
    const cls = dotClass(task, projects);
    if (!ordered.includes(cls)) ordered.push(cls);
  }
  return {
    classes: ordered.slice(0, max),
    overflow: Math.max(0, ordered.length - max),
    total: tasks.length,
  };
}

/**
 * The single colour that best represents a day, for the year view where there is
 * only room for one dot. The most common colour wins; ties go to the earliest
 * task, so the result is deterministic.
 *
 * @param {object[]} tasks
 * @param {string[]} projects
 * @returns {string|null}
 */
export function dominantDotClass(tasks, projects = []) {
  if (tasks.length === 0) return null;

  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {string[]} */
  const order = [];
  for (const task of tasks) {
    const cls = dotClass(task, projects);
    if (!counts.has(cls)) order.push(cls);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }

  let best = order[0];
  for (const cls of order) {
    if ((counts.get(cls) ?? 0) > (counts.get(best) ?? 0)) best = cls;
  }
  return best;
}

/**
 * The legend for the current view: only the colours actually on screen, so it
 * does not list projects the user cannot see.
 *
 * @param {object[]} tasks
 * @param {string[]} projects
 * @returns {Array<{label: string, cls: string}>}
 */
export function legendFor(tasks, projects = []) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const task of tasks) {
    const cls = dotClass(task, projects);
    if (seen.has(cls)) continue;
    seen.set(
      cls,
      task.scope === 'personal' ? 'Personal' : (task.project ?? 'Lab, no project'),
    );
  }
  // Personal last: it is the constant, and the projects are what vary.
  return [...seen.entries()]
    .map(([cls, label]) => ({ cls, label }))
    .sort((a, b) => {
      if (a.cls === 'dot-personal') return 1;
      if (b.cls === 'dot-personal') return -1;
      return a.label.localeCompare(b.label);
    });
}
