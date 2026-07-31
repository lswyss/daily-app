/**
 * Entry point and routing.
 *
 * Phase 3: two states only — not set up (setup view) and set up (a placeholder
 * that phase 4 replaces with the Today view).
 *
 * @module main
 */

import { loadConfig } from './config.js';
import { renderSetup } from './views/setup.js';

const root = /** @type {HTMLElement} */ (document.getElementById('view'));
const storage = globalThis.localStorage;

/** @param {string} text @param {'ok'|'bad'|''} kind */
function flash(text, kind = 'ok') {
  const banner = /** @type {HTMLElement} */ (document.getElementById('flash'));
  banner.textContent = text;
  banner.className = `flash is-${kind}`;
  banner.hidden = false;
}

function renderConnected(config) {
  const section = document.createElement('section');
  section.className = 'setup';
  section.innerHTML = `
    <h1>Daily</h1>
    <p class="meta">Phase 3 · device connected</p>
    <hr>
    <p>This device can read <strong>${config.owner}/${config.repo}</strong>.</p>
    <p class="help">
      The Today view arrives in phase 4. Until then this screen only confirms the token
      survives a reload — which is phase 3's acceptance test.
    </p>
    <hr>
    <button class="primary" type="button" id="settings">Device settings</button>
  `;
  section.querySelector('#settings')?.addEventListener('click', () => route({ force: 'setup' }));
  return section;
}

/** @param {{force?: 'setup'}} [options] */
function route(options = {}) {
  const config = loadConfig(storage);
  root.replaceChildren(
    options.force === 'setup' || !config
      ? renderSetup({
          storage,
          onDone: (message) => {
            flash(message);
            route();
          },
        })
      : renderConnected(config),
  );
}

route();
