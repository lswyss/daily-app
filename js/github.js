/**
 * GitHub contents API wrapper for The Daily.
 *
 * No DOM dependencies. `fetch` is injectable so this module is testable under
 * `node --test` with a mock. Every failure mode gets its own error class, because
 * the calling code has to tell "your token died" apart from "someone else wrote
 * first" apart from "GitHub is down" — those need three different UI responses.
 *
 * @module github
 */

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Base class for every failure this module raises. */
export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number|null, body?: unknown, path?: string|null}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = info.status ?? null;
    this.body = info.body ?? null;
    this.path = info.path ?? null;
  }
}

/** Bad, expired, or revoked token; or the token lacks scope for this repo. */
export class AuthError extends GitHubError {
  constructor(message, info) {
    super(message, info);
    this.name = 'AuthError';
  }
}

/** The path does not exist. Callers decide whether that is an error. */
export class NotFoundError extends GitHubError {
  constructor(message, info) {
    super(message, info);
    this.name = 'NotFoundError';
  }
}

/**
 * Someone else wrote first — the SHA we passed is no longer current.
 * This is the error the whole single-writer discipline hangs on. Never swallow it.
 */
export class ConflictError extends GitHubError {
  constructor(message, info) {
    super(message, info);
    this.name = 'ConflictError';
  }
}

/** Secondary or primary rate limit hit. Back off, do not hammer. */
export class RateLimitError extends GitHubError {
  constructor(message, info) {
    super(message, info);
    this.name = 'RateLimitError';
  }
}

/** The request never reached GitHub (offline, DNS, TLS). */
export class NetworkError extends GitHubError {
  constructor(message, info) {
    super(message, info);
    this.name = 'NetworkError';
  }
}

/**
 * UTF-8 safe base64 encode. `btoa` alone mangles non-ASCII, and lab notes will
 * eventually contain a µ or a °C.
 * @param {string} str
 * @returns {string}
 */
export function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * UTF-8 safe base64 decode. GitHub wraps its base64 at 60 chars, so strip
 * whitespace before decoding.
 * @param {string} b64
 * @returns {string}
 */
export function decodeBase64(b64) {
  const binary = atob(String(b64).replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a repo path for a URL without destroying its slashes.
 * @param {string} path
 * @returns {string}
 */
function encodePath(path) {
  return String(path)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
}

/**
 * @param {unknown} headers
 * @param {string} name
 * @returns {string|null}
 */
function header(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get(name);
}

/**
 * Turn a non-2xx response into the most specific error we can justify.
 * @param {number} status
 * @param {unknown} body
 * @param {unknown} headers
 * @param {string} path
 * @returns {GitHubError}
 */
function errorForStatus(status, body, headers, path) {
  const detail =
    body && typeof body === 'object' && typeof (/** @type {any} */ (body).message) === 'string'
      ? /** @type {any} */ (body).message
      : `HTTP ${status}`;
  const info = { status, body, path };

  if (status === 401) {
    return new AuthError(`Token rejected by GitHub: ${detail}`, info);
  }
  if (status === 404) {
    // A scoped token that cannot see the repo also 404s, so say both things.
    return new NotFoundError(
      `Not found: ${path}. Either the path does not exist or the token cannot see this repo.`,
      info,
    );
  }
  if (status === 409) {
    return new ConflictError(`Write conflict on ${path}: ${detail}`, info);
  }
  if (status === 422 && /sha/i.test(detail)) {
    // GitHub uses 422 for some stale/missing-SHA cases. Same meaning, same handling.
    return new ConflictError(`Write conflict on ${path}: ${detail}`, info);
  }
  if (status === 403 || status === 429) {
    const remaining = header(headers, 'x-ratelimit-remaining');
    if (remaining === '0' || status === 429 || /rate limit|abuse|secondary/i.test(detail)) {
      return new RateLimitError(`Rate limited by GitHub: ${detail}`, info);
    }
    return new AuthError(`Forbidden — token likely lacks contents:write: ${detail}`, info);
  }
  return new GitHubError(`GitHub request failed for ${path}: ${detail}`, info);
}

/**
 * @typedef {object} FileRead
 * @property {string} content Decoded UTF-8 file contents.
 * @property {string} sha     Blob SHA, required to write this file again.
 * @property {string} path
 */

/**
 * @typedef {object} DirEntry
 * @property {string} name
 * @property {string} path
 * @property {string} sha
 * @property {'file'|'dir'|'symlink'|'submodule'} type
 * @property {number} size
 */

/**
 * @typedef {object} GitHubClientOptions
 * @property {string} token   Fine-grained PAT, contents read/write, scoped to the data repo.
 * @property {string} owner
 * @property {string} repo
 * @property {string} [branch] Defaults to the repo's default branch.
 * @property {typeof globalThis.fetch} [fetch] Injected for tests.
 */

/**
 * Create a contents-API client bound to one repo.
 * @param {GitHubClientOptions} options
 */
export function createGitHubClient(options) {
  const { token, owner, repo, branch } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!token) throw new Error('createGitHubClient: token is required');
  if (!owner || !repo) throw new Error('createGitHubClient: owner and repo are required');
  if (typeof fetchImpl !== 'function') throw new Error('createGitHubClient: no fetch available');

  const contentsUrl = (path) => `${API_ROOT}/repos/${owner}/${repo}/contents/${encodePath(path)}`;

  /**
   * @param {string} url
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<{status: number, body: any, headers: unknown}>}
   */
  async function request(url, path, init = {}) {
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...(init.headers ?? {}),
    };
    if (init.body != null) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(url, { ...init, headers });
    } catch (cause) {
      // Distinguish "offline" from "GitHub said no" — the sync badge shows
      // different states for these and must never conflate them.
      throw new NetworkError(`Could not reach GitHub for ${path}: ${cause?.message ?? cause}`, {
        path,
      });
    }

    const text = typeof response.text === 'function' ? await response.text() : '';
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!(response.status >= 200 && response.status < 300)) {
      throw errorForStatus(response.status, body, response.headers, path);
    }
    return { status: response.status, body, headers: response.headers };
  }

  return {
    owner,
    repo,
    branch: branch ?? null,

    /**
     * Read a file. Returns null when it does not exist, so callers can
     * distinguish "empty" from "missing" without catching.
     * @param {string} path
     * @returns {Promise<FileRead|null>}
     */
    async readFile(path) {
      const url = branch ? `${contentsUrl(path)}?ref=${encodeURIComponent(branch)}` : contentsUrl(path);
      let result;
      try {
        result = await request(url, path, { method: 'GET' });
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
      const body = result.body;
      if (Array.isArray(body)) {
        throw new GitHubError(`${path} is a directory, not a file`, { status: 200, path });
      }
      if (body?.encoding === 'none' || (body?.content === '' && body?.size > 0)) {
        // Files over 1MB come back empty from this endpoint. Returning "" here
        // would look like an empty data.json and wipe everything on next write.
        throw new GitHubError(
          `${path} is too large for the contents API (${body?.size} bytes). Refusing to read it as empty.`,
          { status: 200, path, body },
        );
      }
      if (body?.encoding !== 'base64' || typeof body?.content !== 'string') {
        throw new GitHubError(`Unexpected response shape reading ${path}`, {
          status: 200,
          path,
          body,
        });
      }
      return { content: decodeBase64(body.content), sha: body.sha, path: body.path ?? path };
    },

    /**
     * Create or update a file.
     *
     * Omit `sha` to create a new file; pass the current `sha` to update one.
     * A stale SHA raises ConflictError, which is how the server — not us —
     * prevents a lost write.
     *
     * @param {{path: string, content: string, sha?: string|null, message: string}} args
     * @returns {Promise<{sha: string, commit: any}>}
     */
    async writeFile({ path, content, sha, message }) {
      if (!message) throw new Error('writeFile: a commit message is required');
      /** @type {Record<string, unknown>} */
      const payload = { message, content: encodeBase64(content) };
      if (sha) payload.sha = sha;
      if (branch) payload.branch = branch;

      const result = await request(contentsUrl(path), path, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      return { sha: result.body?.content?.sha, commit: result.body?.commit ?? null };
    },

    /**
     * List a directory. Returns [] when the directory does not exist, since an
     * absent inbox and an empty inbox mean the same thing to the drain.
     * @param {string} path
     * @returns {Promise<DirEntry[]>}
     */
    async listDir(path) {
      const url = branch ? `${contentsUrl(path)}?ref=${encodeURIComponent(branch)}` : contentsUrl(path);
      let result;
      try {
        result = await request(url, path, { method: 'GET' });
      } catch (err) {
        if (err instanceof NotFoundError) return [];
        throw err;
      }
      if (!Array.isArray(result.body)) {
        throw new GitHubError(`${path} is a file, not a directory`, { status: 200, path });
      }
      return result.body.map((entry) => ({
        name: entry.name,
        path: entry.path,
        sha: entry.sha,
        type: entry.type,
        size: entry.size ?? 0,
      }));
    },

    /**
     * Delete a file. The blob stays in git history, so this is not destructive.
     * @param {{path: string, sha: string, message: string}} args
     * @returns {Promise<{commit: any}>}
     */
    async deleteFile({ path, sha, message }) {
      if (!sha) throw new Error('deleteFile: sha is required');
      if (!message) throw new Error('deleteFile: a commit message is required');
      /** @type {Record<string, unknown>} */
      const payload = { message, sha };
      if (branch) payload.branch = branch;

      const result = await request(contentsUrl(path), path, {
        method: 'DELETE',
        body: JSON.stringify(payload),
      });
      return { commit: result.body?.commit ?? null };
    },

    /**
     * Cheap credential check for the setup flow: can this token read this repo?
     * Returns a plain result rather than throwing, because the setup screen wants
     * to show the reason inline.
     * @param {string} [probePath]
     * @returns {Promise<{ok: boolean, reason?: string, kind?: string}>}
     */
    async verifyAccess(probePath = 'data.json') {
      try {
        const file = await this.readFile(probePath);
        if (file === null) {
          return {
            ok: false,
            kind: 'missing',
            reason: `Token works, but ${probePath} is missing from ${owner}/${repo}.`,
          };
        }
        return { ok: true };
      } catch (err) {
        const kind =
          err instanceof AuthError
            ? 'auth'
            : err instanceof NetworkError
              ? 'network'
              : err instanceof RateLimitError
                ? 'ratelimit'
                : 'unknown';
        return { ok: false, kind, reason: err.message };
      }
    },
  };
}
