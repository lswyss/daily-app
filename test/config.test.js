import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_KEY,
  DEFAULT_OWNER,
  DEFAULT_REPO,
  clearConfig,
  inspectToken,
  loadConfig,
  saveConfig,
} from '../js/config.js';

import { memoryStorage } from './helpers.js';

test('a fresh device has no config', () => {
  assert.equal(loadConfig(memoryStorage()), null);
});

test('config survives a reload — phase 3 acceptance, in unit form', () => {
  const storage = memoryStorage();
  saveConfig({ token: 'github_pat_abc' }, storage, () => '2026-07-31T09:00:00Z');

  const restored = loadConfig(storage);
  assert.equal(restored.token, 'github_pat_abc');
  assert.equal(restored.owner, DEFAULT_OWNER);
  assert.equal(restored.repo, DEFAULT_REPO);
  assert.equal(restored.savedAt, '2026-07-31T09:00:00Z');
});

test('a pasted token is trimmed — a trailing newline otherwise 401s confusingly', () => {
  const storage = memoryStorage();
  saveConfig({ token: '  github_pat_abc\n' }, storage);
  assert.equal(loadConfig(storage).token, 'github_pat_abc');
});

test('an empty token is refused rather than stored', () => {
  assert.throws(() => saveConfig({ token: '   ' }, memoryStorage()), /token is required/);
});

test('corrupt config reads as no config, so setup simply asks again', () => {
  assert.equal(loadConfig(memoryStorage({ [CONFIG_KEY]: '{ truncated' })), null);
  assert.equal(loadConfig(memoryStorage({ [CONFIG_KEY]: '{"owner":"x"}' })), null);
});

test('signing out clears the token and the unsynced queue together', () => {
  const storage = memoryStorage();
  saveConfig({ token: 'github_pat_abc' }, storage);
  storage.setItem('daily.mutations.v1', '[]');

  clearConfig(storage);

  assert.equal(loadConfig(storage), null);
  assert.equal(storage.getItem('daily.mutations.v1'), null, 'queued edits must not outlive the token');
});

test('inspectToken catches paste mistakes without pretending to authenticate', () => {
  assert.equal(inspectToken('github_pat_11ABC').plausible, true);
  assert.equal(inspectToken('').plausible, false);
  assert.equal(inspectToken('github_pat_11 ABC').plausible, false);
  assert.match(inspectToken('github_pat_11 ABC').hint, /space/);
  assert.equal(inspectToken('hunter2').plausible, false);
  assert.match(inspectToken('hunter2').hint, /github_pat_/);

  // A classic token is allowed but nudged, since it cannot be scoped to one repo.
  const classic = inspectToken('ghp_abc123');
  assert.equal(classic.plausible, true);
  assert.match(classic.hint, /fine-grained/i);
});
