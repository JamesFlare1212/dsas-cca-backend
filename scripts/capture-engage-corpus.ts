import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/core/logger.ts';
import { CookieAuth } from '../src/upstream/auth.ts';

// Opt-in live capture only. Raw responses may contain personal data and Set-Cookie;
// keep them under the ignored data directory, never under tests/fixtures.
const config = loadConfig();
const directory = resolve(process.env.RAW_CORPUS_DIR ?? 'data/engage-corpus/raw');
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
await mkdir(join(directory, 'responses'), { recursive: true, mode: 0o700 });
const cookiePath = join(directory, 'cookies.json');
const auth = new CookieAuth(
  {
    baseUrl: config.API_BASE_URL,
    username: config.API_USERNAME,
    password: config.API_PASSWORD,
    cookiePath,
    loginTimeoutMs: config.AUTH_LOGIN_TIMEOUT_MS,
    authCooldownMs: config.AUTH_FAILURE_COOLDOWN_MS,
    credentialsEncoded: config.API_CREDENTIALS_URL_ENCODED,
  },
  createLogger('silent'),
);
const endpoint = new URL(
  '/Services/ActivitiesService.asmx/GetActivityDetails',
  config.API_BASE_URL,
);
const order = [
  ...new Set([3000, 0, 3010, 3320, 9518, 9135, ...Array.from({ length: 11001 }, (_, id) => id)]),
];
const entries = new Map<
  number,
  { id: number; status: number; bytes: number; bodySha256: string; file: string }
>();
const failures: { id: number; code: string }[] = [];
let cursor = 0,
  stopped = false;
const startedAt = new Date().toISOString();
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

async function capture(id: number) {
  const file = `${String(id).padStart(5, '0')}.http.json.gz`;
  const path = join(directory, 'responses', file);
  try {
    const old = JSON.parse(Buffer.from(Bun.gunzipSync(await readFile(path))).toString());
    const bytes = Buffer.from(old.response.bodyBase64, 'base64');
    if (old.id !== id || sha256(bytes) !== old.response.bodySha256)
      throw new Error('invalid checkpoint');
    entries.set(id, {
      id,
      file,
      status: old.response.status,
      bytes: bytes.length,
      bodySha256: old.response.bodySha256,
    });
    return;
  } catch {
    /* Absent/incomplete checkpoints are recaptured; no input is trusted by filename alone. */
  }
  const attempts: unknown[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cookie = await auth.getCookies();
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
        },
        body: JSON.stringify({ activityID: String(id) }),
        signal: AbortSignal.timeout(config.CRAWLER_REQUEST_TIMEOUT_MS),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const snapshot = {
        capturedAt: new Date().toISOString(),
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        setCookie: response.headers.getSetCookie(),
        bodyBase64: bytes.toString('base64'),
        bodySha256: sha256(bytes),
      };
      attempts.push(snapshot);
      const location = response.headers.get('location') ?? '';
      const loginHtml = /loginControl\$(?:txtUN|txtPwd)|<input\b[^>]*type=["']password/i.test(
        bytes.toString('utf8'),
      );
      const needsLogin =
        [401, 403].includes(response.status) || /Login\.aspx/i.test(location) || loginHtml;
      if (needsLogin && attempt < 2) {
        await auth.refreshCookies(cookie);
        continue;
      }
      const record = {
        schemaVersion: 1,
        id,
        request: {
          method: 'POST',
          path: endpoint.pathname,
          body: JSON.stringify({ activityID: String(id) }),
        },
        response: snapshot,
        attempts,
      };
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, Bun.gzipSync(JSON.stringify(record)), { mode: 0o600 });
      await rename(temporary, path);
      entries.set(id, {
        id,
        file,
        status: response.status,
        bytes: bytes.length,
        bodySha256: snapshot.bodySha256,
      });
      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'CAPTURE_FAILED';
      attempts.push({ capturedAt: new Date().toISOString(), transportError: code });
      if (attempt === 2) {
        failures.push({ id, code });
        await atomicJson(join(directory, `failed-${id}.json`), { id, attempts });
      }
    }
  }
}

async function manifest() {
  const values = [...entries.values()].sort((a, b) => a.id - b.id);
  const value = {
    schemaVersion: 1,
    startedAt,
    updatedAt: new Date().toISOString(),
    source: endpoint.origin + endpoint.pathname,
    minId: 0,
    maxId: 11000,
    expectedCount: 11001,
    completed: values.length,
    failures,
    complete: values.length === 11001 && !failures.length,
    bodyEncoding: 'base64 of the unmodified Fetch response body bytes',
    headerEncoding: 'Fetch Headers entries plus getSetCookie; no request authentication headers',
    entries: values,
  };
  await atomicJson(join(directory, 'manifest.json'), value);
}

try {
  await auth.getCookies();
  console.log(
    JSON.stringify({
      phase: 'capture',
      directory,
      total: order.length,
      concurrency: Math.min(8, config.CONCURRENT_API_CALLS),
    }),
  );
  await Promise.all(
    Array.from({ length: Math.min(8, config.CONCURRENT_API_CALLS) }, async () => {
      while (!stopped && cursor < order.length) {
        const id = order[cursor++];
        if (id === undefined) break;
        await capture(id);
        if ((entries.size + failures.length) % 50 === 0) {
          console.log(
            JSON.stringify({ completed: entries.size, failed: failures.length, total: 11001 }),
          );
        }
      }
    }),
  );
  await manifest();
  console.log(
    JSON.stringify({ finished: !stopped, completed: entries.size, failed: failures.length }),
  );
  if (entries.size !== 11001 || failures.length) process.exitCode = 1;
} finally {
  await auth.close();
  await unlink(cookiePath).catch(() => undefined);
}
