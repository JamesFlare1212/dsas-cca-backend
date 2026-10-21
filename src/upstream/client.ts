import { RequestPacer } from '../core/async.ts';
import { UpstreamError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import type { RawActivity } from '../domain/normalize.ts';
import { parseRawActivity } from '../domain/normalize.ts';

export interface ActivitySource {
  fetchActivity(id: string, signal?: AbortSignal): Promise<RawActivity | null>;
}

export interface EngageClientOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxResponseBytes: number;
  requestsPerMinute?: number;
  /** Corroborate activity HTTP 500s with a bounded root session check (default: true). */
  verifySessionOn500?: boolean;
}

export interface Authenticator {
  getCookies(signal?: AbortSignal): Promise<string>;
  refreshCookies(rejectedCookie: string, signal?: AbortSignal): Promise<string>;
}

class AuthenticationRequired extends Error {}

interface SessionProbe {
  controller: AbortController;
  pending: Promise<boolean>;
  waiters: number;
  finishedAt?: number;
}

class RetryableFailure extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const MAX_BACKOFF_MS = 30_000;
const SESSION_PROBE_COOLDOWN_MS = 15_000;
const MAX_SESSION_PROBES = 16;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortReason(signal) : undefined);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(MAX_BACKOFF_MS, Number(value) * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(MAX_BACKOFF_MS, Math.max(0, timestamp - Date.now()))
    : undefined;
}

function isLoginUrl(url: URL): boolean {
  return /(?:^|\/)(?:login|signin|sign-in)(?:\.aspx)?\/?$/i.test(url.pathname);
}

function redirectDestination(response: Response, base: URL): URL | undefined {
  const location = response.headers.get('location');
  try {
    return location ? new URL(location, base) : undefined;
  } catch {
    return undefined;
  }
}

function isSessionLoginUrl(url: URL | undefined, root: URL): boolean {
  return url?.origin === root.origin && /(?:^|\/)Login\.aspx\/?$/i.test(url.pathname);
}

function isHtml(response: Response, text: string): boolean {
  return (
    /text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '') ||
    /^\s*(?:<!doctype\s+html|<html\b|<form\b)/i.test(text)
  );
}

function hasSessionLoginForm(text: string, root: URL): boolean {
  // Require a real form with a password field and Engage fields or a local login action.
  const markup = text.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const form of markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)) {
    const fields = form[2] ?? '';
    if (!/<input\b[^>]*\btype\s*=\s*(?:"password"|'password'|password(?=[\s/>]))/i.test(fields))
      continue;
    if (
      /<input\b[^>]*\b(?:name|id)\s*=\s*["'][^"']*loginControl[$_](?:txtUN|txtPwd)["']/i.test(
        fields,
      )
    )
      return true;
    const action = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(form[1] ?? '');
    const destination = action?.[1] ?? action?.[2] ?? action?.[3];
    try {
      if (destination && isSessionLoginUrl(new URL(destination, root), root)) return true;
    } catch {
      // Malformed form actions do not establish session expiry.
    }
  }
  return false;
}

function isConcreteMissing(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.notFound === true || value.found === false) return true;
  const code = value.code ?? value.errorCode ?? value.statusCode;
  if (
    code === 404 ||
    (typeof code === 'string' &&
      /^(?:NOT_FOUND|ACTIVITY_NOT_FOUND|RECORD_NOT_FOUND|ACTIVITY_DOES_NOT_EXIST|NO_SUCH_ACTIVITY)$/.test(
        code.toUpperCase().replace(/[ -]/g, '_'),
      ))
  )
    return true;
  const message = value.message ?? value.errorMessage;
  return (
    typeof message === 'string' &&
    /^(?:(?:the )?activity (?:was |is )?not found|(?:the )?activity does not exist|活动不存在|未找到活动)[.!。]?$/i.test(
      message.trim(),
    )
  );
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function boundedText(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
    discardBody(response);
    throw new UpstreamError(
      'UPSTREAM_PROTOCOL_ERROR',
      'Engage response exceeds the configured size limit',
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > limit)
        throw new UpstreamError(
          'UPSTREAM_PROTOCOL_ERROR',
          'Engage response exceeds the configured size limit',
        );
      try {
        text += decoder.decode(result.value, { stream: true });
      } catch {
        throw new UpstreamError('UPSTREAM_PROTOCOL_ERROR', 'Engage response is not valid UTF-8');
      }
    }
    try {
      return text + decoder.decode();
    } catch {
      throw new UpstreamError('UPSTREAM_PROTOCOL_ERROR', 'Engage response is not valid UTF-8');
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class EngageClient implements ActivitySource {
  private readonly pacer: RequestPacer;
  private readonly options: EngageClientOptions;
  private readonly endpoint: URL;
  private readonly root: URL;
  private readonly sessionProbes = new Map<string, SessionProbe>();

  constructor(
    options: EngageClientOptions,
    private readonly authenticator: Authenticator,
    private readonly logger: Logger,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.options = { ...options };
    this.pacer = new RequestPacer(options.requestsPerMinute ?? 0);
    this.endpoint = new URL('/Services/ActivitiesService.asmx/GetActivityDetails', options.baseUrl);
    this.root = new URL('/', this.endpoint);
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0 ||
      options.requestTimeoutMs > 2_147_483_647 ||
      !Number.isInteger(options.maxRetries) ||
      options.maxRetries < 0 ||
      !Number.isFinite(options.retryDelayMs) ||
      options.retryDelayMs < 0 ||
      !Number.isInteger(options.maxResponseBytes) ||
      options.maxResponseBytes <= 0
    ) {
      throw new RangeError('Invalid upstream request limits');
    }
  }

  async fetchActivity(id: string, signal?: AbortSignal): Promise<RawActivity | null> {
    signal?.throwIfAborted();
    let cookies = await this.authenticate(() => this.authenticator.getCookies(signal), signal);
    let refreshed = false;
    let retries = 0;
    for (;;) {
      signal?.throwIfAborted();
      try {
        return await this.attempt(id, cookies, signal);
      } catch (error) {
        signal?.throwIfAborted();
        const authenticationRequired =
          error instanceof AuthenticationRequired ||
          (error instanceof RetryableFailure &&
            error.status === 500 &&
            this.options.verifySessionOn500 !== false &&
            (await this.sessionExpired(cookies, signal)));
        signal?.throwIfAborted();
        if (authenticationRequired) {
          if (refreshed)
            throw new UpstreamError(
              'AUTHENTICATION_FAILED',
              'Engage rejected refreshed authentication',
            );
          refreshed = true;
          cookies = await this.authenticate(
            () => this.authenticator.refreshCookies(cookies, signal),
            signal,
          );
          continue;
        }
        if (!(error instanceof RetryableFailure)) throw error;
        if (retries >= this.options.maxRetries)
          throw new UpstreamError('UPSTREAM_UNAVAILABLE', error.message);
        const exponential = Math.min(
          MAX_BACKOFF_MS,
          this.options.retryDelayMs * 2 ** Math.min(retries, 20),
        );
        const wait = Math.min(
          MAX_BACKOFF_MS,
          Math.max(exponential * (0.5 + Math.random() * 0.5), error.retryAfterMs ?? 0),
        );
        retries += 1;
        this.logger.warn({ attempt: retries, status: error.status }, 'Retrying Engage request');
        await delay(wait, signal);
      }
    }
  }

  private async authenticate(action: () => Promise<string>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    try {
      const pending = action();
      const cookies = await (signal ? abortable(pending, signal) : pending);
      signal?.throwIfAborted();
      if (!cookies) throw new Error('Missing authentication cookies');
      return cookies;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError('AUTHENTICATION_FAILED', 'Could not authenticate with Engage');
    }
  }

  private async attempt(
    id: string,
    cookies: string,
    signal?: AbortSignal,
  ): Promise<RawActivity | null> {
    return this.request(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          Accept: 'application/json',
          Cookie: cookies,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ activityID: id }),
      },
      async (response, attemptSignal) => {
        if (response.status === 401 || response.status === 403) {
          discardBody(response);
          throw new AuthenticationRequired();
        }
        if (response.status >= 300 && response.status < 400) {
          discardBody(response);
          const destination = redirectDestination(response, this.endpoint);
          if (destination?.origin === this.endpoint.origin && isLoginUrl(destination))
            throw new AuthenticationRequired();
          throw new UpstreamError(
            'UPSTREAM_PROTOCOL_ERROR',
            'Engage returned an unexpected redirect',
          );
        }
        if (response.redirected) {
          discardBody(response);
          const destination = response.url ? new URL(response.url) : undefined;
          if (destination?.origin === this.endpoint.origin && isLoginUrl(destination))
            throw new AuthenticationRequired();
          throw new UpstreamError(
            'UPSTREAM_PROTOCOL_ERROR',
            'Engage unexpectedly followed a redirect',
          );
        }
        if (response.status === 404) {
          discardBody(response);
          return null;
        }
        if (RETRYABLE_STATUSES.has(response.status)) {
          discardBody(response);
          throw new RetryableFailure(
            `Engage returned HTTP ${response.status}`,
            response.status,
            retryAfter(response.headers.get('retry-after')),
          );
        }
        if (response.status !== 200) {
          discardBody(response);
          throw new UpstreamError(
            'UPSTREAM_UNAVAILABLE',
            `Engage returned unexpected HTTP ${response.status}`,
          );
        }
        const text = await boundedText(response, this.options.maxResponseBytes, attemptSignal);
        attemptSignal.throwIfAborted();
        if (isHtml(response, text)) {
          if (
            /loginControl\$(?:txtUN|txtPwd|btnLogin)|<input\b[^>]*\btype\s*=\s*["']?password\b|<form\b[^>]*\baction\s*=\s*["'][^"']*Login\.aspx/i.test(
              text,
            )
          )
            throw new AuthenticationRequired();
          throw new UpstreamError(
            'UPSTREAM_PROTOCOL_ERROR',
            'Engage returned HTML instead of activity JSON',
          );
        }
        return this.decode(text);
      },
      signal,
    );
  }

  private async sessionExpired(cookies: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    for (const [cookie, probe] of this.sessionProbes) {
      if (
        probe.controller.signal.aborted ||
        (probe.finishedAt !== undefined &&
          Date.now() - probe.finishedAt >= SESSION_PROBE_COOLDOWN_MS)
      )
        this.sessionProbes.delete(cookie);
    }
    let probe = this.sessionProbes.get(cookies);
    if (!probe) {
      // Cookie churn must not create unbounded retained state or background requests.
      if (this.sessionProbes.size >= MAX_SESSION_PROBES) return false;
      const current: SessionProbe = {
        controller: new AbortController(),
        pending: Promise.resolve(false),
        waiters: 0,
      };
      current.pending = this.probeSession(cookies, current.controller.signal)
        .catch(() => false) // Probe failures never replace the original activity outage.
        .finally(() => {
          current.finishedAt = Date.now();
        });
      this.sessionProbes.set(cookies, current);
      probe = current;
    }
    probe.waiters += 1;
    try {
      return await (signal ? abortable(probe.pending, signal) : probe.pending);
    } finally {
      probe.waiters -= 1;
      // A caller detaches independently; shutdown/last-caller cancellation stops the probe.
      if (probe.waiters === 0 && probe.finishedAt === undefined) probe.controller.abort();
    }
  }

  private async probeSession(cookies: string, signal: AbortSignal): Promise<boolean> {
    return this.request(
      this.root,
      { method: 'GET', headers: { Accept: 'text/html', Cookie: cookies } },
      async (response, attemptSignal) => {
        if (
          response.redirected ||
          (response.url && new URL(response.url).origin !== this.root.origin)
        ) {
          discardBody(response);
          return false;
        }
        if (response.status === 401 || response.status === 403) {
          discardBody(response);
          return true;
        }
        if (response.status >= 300 && response.status < 400) {
          discardBody(response);
          return isSessionLoginUrl(redirectDestination(response, this.root), this.root);
        }
        if (response.status !== 200) {
          discardBody(response);
          return false;
        }
        const text = await boundedText(response, this.options.maxResponseBytes, attemptSignal);
        attemptSignal.throwIfAborted();
        return isHtml(response, text) && hasSessionLoginForm(text, this.root);
      },
      signal,
    );
  }

  private async request<T>(
    url: URL,
    init: RequestInit,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.pacer.wait(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Engage request timed out', 'TimeoutError')),
      this.options.requestTimeoutMs,
    );
    try {
      controller.signal.throwIfAborted();
      const pending = this.fetcher(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      // Also release a late response if an injected transport ignores abort.
      void pending.then(
        (response) => {
          if (controller.signal.aborted) discardBody(response);
        },
        () => undefined,
      );
      const response = await abortable(pending, controller.signal);
      return await read(response, controller.signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof UpstreamError ||
        error instanceof AuthenticationRequired ||
        error instanceof RetryableFailure
      )
        throw error;
      throw new RetryableFailure(
        controller.signal.aborted ? 'Engage request timed out' : 'Engage network request failed',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private decode(text: string): RawActivity | null {
    let inner: unknown;
    try {
      const outer: unknown = JSON.parse(text);
      if (!isRecord(outer) || !Object.hasOwn(outer, 'd'))
        throw new Error('Missing ASP.NET response envelope');
      inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
    } catch {
      throw new UpstreamError('UPSTREAM_PROTOCOL_ERROR', 'Engage returned invalid activity JSON');
    }
    if (isConcreteMissing(inner)) return null;
    if (isRecord(inner) && inner.isError === true)
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Engage reported an activity lookup failure');
    try {
      return parseRawActivity(inner);
    } catch {
      throw new UpstreamError(
        'UPSTREAM_PROTOCOL_ERROR',
        'Engage returned an invalid activity record',
      );
    }
  }
}
