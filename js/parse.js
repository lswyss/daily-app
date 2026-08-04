/**
 * Quick-capture parsing: one line of text → a task, plus what we understood.
 *
 * Built for phone dictation, which arrives with no punctuation, run-on phrasing,
 * inconsistent casing, and mangled construct codes. Three rules follow from that:
 *
 * 1. Relative dates resolve to absolute ISO **here**, at entry. The store never
 *    holds the word "tomorrow".
 * 2. A code that looks like an experiment is *suggested*, never auto-attached.
 *    Near-matches against known values must prompt. Never auto-create a tag.
 * 3. Everything we inferred is reported back so the UI can show it before the
 *    task is committed. A misheard GB005 has to be catchable in one glance.
 *
 * Pure and DOM-free. `today` is injected so tests do not depend on the clock.
 *
 * @module parse
 */

/**
 * Local calendar date as YYYY-MM-DD. Local, not UTC: at 23:00 PDT the UTC date is
 * already tomorrow, and "today" must mean the user's today.
 * @param {Date} [date]
 * @returns {string}
 */
export function todayIso(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The **local** calendar date an instant fell on.
 *
 * `completedAt` is a UTC timestamp, so slicing the first ten characters off it is
 * wrong: ticking something off at 6:30pm in California stores `…T01:30:00Z` the
 * following day, and the slice would file the work under tomorrow. Anything that
 * asks "which day did this happen on" must come through here.
 *
 * @param {string|null|undefined} timestamp
 * @returns {string|null} ISO date, or null if there is nothing usable.
 */
export function localDateOf(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return todayIso(date);
}

/**
 * Add days to an ISO date. Done in UTC so daylight saving cannot shift the result.
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Day of week for an ISO date. 0 = Sunday.
 * @param {string} iso
 * @returns {number}
 */
export function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Whole-day difference between two ISO dates (b - a). */
export function daysBetween(a, b) {
  const toMs = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(b) - toMs(a)) / 86_400_000);
}

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAY_ALTERNATION = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
const MONTH_ALTERNATION = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/** Pad to a valid ISO date, or return null if the calendar rejects it. */
function isoFrom(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Find and resolve a date phrase.
 *
 * Returns the absolute date plus the exact text matched, so the caller can strip
 * it from the title. First match wins; patterns are ordered most-specific first.
 *
 * @param {string} text
 * @param {string} today ISO date
 * @returns {{due: string, matched: string, phrase: string}|null}
 */
export function findDate(text, today) {
  /** @type {Array<[RegExp, (m: RegExpMatchArray) => string|null]>} */
  const patterns = [
    // Explicit ISO — unambiguous, so first.
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => isoFrom(+m[1], +m[2], +m[3])],

    [/\b(today|tonight|this (?:morning|afternoon|evening)|eod|end of (?:the )?day)\b/i, () => today],
    // Must precede the bare "tomorrow" pattern, which would otherwise match inside it.
    [/\b(?:the )?day after tomorrow\b/i, () => addDays(today, 2)],
    [/\b(tomorrow|tomorow|tommorow|tmrw|tmw)\b/i, () => addDays(today, 1)],
    [/\byesterday\b/i, () => addDays(today, -1)],

    [/\bin (\d+) days?\b/i, (m) => addDays(today, +m[1])],
    [/\bin a (week|fortnight)\b/i, (m) => addDays(today, m[1].toLowerCase() === 'week' ? 7 : 14)],
    [/\bin (\d+) weeks?\b/i, (m) => addDays(today, +m[1] * 7)],
    [/\bnext week\b/i, () => addDays(today, 7)],

    // "next friday" skips a Friday that is today or the coming one.
    [
      new RegExp(`\\bnext (${WEEKDAY_ALTERNATION})\\b`, 'i'),
      (m) => {
        const target = WEEKDAYS[m[1].toLowerCase()];
        const ahead = (target - weekdayOf(today) + 7) % 7;
        return addDays(today, ahead === 0 ? 7 : ahead + 7);
      },
    ],
    // Bare "friday" means the coming Friday, and today counts if it matches.
    [
      new RegExp(`\\b(?:on )?(${WEEKDAY_ALTERNATION})\\b`, 'i'),
      (m) => {
        const target = WEEKDAYS[m[1].toLowerCase()];
        return addDays(today, (target - weekdayOf(today) + 7) % 7);
      },
    ],

    // "aug 5", "august 5th", "aug 5 2027"
    [
      new RegExp(`\\b(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'i'),
      (m) => monthDay(MONTHS[m[1].toLowerCase()], +m[2], m[3] ? +m[3] : null, today),
    ],
    // "5 august", "5th of august"
    [
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALTERNATION})\\b`, 'i'),
      (m) => monthDay(MONTHS[m[2].toLowerCase()], +m[1], null, today),
    ],
    // "8/5" — US month/day, matching how the rest of the lab writes dates.
    [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
      const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
      return monthDay(+m[1], +m[2], year, today);
    }],
  ];

  for (const [pattern, resolve] of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const due = resolve(match);
    if (due) return { due, matched: match[0], phrase: match[0].trim() };
  }
  return null;
}

/**
 * Resolve a month/day, inferring the year. An explicit year wins; otherwise pick
 * the next occurrence, so "jan 5" in December means next January, not ten months ago.
 */
function monthDay(month, day, year, today) {
  const thisYear = +today.slice(0, 4);
  if (year != null) return isoFrom(year, month, day);
  const candidate = isoFrom(thisYear, month, day);
  if (candidate && candidate >= today) return candidate;
  return isoFrom(thisYear + 1, month, day);
}

/** Levenshtein distance, iterative and small. */
export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const row = [i];
    for (let j = 1; j <= n; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n];
}

/** Strip to comparable form: uppercase alphanumerics only. */
function normaliseTag(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Classify a candidate tag against the values we already know.
 *
 * Deliberately biased toward prompting. `E012` and `E0013_PegTreatment` are not
 * close by edit distance, so shared-letter-prefix-with-digits also counts as a
 * near match — the spec requires that pair to prompt.
 *
 * @param {string} candidate
 * @param {string[]} known
 * @returns {{status: 'known'|'near'|'new', value: string, suggestions: string[]}}
 */
export function classifyTag(candidate, known = []) {
  const target = normaliseTag(candidate);
  if (target === '') return { status: 'new', value: candidate, suggestions: [] };

  for (const value of known) {
    if (normaliseTag(value) === target) {
      return { status: 'known', value, suggestions: [] };
    }
  }

  // Split "E0013_PegTreatment" into its leading code, E + 0013. Comparing those
  // is what catches the spec's E012 / E0013_PegTreatment pair, which edit
  // distance misses entirely because of the trailing words.
  const leadingCode = (value) => {
    const match = normaliseTag(value).match(/^([A-Z]*)(\d+)/);
    return match ? { alpha: match[1], num: Number(match[2]) } : null;
  };
  const candidateCode = leadingCode(candidate);

  const suggestions = known.filter((value) => {
    const other = normaliseTag(value);
    if (other.startsWith(target) || target.startsWith(other)) return true;
    if (editDistance(target, other) <= 2) return true;

    const otherCode = leadingCode(value);
    return Boolean(
      candidateCode &&
        otherCode &&
        candidateCode.alpha === otherCode.alpha &&
        Math.abs(candidateCode.num - otherCode.num) <= 2,
    );
  });

  return suggestions.length > 0
    ? { status: 'near', value: candidate, suggestions }
    : { status: 'new', value: candidate, suggestions: [] };
}

/** Looks like a construct or experiment code: 1–4 letters then 2–5 digits. */
const CODE_PATTERN = /\b([A-Za-z]{1,4})[\s-]?(\d{2,5})\b/;

/** Words that precede digits innocently and must not become codes. */
const CODE_STOPWORDS = new Set(['DAY', 'RUN', 'REP', 'SET', 'NO', 'PH', 'AT', 'X', 'OD']);

/**
 * @typedef {object} ParsedCapture
 * @property {string} title       Cleaned title, date phrase and tags removed.
 * @property {'lab'|'personal'} scope
 * @property {string} type
 * @property {string} due         Absolute ISO date.
 * @property {boolean} dueAssumed True when no date was found and today was assumed.
 * @property {{status: string, value: string, suggestions: string[]}|null} experiment
 * @property {{status: string, value: string, suggestions: string[]}|null} project
 * @property {{date: string|null, scope: string|null, type: string|null}} matched
 * @property {string[]} notes     Things the UI should say out loud.
 * @property {string} raw
 */

/**
 * Parse one captured line.
 *
 * @param {string} raw
 * @param {{today?: string, projects?: string[], experiments?: string[], defaultScope?: 'lab'|'personal'}} [context]
 * @returns {ParsedCapture}
 */
export function parseCapture(raw, context = {}) {
  const today = context.today ?? todayIso();
  const projects = context.projects ?? [];
  const experiments = context.experiments ?? [];
  const defaultScope = context.defaultScope ?? 'lab';

  const original = String(raw ?? '');
  let working = original.replace(/\s+/g, ' ').trim();

  /** @type {string[]} */
  const notes = [];
  const matched = { date: null, scope: null, type: null };

  // --- scope ------------------------------------------------------------
  let scope = defaultScope;
  const scopeMatch = working.match(/#(lab|personal|home|work)\b/i);
  if (scopeMatch) {
    const word = scopeMatch[1].toLowerCase();
    scope = word === 'personal' || word === 'home' ? 'personal' : 'lab';
    matched.scope = scopeMatch[0];
    working = working.replace(scopeMatch[0], ' ');
  }

  // --- type -------------------------------------------------------------
  let type = 'task';
  const typeMatch = working.match(/#(task|meeting|reading|idea|appointment)\b/i);
  if (typeMatch) {
    type = typeMatch[1].toLowerCase();
    matched.type = typeMatch[0];
    working = working.replace(typeMatch[0], ' ');
  }

  // --- explicit tags ----------------------------------------------------
  // @code marks an experiment, +name marks a project. Both still get classified,
  // so an explicit @GB005 that is not yet known still asks before being created.
  /** @type {string|null} */
  let experimentCandidate = null;
  const atMatch = working.match(/(?:^|\s)@([A-Za-z0-9_-]+)/);
  if (atMatch) {
    experimentCandidate = atMatch[1];
    working = working.replace(atMatch[0], ' ');
  }

  /** @type {string|null} */
  let projectCandidate = null;
  const plusMatch = working.match(/(?:^|\s)\+([A-Za-z0-9_-]+)/);
  if (plusMatch) {
    projectCandidate = plusMatch[1];
    working = working.replace(plusMatch[0], ' ');
  }

  // --- date -------------------------------------------------------------
  const found = findDate(working, today);
  let due = today;
  let dueAssumed = true;
  if (found) {
    due = found.due;
    dueAssumed = false;
    matched.date = found.phrase;
    working = working.replace(found.matched, ' ');
    if (due < today) {
      notes.push(`That date (${due}) is in the past.`);
    }
  }

  // --- title ------------------------------------------------------------
  let title = working.replace(/\s+/g, ' ').trim().replace(/^[-–—:,]\s*/, '');
  // Dictation delivers everything lowercase; a leading capital costs nothing.
  if (title) title = title[0].toUpperCase() + title.slice(1);

  // --- implicit code detection -----------------------------------------
  // Only if no explicit @tag was given. The code is left in the title on purpose:
  // the title should still read naturally, and tagging is a separate decision.
  if (!experimentCandidate) {
    const codeMatch = title.match(CODE_PATTERN);
    if (codeMatch && !CODE_STOPWORDS.has(codeMatch[1].toUpperCase())) {
      experimentCandidate = `${codeMatch[1].toUpperCase()}${codeMatch[2]}`;
      // Dictation gives "e012" or "gb 005". Normalise the code where it sits in
      // the title so the row reads like a lab notebook rather than a transcript.
      title = title.replace(codeMatch[0], experimentCandidate);
    }
  }

  const experiment = experimentCandidate ? classifyTag(experimentCandidate, experiments) : null;
  const project = projectCandidate ? classifyTag(projectCandidate, projects) : null;

  if (experiment?.status === 'near') {
    notes.push(
      `${experiment.value} is close to ${experiment.suggestions.join(', ')} — confirm which you meant.`,
    );
  }
  if (project?.status === 'near') {
    notes.push(`${project.value} is close to ${project.suggestions.join(', ')} — confirm which you meant.`);
  }
  if (dueAssumed) notes.push('No date heard, so this is filed under today.');
  if (!title) notes.push('No title left after parsing — say what the task is.');

  return {
    title,
    scope,
    type,
    due,
    dueAssumed,
    experiment,
    project,
    matched,
    notes,
    raw: original,
  };
}

/**
 * Turn a parsed capture into a task, given the user's decisions in the preview.
 *
 * Tags are attached only when explicitly accepted. This is the enforcement point
 * for "never auto-create a tag" — a `new` or `near` candidate that the user did
 * not confirm is simply dropped.
 *
 * @param {ParsedCapture} parsed
 * @param {{id: string, now?: string, source?: string, acceptExperiment?: string|null, acceptProject?: string|null}} decisions
 * @returns {object}
 */
export function toTask(parsed, decisions) {
  const now = decisions.now ?? new Date().toISOString();
  const acceptedExperiment =
    decisions.acceptExperiment ??
    (parsed.experiment?.status === 'known' ? parsed.experiment.value : null);
  const acceptedProject =
    decisions.acceptProject ?? (parsed.project?.status === 'known' ? parsed.project.value : null);

  return {
    id: decisions.id,
    title: parsed.title,
    scope: parsed.scope,
    type: parsed.type,
    project: acceptedProject,
    experiment: acceptedExperiment,
    due: parsed.due,
    done: false,
    completedAt: null,
    createdAt: now,
    source: decisions.source ?? 'app',
    notes: '',
  };
}

/**
 * Generate a task id. Matches the shape in the README's schema.
 * @param {string} [now] ISO timestamp
 * @param {() => number} [random]
 */
export function newTaskId(now = new Date().toISOString(), random = Math.random) {
  const stamp = now.replace(/[-:]/g, '').replace(/\.\d+/, '').replace('Z', '');
  const suffix = Math.floor(random() * 0xfff)
    .toString(16)
    .padStart(3, '0');
  return `t_${stamp}_${suffix}`;
}
