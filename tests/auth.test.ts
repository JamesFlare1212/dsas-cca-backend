import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cookie } from 'playwright-core';
import { createLogger } from '../src/core/logger.ts';
import { type AuthOptions, type BrowserLauncher, CookieAuth } from '../src/upstream/auth.ts';

const logger = createLogger('silent');
const BASE_URL = 'https://engage.nkcswx.cn';

function cookie(name = '.ASPXFORMSAUTH', value = 'fresh', overrides: Partial<Cookie> = {}): Cookie {
  return {
    name,
    value,
    domain: 'engage.nkcswx.cn',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides,
  };
}

interface Scenario {
  cookies?: Cookie[];
  finalUrl?: string;
  marker?: boolean;
  fail?: boolean;
  launchGate?: Promise<void>;
  submitGate?: Promise<void>;
  closeGate?: Promise<void>;
  closeError?: Error;
}

function browserHarness(scenarios: Scenario[] = [{}]) {
  const entered = Promise.withResolvers<void>();
  const submitted = Promise.withResolvers<void>();
  const calls = {
    launches: 0,
    closes: 0,
    contexts: 0,
    fills: [] as string[],
    cookieUrls: [] as (string | string[] | undefined)[],
    headless: [] as boolean[],
    waits: [] as string[],
  };
  const launcher: BrowserLauncher = async (options) => {
    const scenario = scenarios[calls.launches] ?? {};
    calls.launches += 1;
    calls.headless.push(options.headless);
    entered.resolve();
    await scenario.launchGate;
    const navigation = Promise.withResolvers<void>();
    let currentUrl = `${BASE_URL}/Login.aspx`;
    const locator = (selector: string) => ({
      fill: async (value: string) => {
        calls.fills.push(value);
      },
      check: async () => undefined,
      click: async () => {
        submitted.resolve();
        await scenario.submitGate;
        currentUrl = scenario.finalUrl ?? `${BASE_URL}/Default.aspx`;
        navigation.resolve();
        if (scenario.fail) throw new Error('Synthetic form failure');
      },
      first() {
        return this;
      },
      isVisible: async () =>
        selector.includes('cbRememberMe') ? false : (scenario.marker ?? false),
    });
    return {
      close: async () => {
        calls.closes += 1;
        await scenario.closeGate;
        if (scenario.closeError) throw scenario.closeError;
      },
      newContext: async () => {
        calls.contexts += 1;
        return {
          cookies: async (urls?: string | string[]) => {
            calls.cookieUrls.push(urls);
            return scenario.cookies ?? [cookie()];
          },
          newPage: async () => ({
            goto: async (
              url: string,
              options: { waitUntil: 'domcontentloaded'; timeout: number },
            ) => {
              currentUrl = url;
              calls.waits.push(options.waitUntil);
            },
            locator,
            waitForURL: async (
              predicate: (url: URL) => boolean,
              options: { waitUntil: 'domcontentloaded'; timeout: number },
            ) => {
              calls.waits.push(options.waitUntil);
              await navigation.promise;
              if (!predicate(new URL(currentUrl)))
                throw new Error('Navigation was not authenticated');
            },
            url: () => currentUrl,
          }),
        };
      },
    };
  };
  return { launcher, calls, entered: entered.promise, submitted: submitted.promise };
}

async function within<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Test operation did not settle')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('CookieAuth', () => {
  let directory: string;
  let options: AuthOptions;
  let instances: CookieAuth[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsas-auth-'));
    options = {
      baseUrl: BASE_URL,
      username: 'test-user',
      password: 'test-password',
      cookiePath: join(directory, 'cookies.json'),
      loginTimeoutMs: 1000,
      authCooldownMs: 60_000,
      credentialsEncoded: false,
    };
    instances = [];
  });

  afterEach(async () => {
    await Promise.all(instances.map((instance) => instance.close()));
    await rm(directory, { recursive: true, force: true });
  });

  function auth(harness: ReturnType<typeof browserHarness>, overrides: Partial<AuthOptions> = {}) {
    const instance = new CookieAuth({ ...options, ...overrides }, logger, harness.launcher);
    instances.push(instance);
    return instance;
  }

  test('eight simultaneous callers share exactly one login and write a private atomic cache', async () => {
    const gate = Promise.withResolvers<void>();
    const harness = browserHarness([{ submitGate: gate.promise }]);
    const instance = auth(harness);
    const pending = Array.from({ length: 8 }, () => instance.getCookies());
    await harness.submitted;
    expect(harness.calls.launches).toBe(1);
    gate.resolve();
    expect(await Promise.all(pending)).toEqual(Array(8).fill('.ASPXFORMSAUTH=fresh'));
    expect(harness.calls).toMatchObject({ launches: 1, closes: 1, contexts: 1, headless: [true] });
    expect(harness.calls.waits).toEqual(['domcontentloaded', 'domcontentloaded']);
    expect(harness.calls.cookieUrls).toEqual([
      `${BASE_URL}/Services/ActivitiesService.asmx/GetActivityDetails`,
    ]);
    expect((await stat(options.cookiePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(['cookies.json']);
    const cached: unknown = JSON.parse(await readFile(options.cookiePath, 'utf8'));
    expect(cached).toMatchObject({ version: 1, authenticatedBy: 'cookie' });
  });

  test('loads legacy cookies and filters domain, path, protocol, and expiry', async () => {
    await writeFile(
      options.cookiePath,
      JSON.stringify([
        cookie('.ASPXFORMSAUTH', 'scoped', { domain: '.nkcswx.cn', path: '/Services' }),
        cookie('host', 'valid'),
        cookie('foreign', 'bad', { domain: 'evil-engage.nkcswx.cn' }),
        cookie('boundary', 'bad', { domain: '.gag e.nkcswx.cn' }),
        cookie('path', 'bad', { path: '/Service' }),
        cookie('loginOnly', 'bad', { path: '/Login.aspx' }),
        cookie('expired', 'bad', { expires: Date.now() / 1000 - 1 }),
      ]),
    );
    const harness = browserHarness();
    expect(await auth(harness).getCookies()).toBe('.ASPXFORMSAUTH=scoped; host=valid');
    expect(harness.calls.launches).toBe(0);
    const insecureHarness = browserHarness([
      {
        finalUrl: 'http://engage.nkcswx.cn/Default.aspx',
        cookies: [cookie('.ASPXFORMSAUTH', 'plain', { secure: false }), cookie('secure', 'bad')],
      },
    ]);
    expect(
      await auth(insecureHarness, {
        baseUrl: 'http://engage.nkcswx.cn',
        cookiePath: join(directory, 'http.json'),
      }).getCookies(),
    ).toBe('.ASPXFORMSAUTH=plain');
  });

  test('failed refresh retains the previous file and memory while failure cooldown blocks another login', async () => {
    const previous = JSON.stringify([cookie('.ASPXFORMSAUTH', 'previous')]);
    await writeFile(options.cookiePath, previous);
    const harness = browserHarness([{ fail: true }]);
    const instance = auth(harness);
    expect(await instance.getCookies()).toBe('.ASPXFORMSAUTH=previous');
    await expect(instance.refreshCookies('.ASPXFORMSAUTH=previous')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    await expect(instance.refreshCookies('.ASPXFORMSAUTH=previous')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(await instance.getCookies()).toBe('.ASPXFORMSAUTH=previous');
    expect(await readFile(options.cookiePath, 'utf8')).toBe(previous);
    expect(harness.calls.launches).toBe(1);
    expect(harness.calls.closes).toBe(1);
  });

  test('cold login failures also use the cooldown', async () => {
    const harness = browserHarness([{ fail: true }]);
    const instance = auth(harness);
    await expect(instance.getCookies()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(instance.getCookies()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(harness.calls.launches).toBe(1);
  });

  test('refreshes share one login and late rejections of old cookies reuse the fresh result', async () => {
    await writeFile(options.cookiePath, JSON.stringify([cookie('.ASPXFORMSAUTH', 'old')]));
    const harness = browserHarness();
    const instance = auth(harness);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => instance.refreshCookies('.ASPXFORMSAUTH=old')),
    );
    expect(results).toEqual(Array(8).fill('.ASPXFORMSAUTH=fresh'));
    expect(await instance.refreshCookies('.ASPXFORMSAUTH=old')).toBe('.ASPXFORMSAUTH=fresh');
    expect(harness.calls.launches).toBe(1);
  });

  test('session IDs without an authenticated marker are insufficient', async () => {
    const harness = browserHarness([{ cookies: [cookie('ASP.NET_SessionId', 'session')] }]);
    await expect(auth(harness).getCookies()).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(await readdir(directory)).toEqual([]);
  });

  test('authenticated marker plus successful navigation permits a session cookie and persisted reuse', async () => {
    const harness = browserHarness([
      { cookies: [cookie('ASP.NET_SessionId', 'session')], marker: true },
    ]);
    expect(await auth(harness).getCookies()).toBe('ASP.NET_SessionId=session');
    const second = browserHarness();
    expect(await auth(second).getCookies()).toBe('ASP.NET_SessionId=session');
    expect(second.calls.launches).toBe(0);
  });

  test('an auth cookie does not excuse staying on Login.aspx or navigating to another origin', async () => {
    for (const finalUrl of [`${BASE_URL}/Login.aspx`, 'https://outside.example/Default.aspx']) {
      const harness = browserHarness([{ finalUrl, marker: true }]);
      await expect(auth(harness).getCookies()).rejects.toMatchObject({
        code: 'AUTHENTICATION_FAILED',
      });
      expect(harness.calls.closes).toBe(1);
    }
  });

  test('expired and corrupt caches trigger a fresh login instead of being sent', async () => {
    await writeFile(
      options.cookiePath,
      JSON.stringify([cookie('.ASPXFORMSAUTH', 'expired', { expires: 1 })]),
    );
    const harness = browserHarness();
    expect(await auth(harness).getCookies()).toBe('.ASPXFORMSAUTH=fresh');
    await writeFile(options.cookiePath, '{broken');
    const second = browserHarness();
    expect(await auth(second).getCookies()).toBe('.ASPXFORMSAUTH=fresh');
    expect(second.calls.launches).toBe(1);
  });

  test('URL decoding is explicit, and literal percent characters remain literal by default', async () => {
    const literal = browserHarness();
    await auth(literal, { username: 'user%20name', password: '100%secure' }).getCookies();
    expect(literal.calls.fills).toEqual(['user%20name', '100%secure']);
    const encoded = browserHarness();
    await auth(encoded, {
      cookiePath: join(directory, 'encoded.json'),
      credentialsEncoded: true,
      username: 'user%20name',
      password: 'a%2Bb%25',
    }).getCookies();
    expect(encoded.calls.fills).toEqual(['user name', 'a+b%']);
  });

  test('one cancelled waiter does not abort the other callers or shared login', async () => {
    const gate = Promise.withResolvers<void>();
    const harness = browserHarness([{ submitGate: gate.promise }]);
    const instance = auth(harness);
    const controller = new AbortController();
    const cancelled = instance.getCookies(controller.signal);
    const remaining = instance.getCookies();
    await harness.submitted;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.calls.closes).toBe(0);
    gate.resolve();
    expect(await remaining).toBe('.ASPXFORMSAUTH=fresh');
    expect(harness.calls.launches).toBe(1);
  });

  test('already aborted callers never launch a browser', async () => {
    const harness = browserHarness();
    await expect(auth(harness).getCookies(AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(harness.calls.launches).toBe(0);
  });

  test('close aborts an active login, closes its browser once, and prevents later calls', async () => {
    const gate = Promise.withResolvers<void>();
    const harness = browserHarness([{ submitGate: gate.promise }]);
    const instance = auth(harness);
    const result = instance.getCookies().then(
      () => undefined,
      (error: unknown) => error,
    );
    await harness.submitted;
    const started = performance.now();
    await instance.close();
    expect(performance.now() - started).toBeLessThan(200);
    expect(await result).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    gate.resolve();
    await instance.close();
    expect(harness.calls.closes).toBe(1);
    await expect(instance.getCookies()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(await readdir(directory)).toEqual([]);
  });

  test('a launcher finishing after close still has its browser closed', async () => {
    const gate = Promise.withResolvers<void>();
    const harness = browserHarness([{ launchGate: gate.promise }]);
    const instance = auth(harness);
    const result = instance.getCookies().then(
      () => undefined,
      (error: unknown) => error,
    );
    await harness.entered;
    const started = performance.now();
    await instance.close();
    expect(performance.now() - started).toBeLessThan(200);
    expect(await result).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.calls.closes).toBe(1);
    expect(harness.calls.contexts).toBe(0);
  });

  test('the overall login deadline closes a stalled browser and activates cooldown', async () => {
    const gate = Promise.withResolvers<void>();
    const harness = browserHarness([{ submitGate: gate.promise }]);
    const instance = auth(harness, { loginTimeoutMs: 20 });
    await expect(instance.getCookies()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    gate.resolve();
    expect(harness.calls.closes).toBe(1);
    await expect(instance.getCookies()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(harness.calls.launches).toBe(1);
  });

  test('hung browser cleanup cannot wedge the login deadline, cooldown, or a cancelled caller', async () => {
    const submit = Promise.withResolvers<void>();
    const close = Promise.withResolvers<void>();
    const harness = browserHarness([{ submitGate: submit.promise, closeGate: close.promise }]);
    const instance = auth(harness, { loginTimeoutMs: 20 });
    const controller = new AbortController();
    const cancelled = instance.getCookies(controller.signal);
    const remaining = instance.getCookies();
    try {
      await within(harness.submitted);
      controller.abort();
      await expect(within(cancelled)).rejects.toMatchObject({ name: 'AbortError' });
      expect(harness.calls.closes).toBe(0);
      await expect(within(remaining)).rejects.toMatchObject({
        code: 'AUTHENTICATION_FAILED',
        message: 'Engage authentication failed',
      });
      await expect(within(instance.getCookies())).rejects.toMatchObject({
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication is cooling down after a failed login',
      });
      await within(instance.close());
      expect(harness.calls.launches).toBe(1);
      expect(harness.calls.closes).toBe(1);
    } finally {
      submit.resolve();
      close.resolve();
    }
  });

  test('close and login cleanup share one bounded browser close', async () => {
    const submit = Promise.withResolvers<void>();
    const close = Promise.withResolvers<void>();
    const harness = browserHarness([{ submitGate: submit.promise, closeGate: close.promise }]);
    const instance = auth(harness, { loginTimeoutMs: 20 });
    const pending = instance.getCookies().catch((error: unknown) => error);
    try {
      await within(harness.submitted);
      const closing = instance.close();
      expect(instance.close()).toBe(closing);
      await within(closing);
      expect(await within(pending)).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
      expect(harness.calls.closes).toBe(1);
    } finally {
      submit.resolve();
      close.resolve();
    }
  });

  test('a late browser with hung cleanup does not block a later shared login', async () => {
    const launch = Promise.withResolvers<void>();
    const close = Promise.withResolvers<void>();
    const harness = browserHarness([{ launchGate: launch.promise, closeGate: close.promise }, {}]);
    const instance = auth(harness, { loginTimeoutMs: 30, authCooldownMs: 0 });
    try {
      await expect(within(instance.getCookies())).rejects.toMatchObject({
        code: 'AUTHENTICATION_FAILED',
      });
      launch.resolve();
      expect(await within(instance.getCookies())).toBe('.ASPXFORMSAUTH=fresh');
      expect(harness.calls.launches).toBe(2);
      expect(harness.calls.contexts).toBe(1);
      expect(harness.calls.closes).toBe(2);
      await within(instance.close());
    } finally {
      launch.resolve();
      close.resolve();
    }
  });

  test('browser cleanup errors never expose browser exception details', async () => {
    const harness = browserHarness([
      { fail: true, closeError: new Error('secret browser form values') },
    ]);
    const instance = auth(harness);
    const error: unknown = await instance.getCookies().catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      message: 'Engage authentication failed',
    });
    expect(error).not.toHaveProperty('cause');
    expect(harness.calls.closes).toBe(1);
  });
});
