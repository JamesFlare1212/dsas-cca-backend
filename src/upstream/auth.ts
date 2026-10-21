import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { launch } from 'cloakbrowser';
import type { Cookie } from 'playwright-core';
import { UpstreamError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';

export interface AuthOptions {
  baseUrl: string;
  username: string;
  password: string;
  cookiePath: string;
  loginTimeoutMs: number;
  authCooldownMs: number;
  credentialsEncoded: boolean;
}

// This small structural interface keeps the launcher injectable without requiring
// tests to implement all of Playwright. CloakBrowser's Browser satisfies it.
interface LoginLocator {
  fill(value: string, options: { timeout: number }): Promise<void>;
  check(options: { timeout: number }): Promise<void>;
  click(options: { timeout: number }): Promise<void>;
  first(): LoginLocator;
  isVisible(): Promise<boolean>;
}

interface LoginPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  locator(selector: string): LoginLocator;
  waitForURL(
    predicate: (url: URL) => boolean,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
  ): Promise<void>;
  url(): string;
}

interface LoginContext {
  newPage(): Promise<LoginPage>;
  cookies(urls?: string | string[]): Promise<Cookie[]>;
}

interface LoginBrowser {
  newContext(): Promise<LoginContext>;
  close(): Promise<void>;
}

export type BrowserLauncher = (options: { headless: true }) => Promise<LoginBrowser>;

interface CookieCache {
  version: 1;
  authenticatedBy: 'cookie' | 'marker';
  cookies: Cookie[];
}

const AUTH_COOKIE =
  /^(?:\.ASPXAUTH|\.ASPXFORMSAUTH|\.AspNet\.ApplicationCookie|\.AspNetCore\.Cookies(?:C\d+)?)$/i;
const LOGOUT_SELECTOR =
  'a[href*="logout" i], a[href*="signout" i], input[name*="logout" i], input[name*="signout" i], a:has-text("Logout"), a:has-text("Sign Out"), a:has-text("退出"), a:has-text("登出")';
const MAX_COOKIE_FILE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCookie(value: unknown): value is Cookie {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(value.name) &&
    typeof value.value === 'string' &&
    /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(value.value) &&
    typeof value.domain === 'string' &&
    value.domain.length > 0 &&
    typeof value.path === 'string' &&
    value.path.startsWith('/') &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires) &&
    typeof value.httpOnly === 'boolean' &&
    typeof value.secure === 'boolean' &&
    (value.sameSite === 'Strict' || value.sameSite === 'Lax' || value.sameSite === 'None')
  );
}

function relevantCookies(cookies: readonly Cookie[], url: URL): Cookie[] {
  const nowSeconds = Date.now() / 1000;
  return cookies
    .filter((cookie) => {
      if (
        !isCookie(cookie) ||
        !cookie.value ||
        (cookie.expires !== -1 && cookie.expires <= nowSeconds)
      )
        return false;
      const domain = cookie.domain.toLowerCase();
      const host = url.hostname.toLowerCase();
      const domainMatches = domain.startsWith('.')
        ? host === domain.slice(1) || host.endsWith(domain)
        : host === domain;
      const pathMatches =
        url.pathname === cookie.path ||
        (url.pathname.startsWith(cookie.path) &&
          (cookie.path.endsWith('/') || url.pathname.charAt(cookie.path.length) === '/'));
      return domainMatches && pathMatches && (!cookie.secure || url.protocol === 'https:');
    })
    .sort((a, b) => b.path.length - a.path.length);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

// Callers detach from shared work on cancellation; they never abort that work.
function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class CookieAuth {
  private readonly options: AuthOptions;
  private readonly activityUrl: URL;
  private readonly loginUrl: URL;
  private cache: CookieCache | undefined;
  private cacheLoad: Promise<void> | undefined;
  private loginPromise: Promise<string> | undefined;
  private loginController: AbortController | undefined;
  private browser: LoginBrowser | undefined;
  private readonly closingBrowsers = new WeakMap<LoginBrowser, Promise<void>>();
  private cooldownUntil = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    options: AuthOptions,
    private readonly logger: Logger,
    private readonly launcher: BrowserLauncher = launch,
  ) {
    this.options = { ...options };
    this.activityUrl = new URL(
      '/Services/ActivitiesService.asmx/GetActivityDetails',
      options.baseUrl,
    );
    this.loginUrl = new URL('/Login.aspx', options.baseUrl);
    if (
      !Number.isFinite(options.loginTimeoutMs) ||
      options.loginTimeoutMs <= 0 ||
      options.loginTimeoutMs > 2_147_483_647 ||
      !Number.isFinite(options.authCooldownMs) ||
      options.authCooldownMs < 0
    ) {
      throw new RangeError('Invalid authentication timeout or cooldown');
    }
  }

  async getCookies(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.assertOpen();
    await waitForCaller(this.loadCache(), signal);
    signal?.throwIfAborted();
    this.assertOpen();
    const current = this.cookieHeader();
    return current ?? waitForCaller(this.ensureLogin(), signal);
  }

  async refreshCookies(rejectedCookie: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.assertOpen();
    await waitForCaller(this.loadCache(), signal);
    signal?.throwIfAborted();
    this.assertOpen();
    const current = this.cookieHeader();
    // An older request can reject after another request already refreshed.
    if (current && current !== rejectedCookie) return current;
    return waitForCaller(this.ensureLogin(), signal);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.loginController?.abort(new DOMException('Authentication service closed', 'AbortError'));
    this.closing = (async () => {
      if (this.browser) await this.closeBrowser(this.browser);
      await this.loginPromise?.catch(() => undefined);
    })();
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new UpstreamError('AUTHENTICATION_FAILED', 'Authentication service is closed');
  }

  private cookieHeader(cache = this.cache): string | undefined {
    if (!cache) return undefined;
    const cookies = relevantCookies(cache.cookies, this.activityUrl);
    if (
      !cookies.length ||
      (cache.authenticatedBy === 'cookie' &&
        !cookies.some((cookie) => AUTH_COOKIE.test(cookie.name)))
    )
      return undefined;
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  private loadCache(): Promise<void> {
    this.cacheLoad ??= (async () => {
      let file: FileHandle | undefined;
      try {
        file = await open(this.options.cookiePath, 'r');
        if ((await file.stat()).size > MAX_COOKIE_FILE_BYTES)
          throw new Error('Oversized cookie cache');
        const parsed: unknown = JSON.parse(await file.readFile('utf8'));
        const legacy = Array.isArray(parsed);
        const values: unknown = legacy
          ? parsed
          : isRecord(parsed) && parsed.version === 1
            ? parsed.cookies
            : undefined;
        if (!Array.isArray(values) || !values.every(isCookie))
          throw new Error('Invalid cookie cache');
        const authenticatedBy =
          !legacy && isRecord(parsed) && parsed.authenticatedBy === 'marker' ? 'marker' : 'cookie';
        this.cache = {
          version: 1,
          authenticatedBy,
          cookies: relevantCookies(values, this.activityUrl),
        };
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT')
          this.logger.warn('Could not load authentication cache');
      } finally {
        await file?.close();
      }
    })();
    return this.cacheLoad;
  }

  private ensureLogin(): Promise<string> {
    this.assertOpen();
    if (this.loginPromise) return this.loginPromise;
    if (Date.now() < this.cooldownUntil) {
      return Promise.reject(
        new UpstreamError(
          'AUTHENTICATION_FAILED',
          'Authentication is cooling down after a failed login',
        ),
      );
    }
    const controller = new AbortController();
    this.loginController = controller;
    const timer = setTimeout(
      () => controller.abort(new DOMException('Authentication timed out', 'TimeoutError')),
      this.options.loginTimeoutMs,
    );
    this.loginPromise = this.login(controller.signal)
      .catch(() => {
        this.cooldownUntil = Date.now() + this.options.authCooldownMs;
        this.logger.warn('Engage authentication failed');
        // Browser exceptions may include form values. Keep them out of errors/logs.
        throw new UpstreamError(
          'AUTHENTICATION_FAILED',
          this.closed ? 'Authentication service is closed' : 'Engage authentication failed',
        );
      })
      .finally(() => {
        clearTimeout(timer);
        this.loginPromise = undefined;
        this.loginController = undefined;
      });
    return this.loginPromise;
  }

  private async login(signal: AbortSignal): Promise<string> {
    let browser: LoginBrowser | undefined;
    try {
      const pendingBrowser = this.launcher({ headless: true }).then(async (launched) => {
        if (signal.aborted || this.closed) {
          await this.closeBrowser(launched);
          throw abortReason(signal);
        }
        this.browser = launched;
        return launched;
      });
      browser = await waitForCaller(pendingBrowser, signal);
      const cache = await waitForCaller(this.authenticate(browser, signal), signal);
      signal.throwIfAborted();
      const header = this.cookieHeader(cache);
      if (!header) throw new Error('No usable authentication cookies');
      await this.persist(cache, signal);
      signal.throwIfAborted();
      this.assertOpen();
      this.cache = cache;
      this.cooldownUntil = 0;
      this.logger.info('Engage authentication succeeded');
      return header;
    } finally {
      if (browser) await this.closeBrowser(browser);
      if (this.browser === browser) this.browser = undefined;
    }
  }

  private async authenticate(browser: LoginBrowser, signal: AbortSignal): Promise<CookieCache> {
    const deadline = Date.now() + this.options.loginTimeoutMs;
    const remaining = () => {
      signal.throwIfAborted();
      return Math.max(1, deadline - Date.now());
    };
    const username = this.options.credentialsEncoded
      ? decodeURIComponent(this.options.username)
      : this.options.username;
    const password = this.options.credentialsEncoded
      ? decodeURIComponent(this.options.password)
      : this.options.password;
    const context = await browser.newContext();
    signal.throwIfAborted();
    const page = await context.newPage();
    await page.goto(this.loginUrl.href, { waitUntil: 'domcontentloaded', timeout: remaining() });
    if (new URL(page.url()).origin !== this.loginUrl.origin)
      throw new Error('Login page left the Engage origin');
    await page
      .locator('input[name="ctl00$PageContent$loginControl$txtUN"]')
      .fill(username, { timeout: remaining() });
    await page
      .locator('input[name="ctl00$PageContent$loginControl$txtPwd"]')
      .fill(password, { timeout: remaining() });
    const remember = page.locator('input[name="ctl00$PageContent$loginControl$cbRememberMe"]');
    if (await remember.isVisible()) await remember.check({ timeout: remaining() });
    // Install the navigation waiter before submitting to avoid a fast redirect race.
    await Promise.all([
      page.waitForURL((url) => this.isAuthenticatedDestination(url), {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      }),
      page
        .locator('input[name="ctl00$PageContent$loginControl$btnLogin"]')
        .click({ timeout: remaining() }),
    ]);
    signal.throwIfAborted();
    if (!this.isAuthenticatedDestination(new URL(page.url())))
      throw new Error('Login did not navigate successfully');
    const cookies = relevantCookies(await context.cookies(this.activityUrl.href), this.activityUrl);
    const hasAuthCookie = cookies.some((cookie) => AUTH_COOKIE.test(cookie.name));
    const hasAuthenticatedMarker = await page.locator(LOGOUT_SELECTOR).first().isVisible();
    signal.throwIfAborted();
    if (!cookies.length || (!hasAuthCookie && !hasAuthenticatedMarker))
      throw new Error('Authentication was not verified');
    return { version: 1, authenticatedBy: hasAuthCookie ? 'cookie' : 'marker', cookies };
  }

  private isAuthenticatedDestination(url: URL): boolean {
    return (
      url.origin === this.loginUrl.origin &&
      !/(?:^|\/)(?:login|signin|sign-in|error|accessdenied)(?:\.aspx)?\/?$/i.test(url.pathname)
    );
  }

  private async persist(cache: CookieCache, signal: AbortSignal): Promise<void> {
    const temporary = `${this.options.cookiePath}.${randomUUID()}.tmp`;
    try {
      signal.throwIfAborted();
      await mkdir(dirname(this.options.cookiePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(cache), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      signal.throwIfAborted();
      await rename(temporary, this.options.cookiePath);
    } catch {
      signal.throwIfAborted();
      this.logger.warn('Could not persist authentication cache');
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private closeBrowser(browser: LoginBrowser): Promise<void> {
    let closing = this.closingBrowsers.get(browser);
    if (!closing) {
      // Cleanup has its own bound: the login deadline may already have fired.
      // Keep the bounded promise in the WeakMap so close/finally/late launches
      // neither wait forever nor call browser.close more than once.
      closing = new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            this.logger.warn('Could not close authentication browser before cleanup deadline');
            resolve();
          },
          Math.min(this.options.loginTimeoutMs, 5000),
        );
        void Promise.resolve()
          .then(() => browser.close())
          .catch(() => {
            this.logger.warn('Could not close authentication browser');
          })
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      });
      this.closingBrowsers.set(browser, closing);
    }
    return closing;
  }
}
