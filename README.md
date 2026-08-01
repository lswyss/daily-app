# Daily

A personal daily task and experiment dashboard. Single user, private data, no backend,
no build step, no paid services.

**This README is written for the reader who comes back in a year after something broke.**
That reader is you. Update it in the same commit as any change that affects it.

Live at: https://lswyss.github.io/daily-app/

---

## Architecture

**A static web app on GitHub Pages. A private GitHub repo is the database.**

```
  iPhone Safari  ────┐
                     │
  Mac browser    ────┼──→  api.github.com  ──→  private repo: daily-data
                     │                             ├── data.json      (state)
  Apple Shortcut ────┘                             └── inbox/*.json   (captures)
                                                          │
  Mac: Claude Code ──→ local git clone ───────────────────┘
```

| Piece | What it is |
|---|---|
| `daily-app` | **Public** repo (this one), served by GitHub Pages. Contains no secrets, no data. |
| `daily-data` | **Private** repo. Holds `data.json` and `inbox/`. |
| Auth | GitHub fine-grained PAT scoped to `daily-data` only, contents read/write. Entered once per device, kept in `localStorage`, never committed. |
| Local clone | Both repos cloned into the iCloud `TheDaily/` folder so Finder and Claude Code can touch real files. |
| Capture | Apple Shortcut with a Siri phrase, creates a new file in `inbox/`. |

### Why this repo is public

On GitHub Free, Pages requires a public repo — the docs are explicit: "If the account that
owns the repository uses GitHub Free or GitHub Free for organizations, the repository must
be public."

More importantly: **a Pages site is publicly reachable on the internet even when built from
a private repo.** Only GitHub Enterprise Cloud can make the site itself private. So paying
for Pro would not buy privacy here. The correct design under any plan is the one in use:
code public, data in a separate private repo, reached at runtime with a scoped token.

**Therefore: never commit application data to this repo.** Not a sample `data.json` with
real tasks, not a debug dump, not a screenshot of the task list.

### Why this shape

- **Free and serverless.** No backend to deploy, no database, no bill.
- **Real sync.** Both devices read and write the same file. This requirement eliminated
  every local-file approach.
- **Archive for free.** Commit-on-save gives timestamped history with diffs. This is why
  there is no nightly snapshot job — it would be strictly worse than `git log`.
- **Conflict safety is built in.** The GitHub contents API requires the current blob SHA to
  write, so stale writes are rejected server-side rather than silently overwriting.
- **Auth comes free.** A token-based store avoids building an auth layer, which is the main
  hidden cost of the Cloudflare and Vercel alternatives.

### Alternatives rejected, and why

| Option | Why not |
|---|---|
| Browser `localStorage` as source of truth | Per device. Phone and Mac would hold unrelated copies. |
| File System Access API | Desktop Chrome only. Unsupported on iOS. |
| iCloud Drive as the store | **Hard blocker.** iOS Safari has no filesystem access, and iOS will not launch an HTML app from Files (Quick Look, JS disabled). No usable browser API for iCloud Drive exists. |
| Google Drive as the store | Workable via the Drive API, but needs OAuth setup and loses `git log` as the archive. Reconsider only if GitHub becomes unworkable. |
| Google Drive connector (Claude chat) | Can create files but cannot edit them. This caused the duplicate-file mess in the previous system. |
| Cloudflare Workers + D1 | Also free, but adds a deploy pipeline and requires building auth from scratch. |
| Nightly cron push | Solves a problem commit-on-save already solved. |
| Obsidian + Git plugin | Viable and lower effort, but no custom dashboard and fragile git-on-iOS. **This is the fallback if this project is abandoned.** |

### Tech stack

Vanilla JavaScript, ES modules, no build step. Deploy is `git push`; Pages serves the files
as-is. JSDoc comments for type hints — editors and Claude Code read them with no build.

A build pipeline is one more thing that breaks in eighteen months. **Revisit this decision
first** if the code exceeds roughly 2000 lines or state management starts fighting back;
the migration path is Vite + React + a Pages Action. Do not pre-emptively take that cost.

`github.js`, `store.js`, `parse.js`, and the pure parts of `sync.js` must have no DOM
dependencies, so they stay testable under `node --test` with a mocked fetch.

### Code map

| File | Responsibility |
|---|---|
| `js/parse.js` | Quick-capture parsing: text → task, plus what was understood. Dictation-tolerant. Pure; `today` is injected. |
| `js/views/today.js` | The Today view and the confirm-before-file capture preview. `groupForToday` is pure and tested. |
| `js/components/taskrow.js` | A task row, shaped like a specimen label. Box completes, text opens the editor. |
| `js/components/taskeditor.js` | Inline editor. Emits which fields changed, not a whole task. |
| `js/components/syncbadge.js` | The sync badge. `badgeState` is pure and tested. |
| `dev/preview.html` | Design fixture: renders Today against fixed sample data, no token, no network. Not linked from the app; safe to delete. |
| `js/config.js` | Device config: token plus which repo holds the data. Storage injected, so it is unit-tested. |
| `js/main.js` | Entry point and routing. |
| `js/views/setup.js` | Token entry, live validation against the data repo, sign-out. |
| `js/github.js` | Contents-API wrapper: read, write-with-SHA, list, delete, `verifyAccess`. One error class per failure mode, because "token died", "someone wrote first", and "you are offline" need three different UI responses. |
| `js/store.js` | State shape, validation, the mutation log, and the replay reducer. Pure; storage is injected. |
| `js/sync.js` | Debounced flushing, the retry-once conflict flow, flush serialisation, and inbox-drain planning. |
| `test/helpers.js` | Recording fetch mock, memory storage, manual timers. No network, no DOM, no real clock. |

`package.json` exists **only** so `node --test` parses these as ES modules. There is still
no build step; the browser loads the same files natively.

### Running the tests

```bash
cd daily-app && npm test
```

Node 25 note: `node --test test/` fails (it tries to load `test` as a module). The glob
form in `package.json` — `node --test test/*.test.js` — is the one that works.

### Invariants the tests pin down

These are the properties worth breaking a build over. Each has a named test.

- A rejected write re-reads, replays the queued ops against fresh state, and retries
  **exactly once**. A second rejection returns `status: 'conflict'` and **leaves the queue
  intact.** It never loops.
- Only *confirmed* writes are dropped from the queue (`dropFirst`, not `clear`), so taps
  made while a flush is in flight are never discarded.
- A file over 1MB comes back from the contents API with `content: ""`. Reading that as an
  empty `data.json` would wipe everything on the next write, so it throws instead.
- A missing `data.json` is an error, not an invitation to create one.
- `parseState` refuses a schema version newer than this build, rather than writing an older
  shape back over whatever a newer app added.
- An op against a task that vanished remotely is reported in `skipped`, never swallowed.
- `statusFor` cannot return `synced` for anything that did not land.
- Draining the same capture twice produces the same task id, so the second `add` is a no-op.
- A token that fails validation is **never stored.** A stored-but-broken token turns every
  later failure into a mystery.
- Signing out clears the queued mutations along with the token, so one account's unsynced
  edits can never replay against another account's data.
- `parseCapture` never attaches a tag on its own. A near or new experiment code is offered
  and must be tapped. `E012` against a known `E0013_PegTreatment` prompts — edit distance
  alone misses that pair, so the leading letter-and-number code is compared separately.
- Relative dates resolve to absolute ISO at entry. The store never holds "tomorrow".
- Date maths runs in UTC on ISO strings, so a daylight-saving boundary cannot shift a due
  date, while "today" is computed from the *local* calendar date.

## Using the quick capture

Type or dictate one line and press Enter. **Nothing else is required** — scope, dates, and
tags are all optional with defaults.

Most captures file straight away on Enter, with a toast offering Undo. The confirm-before-
file preview appears **only when there is something worth catching**: an experiment or
project code that is new or a near-miss, an empty title, or a date in the past. Once you
have confirmed a code such as `GB005` once, it is registered and never asked about again.

| You say | It understands |
|---|---|
| `sow seeds GB005 tomorrow` | title, date → absolute, offers experiment `GB005` |
| `water gb 005` | the dictated space is closed up → `GB005`, title normalised |
| `dentist tuesday #personal` | personal scope, next Tuesday |
| `transfer plates aug 5` / `8/5` / `2026-08-05` | all the same date |
| `check in 3 days`, `next friday`, `day after tomorrow` | resolved from today |
| `lab meeting friday #meeting` | type `meeting` |

Defaults worth knowing: scope is **lab** unless you say `#personal` (tap the chip in the
preview to flip it), and a capture with **no date is filed under today** rather than
becoming invisible. Type is only ever set by an explicit `#tag` — wording is not guessed at.

## Working with tasks

Each row has two targets, both at least 44px:

- **The box** completes the task, with Undo in the toast.
- **The text** opens an inline editor — change the title, move the date with the native
  picker, switch lab/personal, or **Delete** (confirmed, with Undo).

Saving emits the smallest mutations that describe what you did: a date change becomes
`reschedule`, everything else becomes `edit`, and changing nothing writes nothing. That is
what keeps `git log` readable as a record of intent.

**Upcoming** at the bottom lists everything scheduled beyond today, grouped by day and
collapsed by default. It exists so a task you just added for Sunday can be confirmed to
exist — a bare count could not do that. Undated tasks sit last under "No date". The
open/closed state survives a re-render, so completing something does not fold it back up.

## A note on caching

GitHub Pages serves assets with a ten-minute cache. After a push, a browser that already
has the app open may keep running the old JavaScript for a few minutes. A normal reload is
often not enough; close the tab, or wait it out. This bites during development, not use.

---

## `data.json` schema

```json
{
  "version": 1,
  "updatedAt": "2026-07-31T08:14:00Z",
  "tasks": [
    {
      "id": "t_2026-07-31T081200_a3f",
      "title": "Sow seeds for GB005",
      "scope": "lab",
      "type": "task",
      "project": "Globot",
      "experiment": "GB005",
      "due": "2026-08-01",
      "done": false,
      "completedAt": null,
      "createdAt": "2026-07-31T08:12:00Z",
      "source": "shortcut",
      "notes": ""
    }
  ],
  "experiments": [
    {
      "id": "E0013_PegTreatment",
      "label": "PEG drought stress and recovery",
      "project": "PEG Treatment",
      "startDate": "2026-07-28",
      "active": true,
      "milestones": [
        { "day": 0, "label": "Transfer to PEG plates" },
        { "day": 7, "label": "Move to recovery plates" }
      ]
    }
  ],
  "projects": ["Globot", "PEG Treatment"]
}
```

Rules:

- `scope` — required, `lab` | `personal`.
- `type` — `task` | `meeting` | `reading` | `idea` | `appointment`.
- `project`, `experiment` — optional, free-form. The UI offers existing values first and
  requires **explicit confirmation** before creating a new one. Near-matches (`E012` vs
  `E0013_PegTreatment`) must prompt. **Never auto-create a tag.**
- Dates are absolute ISO. **Never store relative wording** — "tomorrow" resolves at entry.
- `source` — `app` | `shortcut` | `claude-code`. Useful for debugging capture quality.
- Completed tasks are **never deleted**. `done: true` plus `completedAt`; they drop out of
  active views. History lives in the JSON and in git.

### `inbox/*.json`

Append-only, one file per capture, named by timestamp:
`inbox/2026-07-31T0814-a3f.json`

```json
{ "raw": "sow seeds for GB005 tomorrow", "capturedAt": "2026-07-31T08:14:00Z", "source": "shortcut" }
```

Creating a *new* file needs no SHA, which is what makes hands-free capture from Shortcuts
simple and conflict-proof by construction. **Never edit an inbox file, only create.** A
drained task's `id` derives from the inbox filename, so two devices draining at the same
time deduplicate instead of double-importing.

---

## Setting up a new device

1. Open https://lswyss.github.io/daily-app/
2. **Add it to the home screen** (Share → Add to Home Screen on iOS). Not optional — see
   the token note below.
3. The setup screen asks for a fine-grained PAT. Paste it. The app does a test read against
   `daily-data` before storing it, so a bad token fails immediately and visibly.

### Creating the token

github.com → Settings → Developer settings → **Personal access tokens → Fine-grained
tokens** → Generate new token.

- **Repository access:** Only select repositories → `lswyss/daily-data`. Nothing else.
- **Permissions:** Repository permissions → Contents → **Read and write**. Nothing else.
- **Expiration:** 90 days. Put a calendar reminder to rotate.

### Why the home screen install matters

Since iOS 13.4, Safari clears `localStorage` after 7 days without interaction. **Web apps
installed to the home screen are exempt**, because they do not run inside Safari's counter.
Run this from a Safari tab instead of the home screen and your token will silently vanish
after a week away.

### Rotating or revoking the token

The token exists in up to three places. Miss one and you get confusing partial failures.

1. **Revoke** the old token in GitHub Settings → Developer settings → Fine-grained tokens.
2. **Each browser/device:** open the app, use "sign out and clear token", paste the new one.
3. **The Apple Shortcut** holds its own copy of the token in its `Authorization` header.
   Revoking breaks capture until you edit the Shortcut. **This is the one people forget.**

---

## Local clone protocol

Four things write to `daily-data`: the app on the phone, the app on the Mac, the Shortcut,
and Claude Code via the local clone. Follow this or you will hit rejected pushes.

- `git pull` **before** any local work.
- `git push` **immediately** after.
- **Never force push.** History is the archive.
- Expect a rejected push at least once, when the phone wrote while the Mac was mid-edit.
  Recovery is `git pull --rebase` then `git push`.

### `data.json` — single-writer discipline

Only the web app writes it via the API, always with the current SHA. Claude Code writes it
only through the local clone, after a pull.

On HTTP 409 or SHA mismatch: re-fetch remote, replay the pending mutation log against the
fresh state, retry **exactly once**. If it fails again, show the conflict UI. **Do not
loop, and never silently resolve a conflict** — this app records when experiments happened,
and quietly losing a write is worse than showing an error.

### Mutation log and offline

Every user action appends `{op, id, payload, ts}` where `op` is `add` | `complete` |
`uncomplete` | `edit` | `reschedule` | `delete`. Writes are debounced: flush 5s after the
last change, and also on `visibilitychange`→hidden and on `pagehide`. The log persists in
`localStorage` and flushes on reconnect.

**Replay operations, never queue whole-state snapshots.** That is what makes merges sane.

### The clones' git dirs are not in iCloud

Working trees live in iCloud `TheDaily/`, but `.git` does not — the git directories are at
`~/.gitdirs/daily-app.git` and `~/.gitdirs/daily-data.git`, linked by a `.git` *file* in
each working tree. iCloud sync and file eviction corrupt repos that keep thousands of small
objects inside iCloud. **Do not "fix" the `.git` file by replacing it with a real
directory.** Note this means the git dirs are not themselves backed up by iCloud; the
remote on GitHub is the backup.

Re-creating the clones on a new Mac:

```bash
git clone --separate-git-dir ~/.gitdirs/daily-app.git \
  https://github.com/lswyss/daily-app.git daily-app
git clone --separate-git-dir ~/.gitdirs/daily-data.git \
  https://github.com/lswyss/daily-data.git daily-data
```

---

## Build phases

Ship **phase 4 and stop.** The previous version of this system failed on ergonomics, not on
missing features. Every feature added before validation makes abandonment more likely.

| # | Phase | Status |
|---|---|---|
| 1 | Repos and hosting | **done** |
| 2 | Data layer (`github.js`, `store.js`, pure `sync.js`) | **done** |
| 3 | Setup flow (token entry, validation, clearing) | **done** |
| 4 | Today view + minimal PWA manifest — **then stop** | **built; in its trial week** |
| 5 | Apple Shortcut and inbox drain, with review queue | |
| 6 | Week view | |
| 7 | Experiment strip and day counters | |
| 8 | Archive view | |
| 9 | Service worker (offline app shell) | |

**Phase 4's acceptance test is one full week of real daily use.** If the app is not being
opened daily by the end of that week, that is the signal to stop the project and fall back
to Obsidian. **Treat that outcome as a successful experiment, not a failure.**

---

## Known risks

- **Token in `localStorage`.** Bounded but real: anyone with the unlocked device can read
  the task list. Mitigated by scoping to one repo with an expiry.
- **Commit noise.** Many small commits daily. Fine for a private data repo. Use meaningful
  messages so `git log` stays greppable, e.g. `complete: sow seeds GB005`.
- **Rate limits.** 5000 authenticated requests/hour, far above this workload. Debounce anyway.
- **Multi-writer conflicts.** Rare for one user, but local clone + phone makes them
  possible. Detection is server-side via SHA.
- **iCloud + git.** Mitigated by `--separate-git-dir`. If iCloud still causes trouble
  (evicted working files, "file 2" duplicates), move the working trees out of iCloud too.
- **iOS dictation accuracy** on plant and construct terminology will be poor. The
  confirm-before-file step is **not optional**.
- **Adoption.** Still the largest risk, and not technical. Keep v1 small.

---

## Decision log

- **2026-07-31** — Project started. Spec adopted with five amendments: local clones live in
  iCloud but with `--separate-git-dir` keeping git internals outside iCloud; the minimal PWA
  manifest moves from phase 9 into phase 4 so the trial week runs from a home-screen icon
  and iOS cannot evict the token; the Apple Shortcut moves ahead of the week view because
  voice capture is the headline ergonomic win and adoption is the biggest risk; inbox drains
  are idempotent via filename-derived task ids.
- **2026-07-31** — Confirmed from GitHub docs that Pages on a private repo needs a paid
  plan, *and* that a Pages site is public even from a private repo unless on Enterprise
  Cloud. Paying would not buy privacy, so the public-app/private-data split is correct
  under any plan rather than being a free-tier workaround.
- **2026-07-31** — Phase 1 complete: `daily-app` (public, Pages) and `daily-data` (private)
  created, both cloned into iCloud `TheDaily/` with separated git dirs.
- **2026-07-31** — Phase 2 complete: `github.js`, `store.js`, and the pure parts of
  `sync.js`, with 69 tests under `node --test`. Two choices worth recording. First, the
  mutation log drops only *confirmed* entries rather than clearing itself, because a user
  can tap while a flush is mid-flight and `clear()` would eat those taps. Second, every
  failure returns a status object rather than throwing past the caller — the sync badge has
  to distinguish offline from conflict from auth failure, and an exception loses that
  distinction. A `package.json` was added purely so `node --test` reads the modules as ESM;
  the app still has no build step.
- **2026-07-31** — Phase 3 built: setup flow with live validation. The bad-token half of the
  acceptance test is verified on the live site — a malformed token is caught locally with no
  network call, and a well-formed but invalid one produces GitHub's real 401 plus a remedy
  line, with nothing written to `localStorage`. The good-token half needs a real PAT and so
  is left to the owner. Note the pasted token is trimmed before use: a trailing newline from
  a phone paste otherwise produces a 401 that looks like a bad token.
- **2026-07-31** — Phase 4 built: Today view, quick capture with a confirm-before-file
  preview, sync badge, undo, and the minimal PWA manifest. Three decisions worth recording.
  First, a capture with no date is filed under **today** rather than left undated — an
  undated task would not appear in the only view that exists, which is how tasks get lost.
  Second, tasks completed *today* stay visible in a collapsed group, because the spec asks
  for an undo affordance and completion cannot be undone from a list the task has left.
  Third, the badge reports **unsaved** whenever the queue is non-empty, even between
  flushes; only a confirmed write with an empty queue reads as synced.
  **Phase 4 is the stopping point.** Nothing further gets built until this has survived a
  week of real daily use.
- **2026-07-31** — Ergonomics correction on first contact. The owner asked whether tags and
  dates had to be entered by hand; they never did, but the preview appeared on *every*
  capture and made optional fields look required. Two changes. (1) The preview now appears
  only when something is genuinely ambiguous — a new or near-miss code, an empty title, or a
  past date — and everything else files on Enter with an Undo toast. A missing date is
  explicitly not a reason to interrupt. (2) **Bug:** confirming "Create GB005" saved the tag
  on the task but never added it to `experiments`, so the same code would have prompted
  forever. Confirmed tags are now registered on `add`, which is deterministic and therefore
  replay-safe. Registered experiments carry `startDate: null` — phase 7's day counter must
  handle that rather than assume a date it was never given.
- **2026-07-31** — Two owner-requested additions during the trial, both closing gaps rather
  than starting new phases. (1) **Upcoming**: future tasks were shown only as a count, so a
  task added for Sunday vanished with no way to confirm it existed. Now grouped by day in a
  collapsed `details`. This is deliberately *not* the week view — no columns, no drag, no
  navigation; phase 6 still stands. (2) **Editing**: the only way to fix a typo was the undo
  toast, which expires after 8 seconds. Rows now split into two targets — the box completes,
  the text opens an inline editor with delete. That shrinks the complete target from the
  whole row to 44px, which is the cost of having an edit affordance at all; a checkbox is
  the more conventional target anyway.
