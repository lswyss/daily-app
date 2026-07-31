import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGitHubClient,
  encodeBase64,
  decodeBase64,
  AuthError,
  ConflictError,
  GitHubError,
  NetworkError,
  NotFoundError,
  RateLimitError,
} from '../js/github.js';

import { createFetchMock, fakeResponse, fileResponse, writeResponse, conflictResponse } from './helpers.js';

const CONFIG = { token: 'ghp_test', owner: 'lswyss', repo: 'daily-data' };

function clientWith(responder) {
  const mock = createFetchMock(responder);
  return { client: createGitHubClient({ ...CONFIG, fetch: mock.fetch }), mock };
}

test('base64 round-trips UTF-8, not just ASCII', () => {
  const original = 'PEG −0.7 MPa at 22 °C, µmol·m⁻²·s⁻¹ — GB005';
  assert.equal(decodeBase64(encodeBase64(original)), original);
});

test('decodeBase64 tolerates the newlines GitHub wraps its base64 with', () => {
  const wrapped = encodeBase64('x'.repeat(200)).replace(/(.{60})/g, '$1\n');
  assert.equal(decodeBase64(wrapped), 'x'.repeat(200));
});

test('constructor rejects missing credentials rather than failing later', () => {
  assert.throws(() => createGitHubClient({ owner: 'a', repo: 'b', fetch: async () => {} }), /token is required/);
  assert.throws(() => createGitHubClient({ token: 't', fetch: async () => {} }), /owner and repo are required/);
});

test('readFile decodes content and returns the sha needed to write it back', async () => {
  const { client, mock } = clientWith(() => fileResponse({ content: '{"version":1}', sha: 'abc123' }));

  const file = await client.readFile('data.json');

  assert.equal(file.content, '{"version":1}');
  assert.equal(file.sha, 'abc123');
  assert.equal(mock.calls[0].method, 'GET');
  assert.equal(mock.calls[0].url, 'https://api.github.com/repos/lswyss/daily-data/contents/data.json');
  assert.equal(mock.calls[0].headers.Authorization, 'Bearer ghp_test');
  assert.equal(mock.calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('readFile returns null for a missing file so callers need not catch', async () => {
  const { client } = clientWith(() => fakeResponse({ status: 404, body: { message: 'Not Found' } }));
  assert.equal(await client.readFile('data.json'), null);
});

test('readFile refuses to report an oversized file as empty', async () => {
  // The contents API returns content:"" with encoding:"none" above 1MB. Treating
  // that as an empty data.json would wipe everything on the next write.
  const { client } = clientWith(() =>
    fakeResponse({ body: { type: 'file', encoding: 'none', content: '', sha: 'big', size: 2_000_000 } }),
  );
  await assert.rejects(() => client.readFile('data.json'), /too large|Refusing/);
});

test('readFile rejects a directory response', async () => {
  const { client } = clientWith(() => fakeResponse({ body: [{ name: 'a.json' }] }));
  await assert.rejects(() => client.readFile('inbox'), /is a directory/);
});

test('a rejected token raises AuthError, not a generic failure', async () => {
  const { client } = clientWith(() => fakeResponse({ status: 401, body: { message: 'Bad credentials' } }));
  await assert.rejects(() => client.readFile('data.json'), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, 401);
    return true;
  });
});

test('writeFile sends base64 content plus the sha, and returns the new sha', async () => {
  const { client, mock } = clientWith(() => writeResponse('sha-2'));

  const result = await client.writeFile({
    path: 'data.json',
    content: '{"version":1}',
    sha: 'sha-1',
    message: 'complete: sow seeds GB005',
  });

  assert.equal(result.sha, 'sha-2');
  const call = mock.calls[0];
  assert.equal(call.method, 'PUT');
  assert.equal(call.body.sha, 'sha-1');
  assert.equal(call.body.message, 'complete: sow seeds GB005');
  assert.equal(decodeBase64(call.body.content), '{"version":1}');
  assert.equal(call.headers['Content-Type'], 'application/json');
});

test('writeFile omits sha when creating a new file — the whole point of the inbox', async () => {
  const { client, mock } = clientWith(() => writeResponse());
  await client.writeFile({ path: 'inbox/x.json', content: '{}', message: 'capture' });
  assert.ok(!('sha' in mock.calls[0].body));
});

test('writeFile requires a commit message so git log stays greppable', async () => {
  const { client } = clientWith(() => writeResponse());
  await assert.rejects(
    () => client.writeFile({ path: 'data.json', content: '{}', sha: 'a' }),
    /commit message is required/,
  );
});

test('a stale sha raises ConflictError (409)', async () => {
  const { client } = clientWith(() => conflictResponse());
  await assert.rejects(
    () => client.writeFile({ path: 'data.json', content: '{}', sha: 'stale', message: 'edit' }),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test('a 422 about the sha is also a conflict, not a generic error', async () => {
  const { client } = clientWith(() =>
    fakeResponse({ status: 422, body: { message: 'Invalid request. "sha" wasn\'t supplied.' } }),
  );
  await assert.rejects(
    () => client.writeFile({ path: 'data.json', content: '{}', message: 'edit' }),
    (err) => err instanceof ConflictError,
  );
});

test('a 422 unrelated to the sha stays a generic GitHubError', async () => {
  const { client } = clientWith(() => fakeResponse({ status: 422, body: { message: 'Invalid branch' } }));
  await assert.rejects(
    () => client.writeFile({ path: 'data.json', content: '{}', message: 'edit' }),
    (err) => err instanceof GitHubError && !(err instanceof ConflictError),
  );
});

test('exhausted rate limit is distinguished from a permissions failure', async () => {
  const limited = clientWith(() =>
    fakeResponse({
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0' },
    }),
  );
  await assert.rejects(() => limited.client.readFile('data.json'), (err) => err instanceof RateLimitError);

  const forbidden = clientWith(() =>
    fakeResponse({ status: 403, body: { message: 'Resource not accessible by personal access token' } }),
  );
  await assert.rejects(() => forbidden.client.readFile('data.json'), (err) => err instanceof AuthError);
});

test('an unreachable network raises NetworkError, distinct from GitHub saying no', async () => {
  const { client } = clientWith(() => new TypeError('Load failed'));
  await assert.rejects(() => client.readFile('data.json'), (err) => {
    assert.ok(err instanceof NetworkError);
    return true;
  });
});

test('listDir returns entries with the shas the drain needs to delete them', async () => {
  const { client } = clientWith(() =>
    fakeResponse({
      body: [
        { name: '2026-07-31T0814-a3f.json', path: 'inbox/2026-07-31T0814-a3f.json', sha: 's1', type: 'file', size: 90 },
        { name: '.gitkeep', path: 'inbox/.gitkeep', sha: 's2', type: 'file', size: 0 },
      ],
    }),
  );

  const entries = await client.listDir('inbox');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sha, 's1');
  assert.equal(entries[0].path, 'inbox/2026-07-31T0814-a3f.json');
});

test('listDir treats a missing directory as empty — same meaning to the drain', async () => {
  const { client } = clientWith(() => fakeResponse({ status: 404, body: { message: 'Not Found' } }));
  assert.deepEqual(await client.listDir('inbox'), []);
});

test('deleteFile insists on a sha and passes it through', async () => {
  const { client, mock } = clientWith(() => fakeResponse({ body: { commit: { sha: 'c1' } } }));

  await assert.rejects(
    () => client.deleteFile({ path: 'inbox/x.json', message: 'drain' }),
    /sha is required/,
  );

  await client.deleteFile({ path: 'inbox/x.json', sha: 's1', message: 'drain: x' });
  const call = mock.calls.at(-1);
  assert.equal(call.method, 'DELETE');
  assert.equal(call.body.sha, 's1');
});

test('paths are URL-encoded without destroying slashes', async () => {
  const { client, mock } = clientWith(() => fileResponse({ content: '{}', sha: 'a' }));
  await client.readFile('inbox/2026-07-31T08:14-a3f.json');
  assert.equal(
    mock.calls[0].url,
    'https://api.github.com/repos/lswyss/daily-data/contents/inbox/2026-07-31T08%3A14-a3f.json',
  );
});

test('verifyAccess reports a usable token, and explains an unusable one', async () => {
  const good = clientWith(() => fileResponse({ content: '{"tasks":[]}', sha: 'a' }));
  assert.deepEqual(await good.client.verifyAccess(), { ok: true });

  const bad = clientWith(() => fakeResponse({ status: 401, body: { message: 'Bad credentials' } }));
  const result = await bad.client.verifyAccess();
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'auth');
  assert.match(result.reason, /Bad credentials/);

  const missing = clientWith(() => fakeResponse({ status: 404, body: { message: 'Not Found' } }));
  const absent = await missing.client.verifyAccess();
  assert.equal(absent.ok, false);
  assert.equal(absent.kind, 'missing');
});
