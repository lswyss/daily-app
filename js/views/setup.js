/**
 * Setup view: token entry, live validation, storage, and clearing.
 *
 * Validation is always a real read against the data repo. A token that "looks
 * right" but cannot reach the repo must fail here, loudly, rather than at 7am in
 * the lab.
 *
 * @module views/setup
 */

import { createGitHubClient } from '../github.js';
import {
  DEFAULT_OWNER,
  DEFAULT_REPO,
  clearConfig,
  inspectToken,
  loadConfig,
  saveConfig,
} from '../config.js';

/** Human-readable guidance per failure kind from `verifyAccess`. */
const REMEDY = {
  auth: 'Check the token was copied whole, has not expired, and has Contents: Read and write.',
  missing: 'The token works, but data.json is not in that repo. Check the owner and repo names.',
  network: 'No connection to GitHub. Check your network and try again.',
  ratelimit: 'GitHub is rate limiting this token. Wait a minute and try again.',
  unknown: 'Unexpected response from GitHub. The exact message is above.',
};

/**
 * @param {object} deps
 * @param {Storage} deps.storage
 * @param {(message: string) => void} [deps.onDone] Called after a token validates.
 * @returns {HTMLElement}
 */
export function renderSetup({ storage, onDone = () => {} }) {
  const existing = loadConfig(storage);

  const section = document.createElement('section');
  section.className = 'setup';
  section.innerHTML = `
    <h1>Daily</h1>
    <p class="meta">${existing ? 'Device settings' : 'First run · connect this device'}</p>
    <hr>
    <form novalidate>
      <label for="token">GitHub token</label>
      <p class="help" id="token-help">
        A fine-grained personal access token, scoped to
        <strong class="repo-name">${DEFAULT_OWNER}/${DEFAULT_REPO}</strong> only, with
        <strong>Contents: Read and write</strong>. It is stored on this device and never committed.
      </p>
      <input id="token" name="token" type="password" autocomplete="off" spellcheck="false"
             autocapitalize="none" aria-describedby="token-help"
             placeholder="github_pat_..." value="">

      <details>
        <summary>Data repository</summary>
        <div class="row">
          <span>
            <label for="owner">Owner</label>
            <input id="owner" name="owner" type="text" autocapitalize="none" spellcheck="false"
                   value="${existing?.owner ?? DEFAULT_OWNER}">
          </span>
          <span>
            <label for="repo">Repo</label>
            <input id="repo" name="repo" type="text" autocapitalize="none" spellcheck="false"
                   value="${existing?.repo ?? DEFAULT_REPO}">
          </span>
        </div>
      </details>

      <p class="status" role="status" aria-live="polite"></p>

      <button class="primary" type="submit">Validate and save</button>
    </form>

    ${
      existing
        ? `<hr>
           <p class="meta">Connected since ${
             existing.savedAt ? existing.savedAt.slice(0, 10) : 'unknown'
           }</p>
           <button class="danger" type="button" id="signout">Sign out and clear token</button>
           <p class="help">
             Clearing removes the token and any unsynced changes from this device. Revoking the
             token on GitHub is separate — and remember the Apple Shortcut holds its own copy.
           </p>`
        : ''
    }
  `;

  const form = /** @type {HTMLFormElement} */ (section.querySelector('form'));
  const tokenInput = /** @type {HTMLInputElement} */ (section.querySelector('#token'));
  const ownerInput = /** @type {HTMLInputElement} */ (section.querySelector('#owner'));
  const repoInput = /** @type {HTMLInputElement} */ (section.querySelector('#repo'));
  const status = /** @type {HTMLElement} */ (section.querySelector('.status'));
  const submit = /** @type {HTMLButtonElement} */ (section.querySelector('button.primary'));
  const repoName = /** @type {HTMLElement} */ (section.querySelector('.repo-name'));

  /** @param {string} message @param {'ok'|'bad'|'busy'|''} kind */
  function setStatus(message, kind = '') {
    status.textContent = message;
    status.className = `status${kind ? ` is-${kind}` : ''}`;
  }

  const syncRepoName = () => {
    repoName.textContent = `${ownerInput.value || DEFAULT_OWNER}/${repoInput.value || DEFAULT_REPO}`;
  };
  ownerInput.addEventListener('input', syncRepoName);
  repoInput.addEventListener('input', syncRepoName);
  syncRepoName();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const token = tokenInput.value.trim();
    const owner = ownerInput.value.trim() || DEFAULT_OWNER;
    const repo = repoInput.value.trim() || DEFAULT_REPO;

    const shape = inspectToken(token);
    if (!shape.plausible) {
      setStatus(shape.hint ?? 'That token does not look usable.', 'bad');
      tokenInput.focus();
      return;
    }

    submit.disabled = true;
    setStatus(`Checking access to ${owner}/${repo}…`, 'busy');

    try {
      const client = createGitHubClient({ token, owner, repo });
      const result = await client.verifyAccess('data.json');

      if (!result.ok) {
        // Never store a token we could not use. A stored-but-broken token turns
        // every later failure into a mystery.
        setStatus(`${result.reason}\n\n${REMEDY[result.kind] ?? REMEDY.unknown}`, 'bad');
        return;
      }

      saveConfig({ token, owner, repo }, storage);
      const note = shape.hint ? ` ${shape.hint}` : '';
      setStatus(`Connected to ${owner}/${repo}.${note}`, 'ok');
      tokenInput.value = '';
      onDone(`Connected to ${owner}/${repo}`);
    } catch (err) {
      setStatus(`Could not validate: ${err.message}`, 'bad');
    } finally {
      submit.disabled = false;
    }
  });

  const signout = section.querySelector('#signout');
  signout?.addEventListener('click', () => {
    // Destructive and easy to hit by accident on a phone, so confirm first.
    if (!globalThis.confirm('Clear the token and any unsynced changes from this device?')) return;
    clearConfig(storage);
    onDone('Signed out');
  });

  return section;
}
