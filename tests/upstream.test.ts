import { describe, expect, spyOn, test } from 'bun:test';
import { createLogger } from '../src/core/logger.ts';
import {
  type Authenticator,
  EngageClient,
  type EngageClientOptions,
} from '../src/upstream/client.ts';

const logger = createLogger('silent');
const options: EngageClientOptions = {
  baseUrl: 'https://engage.nkcswx.cn',
  requestTimeoutMs: 1000,
  maxRetries: 0,
  retryDelayMs: 0,
  maxResponseBytes: 4096,
};
const activity = {
  isError: false,
  newRows: [{ rID: '123', fields: [{ fID: 'Title', fData: 'Test activity' }] }],
};

function activityResponse(inner: unknown = activity): Response {
  return Response.json({ d: JSON.stringify(inner) });
}

type FetchStep =
  | Response
  | Error
  | ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>);

function fixture(
  steps: FetchStep[],
  overrides: Partial<EngageClientOptions> = {},
  probeSteps: FetchStep[] = [new Response('ambiguous root outage', { status: 500 })],
) {
  const calls: { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] }[] = [];
  const postCalls: typeof calls = [];
  const probeCalls: typeof calls = [];
  const refreshes: string[] = [];
  let authCalls = 0;
  const authenticator: Authenticator = {
    getCookies: async () => {
      authCalls += 1;
      return 'auth=old';
    },
    refreshCookies: async (rejected) => {
      refreshes.push(rejected);
      return 'auth=fresh';
    },
  };
  const fetcher = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const isProbe = init?.method === 'GET';
    const methodCalls = isProbe ? probeCalls : postCalls;
    const step = (isProbe ? probeSteps : steps)[methodCalls.length];
    const call = { input, init };
    calls.push(call);
    methodCalls.push(call);
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(input, init);
    if (!step) throw new Error('Unexpected additional fetch');
    return step;
  }) as typeof fetch;
  return {
    client: new EngageClient({ ...options, ...overrides }, authenticator, logger, fetcher),
    calls,
    postCalls,
    probeCalls,
    refreshes,
    authCalls: () => authCalls,
  };
}

describe('EngageClient', () => {
  test('posts the exact Engage endpoint and double-decodes ASP.NET JSON', async () => {
    const { client, calls } = fixture([activityResponse()]);
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(String(calls[0]?.input)).toBe(
      'https://engage.nkcswx.cn/Services/ActivitiesService.asmx/GetActivityDetails',
    );
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body: '{"activityID":"123"}',
    });
    expect(new Headers(calls[0]?.init?.headers).get('cookie')).toBe('auth=old');
  });

  test('also accepts an object-valued ASP.NET envelope', async () => {
    expect(await fixture([Response.json({ d: activity })]).client.fetchActivity('123')).toEqual(
      activity,
    );
  });

  test('404 is missing; outages reject and never refresh cookies', async () => {
    expect(
      await fixture([new Response('absent', { status: 404 })]).client.fetchActivity('missing'),
    ).toBeNull();
    for (const status of [429, 500, 502, 503, 504]) {
      const { client, postCalls, probeCalls, refreshes } = fixture(
        [new Response('failure', { status }), new Response('failure', { status })],
        { maxRetries: 1 },
      );
      await expect(client.fetchActivity('123')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(postCalls).toHaveLength(2);
      expect(probeCalls).toHaveLength(status === 500 ? 1 : 0);
      expect(refreshes).toEqual([]);
    }
  });

  test('500 with an ambiguous root 500 retries as an outage without refreshing cookies', async () => {
    const { client, refreshes, postCalls, probeCalls } = fixture(
      [new Response('temporary', { status: 500 }), activityResponse()],
      { maxRetries: 1 },
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(refreshes).toEqual([]);
    expect(postCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(1);
  });

  test('500 plus a same-origin Login.aspx root redirect refreshes once and retries the POST', async () => {
    const { client, postCalls, probeCalls, refreshes } = fixture(
      [new Response('expired session', { status: 500 }), activityResponse()],
      { baseUrl: `${options.baseUrl}/nested/`, maxRetries: 0 },
      [new Response('', { status: 302, headers: { location: '/Login.aspx?ReturnUrl=%2F' } })],
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(refreshes).toEqual(['auth=old']);
    expect(postCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(1);
    expect(String(probeCalls[0]?.input)).toBe(`${options.baseUrl}/`);
    expect(probeCalls[0]?.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(probeCalls[0]?.init?.headers).get('cookie')).toBe('auth=old');
    expect(new Headers(postCalls[1]?.init?.headers).get('cookie')).toBe('auth=fresh');
  });

  test('root 401, 403 and actual 200 login forms corroborate an expired session', async () => {
    const responses = [
      new Response('', { status: 401 }),
      new Response('', { status: 403 }),
      new Response('<html><form action="/Login.aspx"><input type="password"></form></html>'),
      new Response(
        '<form><input name="ctl00$PageContent$loginControl$txtUN"><input type="password" name="ctl00$PageContent$loginControl$txtPwd"></form>',
        { headers: { 'content-type': 'text/html' } },
      ),
    ];
    for (const response of responses) {
      const { client, refreshes, postCalls, probeCalls } = fixture(
        [new Response('', { status: 500 }), activityResponse()],
        {},
        [response],
      );
      expect(await client.fetchActivity('123')).toEqual(activity);
      expect(refreshes).toEqual(['auth=old']);
      expect(postCalls).toHaveLength(2);
      expect(probeCalls).toHaveLength(1);
    }
  });

  test('ambiguous root outages stay failures and probes have a per-cookie cooldown across requests', async () => {
    for (const probe of [
      new Response('outage', { status: 500 }),
      new Response('root missing', { status: 404 }),
      new Response('<html>Maintenance, please visit Login.aspx later</html>'),
      new Response('<html><form action="/newsletter"><input name="email"></form></html>'),
      new Response('<html><form action="/settings"><input type="password"></form></html>'),
      new Response(
        '<html><!-- <form action="/Login.aspx"><input type="password"></form> --></html>',
      ),
      new Response(
        '<html><script>const example = \'<form action="/Login.aspx"><input type="password"></form>\';</script></html>',
      ),
      new TypeError('root network outage'),
    ]) {
      const { client, refreshes, postCalls, probeCalls } = fixture(
        Array.from({ length: 6 }, () => new Response('activity outage', { status: 500 })),
        { maxRetries: 1 },
        [probe],
      );
      for (let request = 0; request < 3; request += 1)
        await expect(client.fetchActivity('123')).rejects.toMatchObject({
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Engage returned HTTP 500',
        });
      expect(refreshes).toEqual([]);
      expect(postCalls).toHaveLength(6);
      expect(probeCalls).toHaveLength(1);
    }
  });

  test('session corroboration can be disabled without changing POST retry behavior', async () => {
    const { client, refreshes, postCalls, probeCalls } = fixture(
      [new Response('', { status: 500 }), activityResponse()],
      { maxRetries: 1, verifySessionOn500: false },
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(refreshes).toEqual([]);
    expect(postCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(0);
  });

  test('an ambiguous result is rechecked after 15 seconds so expired cookies can recover', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      const { client, refreshes, postCalls, probeCalls } = fixture(
        [
          new Response('', { status: 500 }),
          new Response('', { status: 500 }),
          new Response('', { status: 500 }),
          activityResponse(),
        ],
        {},
        [
          new Response('ambiguous outage', { status: 500 }),
          new Response('', { status: 302, headers: { location: '/Login.aspx' } }),
        ],
      );
      await expect(client.fetchActivity('123')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      now.mockReturnValue(114_999);
      await expect(client.fetchActivity('123')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(probeCalls).toHaveLength(1);
      now.mockReturnValue(115_000);
      expect(await client.fetchActivity('123')).toEqual(activity);
      expect(probeCalls).toHaveLength(2);
      expect(postCalls).toHaveLength(4);
      expect(refreshes).toEqual(['auth=old']);
    } finally {
      now.mockRestore();
    }
  });

  test('off-origin, malformed and unrelated root redirects neither refresh nor forward cookies', async () => {
    for (const location of [
      'https://outside.example/Login.aspx',
      '//outside.example/Login.aspx',
      'https://engage.nkcswx.cn@outside.example/Login.aspx',
      'http://engage.nkcswx.cn/Login.aspx',
      '/maintenance',
      'http://[invalid',
    ]) {
      const { client, calls, postCalls, probeCalls, refreshes } = fixture(
        [new Response('', { status: 500 })],
        {},
        [new Response('', { status: 302, headers: { location } })],
      );
      await expect(client.fetchActivity('123')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(refreshes).toEqual([]);
      expect(postCalls).toHaveLength(1);
      expect(probeCalls).toHaveLength(1);
      expect(calls.every((call) => new URL(String(call.input)).origin === options.baseUrl)).toBe(
        true,
      );
      expect(calls.every((call) => call.init?.redirect === 'manual')).toBe(true);
    }
  });

  test('a corroborated 500 after refresh is final and checks the new cookie separately', async () => {
    const { client, refreshes, postCalls, probeCalls } = fixture(
      [new Response('', { status: 500 }), new Response('', { status: 500 })],
      { maxRetries: 3 },
      [new Response('', { status: 401 }), new Response('', { status: 403 })],
    );
    await expect(client.fetchActivity('123')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(refreshes).toEqual(['auth=old']);
    expect(postCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(2);
    expect(new Headers(probeCalls[1]?.init?.headers).get('cookie')).toBe('auth=fresh');
  });

  test('concurrent requests coalesce a root probe and reuse its ambiguous result', async () => {
    const started = Promise.withResolvers<void>();
    const root = Promise.withResolvers<Response>();
    const { client, refreshes, postCalls, probeCalls } = fixture(
      Array.from({ length: 9 }, () => new Response('', { status: 500 })),
      {},
      [
        async () => {
          started.resolve();
          return root.promise;
        },
      ],
    );
    const pending = Promise.allSettled(
      Array.from({ length: 8 }, () => client.fetchActivity('123')),
    );
    await started.promise;
    expect(postCalls).toHaveLength(8);
    expect(probeCalls).toHaveLength(1);
    root.resolve(new Response('root outage', { status: 500 }));
    expect((await pending).every((result) => result.status === 'rejected')).toBe(true);
    await expect(client.fetchActivity('123')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(postCalls).toHaveLength(9);
    expect(probeCalls).toHaveLength(1);
    expect(refreshes).toEqual([]);
  });

  test('cancelling one caller detaches from a shared root probe while another can refresh', async () => {
    const started = Promise.withResolvers<void>();
    const root = Promise.withResolvers<Response>();
    let probeSignal: AbortSignal | null | undefined;
    const { client, postCalls, probeCalls, refreshes } = fixture(
      [new Response('', { status: 500 }), new Response('', { status: 500 }), activityResponse()],
      {},
      [
        async (_input, init) => {
          probeSignal = init?.signal;
          started.resolve();
          return root.promise;
        },
      ],
    );
    const controller = new AbortController();
    const cancelled = client.fetchActivity('123', controller.signal);
    const surviving = client.fetchActivity('456');
    await started.promise;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(probeSignal?.aborted).toBe(false);
    root.resolve(new Response('', { status: 302, headers: { location: '/Login.aspx' } }));
    expect(await surviving).toEqual(activity);
    expect(postCalls).toHaveLength(3);
    expect(probeCalls).toHaveLength(1);
    expect(refreshes).toEqual(['auth=old']);
  });

  test('last-caller cancellation aborts the root fetch and disposes of a late response', async () => {
    const started = Promise.withResolvers<void>();
    const root = Promise.withResolvers<Response>();
    const bodyCancelled = Promise.withResolvers<void>();
    let probeSignal: AbortSignal | null | undefined;
    const { client, postCalls, probeCalls, refreshes } = fixture(
      [new Response('', { status: 500 })],
      { maxRetries: 3 },
      [
        async (_input, init) => {
          probeSignal = init?.signal;
          started.resolve();
          return root.promise;
        },
      ],
    );
    const controller = new AbortController();
    const pending = client.fetchActivity('123', controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(probeSignal?.aborted).toBe(true);
    root.resolve(new Response(new ReadableStream({ cancel: () => bodyCancelled.resolve() })));
    await bodyCancelled.promise;
    expect(postCalls).toHaveLength(1);
    expect(probeCalls).toHaveLength(1);
    expect(refreshes).toEqual([]);
  });

  test('source shutdown aborts a probe shared by all callers without retries', async () => {
    const started = Promise.withResolvers<void>();
    let probeSignal: AbortSignal | null | undefined;
    const { client, postCalls, probeCalls, refreshes } = fixture(
      [new Response('', { status: 500 }), new Response('', { status: 500 })],
      { maxRetries: 3 },
      [
        async (_input, init) => {
          probeSignal = init?.signal;
          started.resolve();
          return new Promise<Response>(() => undefined);
        },
      ],
    );
    const shutdown = new AbortController();
    const pending = Promise.allSettled([
      client.fetchActivity('123', shutdown.signal),
      client.fetchActivity('456', shutdown.signal),
    ]);
    await started.promise;
    const reason = new Error('Service is shutting down');
    shutdown.abort(reason);
    for (const result of await pending) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toBe(reason);
    }
    expect(probeSignal?.aborted).toBe(true);
    expect(postCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(1);
    expect(refreshes).toEqual([]);
  });

  test('a stalled root fetch times out as ambiguous and permits the normal POST retry', async () => {
    let probeSignal: AbortSignal | null | undefined;
    const { client, postCalls, probeCalls, refreshes } = fixture(
      [new Response('', { status: 500 }), activityResponse()],
      { requestTimeoutMs: 20, maxRetries: 1 },
      [
        async (_input, init) => {
          probeSignal = init?.signal;
          return new Promise<Response>(() => undefined);
        },
      ],
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(probeSignal?.aborted).toBe(true);
    expect(postCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(1);
    expect(refreshes).toEqual([]);
  });

  test('root probe body streaming is bounded by the response limit, timeout and cancellation', async () => {
    let oversizedCancelled = false;
    let stalledCancelled = false;
    const responses = [
      new Response('<form action="/Login.aspx"><input type="password"></form>', {
        headers: { 'content-length': '9999', 'content-type': 'text/html' },
      }),
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(64));
          },
          cancel() {
            oversizedCancelled = true;
          },
        }),
      ),
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            stalledCancelled = true;
          },
        }),
      ),
    ];
    for (const response of responses) {
      const { client, postCalls, probeCalls, refreshes } = fixture(
        [new Response('', { status: 500 })],
        { requestTimeoutMs: 20, maxResponseBytes: 32 },
        [response],
      );
      await expect(client.fetchActivity('123')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Engage returned HTTP 500',
      });
      expect(postCalls).toHaveLength(1);
      expect(probeCalls).toHaveLength(1);
      expect(refreshes).toEqual([]);
    }
    expect(oversizedCancelled).toBe(true);
    expect(stalledCancelled).toBe(true);

    const reading = Promise.withResolvers<void>();
    let cancelled = false;
    const { client, refreshes } = fixture([new Response('', { status: 500 })], {}, [
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              reading.resolve();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    ]);
    const controller = new AbortController();
    const pending = client.fetchActivity('123', controller.signal);
    await reading.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The shared probe's reader is released as its own abort propagates.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
    expect(refreshes).toEqual([]);
  });

  test('POST retries, probes and the post-refresh attempt share the same request pacing budget', async () => {
    const started: number[] = [];
    const response = (value: Response) => async () => {
      started.push(performance.now());
      return value;
    };
    const { client, calls, postCalls, probeCalls, refreshes } = fixture(
      [
        response(new Response('', { status: 503 })),
        response(new Response('', { status: 500 })),
        response(activityResponse()),
      ],
      { maxRetries: 1, requestsPerMinute: 1500 },
      [response(new Response('', { status: 302, headers: { location: '/Login.aspx' } }))],
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(calls.map((call) => call.init?.method)).toEqual(['POST', 'POST', 'GET', 'POST']);
    expect(postCalls).toHaveLength(3);
    expect(probeCalls).toHaveLength(1);
    expect(refreshes).toEqual(['auth=old']);
    expect(started).toHaveLength(4);
    for (let index = 1; index < started.length; index += 1)
      expect((started[index] ?? 0) - (started[index - 1] ?? 0)).toBeGreaterThanOrEqual(30);
  });

  test('cancelling while a probe waits for the request budget starts no GET or login', async () => {
    const { client, postCalls, probeCalls, refreshes } = fixture(
      [new Response('', { status: 500 })],
      { requestsPerMinute: 60, maxRetries: 2 },
    );
    const controller = new AbortController();
    const pending = client.fetchActivity('123', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postCalls).toHaveLength(1);
    expect(probeCalls).toHaveLength(0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(probeCalls).toHaveLength(0);
    expect(refreshes).toEqual([]);
  });

  test('only concrete missing responses return null; ambiguous business errors reject', async () => {
    for (const inner of [
      null,
      { isError: true, code: 'ACTIVITY_NOT_FOUND' },
      { isError: true, message: 'Activity not found.' },
    ]) {
      expect(await fixture([activityResponse(inner)]).client.fetchActivity('123')).toBeNull();
    }
    for (const inner of [
      { isError: true },
      { isError: true, newRows: [] },
      { isError: true, message: 'Database unavailable' },
    ]) {
      await expect(
        fixture([activityResponse(inner)]).client.fetchActivity('123'),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    }
    expect(await fixture([activityResponse({ newRows: [] })]).client.fetchActivity('123')).toEqual({
      newRows: [],
    });
  });

  test('401 and 403 refresh once and retry with fresh cookies', async () => {
    for (const status of [401, 403]) {
      const { client, refreshes, calls } = fixture([
        new Response('', { status }),
        activityResponse(),
      ]);
      expect(await client.fetchActivity('123')).toEqual(activity);
      expect(refreshes).toEqual(['auth=old']);
      expect(new Headers(calls[1]?.init?.headers).get('cookie')).toBe('auth=fresh');
    }
  });

  test('an authentication failure after refresh is final even with retries available', async () => {
    const { client, refreshes, calls } = fixture(
      [new Response('', { status: 401 }), new Response('', { status: 403 })],
      { maxRetries: 3 },
    );
    await expect(client.fetchActivity('123')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(refreshes).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test('a login redirect refreshes cookies without following it', async () => {
    const { client, refreshes, calls } = fixture([
      new Response('', { status: 302, headers: { location: '/Login.aspx?ReturnUrl=%2FServices' } }),
      activityResponse(),
    ]);
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(refreshes).toEqual(['auth=old']);
    expect(calls.every((call) => call.init?.redirect === 'manual')).toBe(true);
  });

  test('unexpected and malformed redirects are protocol errors rather than missing records', async () => {
    for (const location of [
      '/maintenance',
      'http://[invalid',
      'https://outside.example/Login.aspx',
    ]) {
      const { client, refreshes } = fixture([
        new Response('', { status: 302, headers: { location } }),
      ]);
      await expect(client.fetchActivity('123')).rejects.toMatchObject({
        code: 'UPSTREAM_PROTOCOL_ERROR',
      });
      expect(refreshes).toEqual([]);
    }
  });

  test('200 login HTML refreshes; other HTML is a protocol failure', async () => {
    const { client, refreshes } = fixture([
      new Response(
        '<html><form><input type="password" name="ctl00$PageContent$loginControl$txtPwd"></form></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
      activityResponse(),
    ]);
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(refreshes).toHaveLength(1);
    await expect(
      fixture([new Response('<html>Maintenance</html>')]).client.fetchActivity('123'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_PROTOCOL_ERROR' });
  });

  test('malformed outer, inner and schema-invalid JSON reject instead of appearing missing', async () => {
    for (const body of ['{', '{"d":"{"}', '{"wrong":true}', '{"d":42}', '{"d":{"newRows":[{}]}}']) {
      const { client, calls } = fixture([new Response(body)], { maxRetries: 3 });
      await expect(client.fetchActivity('123')).rejects.toMatchObject({
        code: 'UPSTREAM_PROTOCOL_ERROR',
      });
      expect(calls).toHaveLength(1);
    }
  });

  test('content-length and chunked response size limits both abort oversized bodies', async () => {
    const declared = fixture([new Response('small', { headers: { 'content-length': '9999' } })], {
      maxResponseBytes: 16,
    });
    await expect(declared.client.fetchActivity('123')).rejects.toMatchObject({
      code: 'UPSTREAM_PROTOCOL_ERROR',
    });
    let cancelled = false;
    let chunk = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunked = fixture([new Response(stream)], { maxResponseBytes: 16 });
    await expect(chunked.client.fetchActivity('123')).rejects.toMatchObject({
      code: 'UPSTREAM_PROTOCOL_ERROR',
    });
    expect(cancelled).toBe(true);
    expect(chunk).toBeLessThanOrEqual(4);
  });

  test('network failures retry the configured number of times', async () => {
    const { client, calls, refreshes } = fixture(
      [new TypeError('network down'), new TypeError('network down'), activityResponse()],
      { maxRetries: 2 },
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(calls).toHaveLength(3);
    expect(refreshes).toEqual([]);
  });

  test('per-attempt timeout covers an injected fetch that ignores abort, then retries', async () => {
    let timedSignal: AbortSignal | null | undefined;
    const { client, calls } = fixture(
      [
        async (_input, init) => {
          timedSignal = init?.signal;
          return new Promise<Response>(() => undefined);
        },
        activityResponse(),
      ],
      { requestTimeoutMs: 20, maxRetries: 1 },
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(timedSignal?.aborted).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('the per-attempt timeout includes stalled body streaming', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const { client } = fixture([new Response(stream)], { requestTimeoutMs: 20 });
    await expect(client.fetchActivity('123')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(cancelled).toBe(true);
  });

  test('already aborted requests do no authentication or fetch work', async () => {
    const { client, calls, authCalls } = fixture([]);
    await expect(client.fetchActivity('123', AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toEqual([]);
    expect(authCalls()).toBe(0);
  });

  test('parent cancellation immediately aborts in-flight fetch without retries', async () => {
    const started = Promise.withResolvers<void>();
    let attemptSignal: AbortSignal | null | undefined;
    const { client, calls } = fixture(
      [
        async (_input, init) => {
          attemptSignal = init?.signal;
          started.resolve();
          return new Promise<Response>(() => undefined);
        },
      ],
      { maxRetries: 3 },
    );
    const controller = new AbortController();
    const pending = client.fetchActivity('123', controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(attemptSignal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('Retry-After backoff is cancellable and does not start another request', async () => {
    for (const retryAfter of ['30', new Date(Date.now() + 30_000).toUTCString()]) {
      const { client, calls } = fixture(
        [new Response('', { status: 429, headers: { 'retry-after': retryAfter } })],
        { maxRetries: 2, retryDelayMs: 1 },
      );
      const controller = new AbortController();
      const pending = client.fetchActivity('123', controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveLength(1);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(1);
    }
  });

  test('Retry-After delays retries beyond the configured zero delay', async () => {
    const start = performance.now();
    const { client } = fixture(
      [new Response('', { status: 503, headers: { 'retry-after': '0.03' } }), activityResponse()],
      { maxRetries: 1 },
    );
    expect(await client.fetchActivity('123')).toEqual(activity);
    expect(performance.now() - start).toBeGreaterThanOrEqual(25);
  });

  test('cancellation during body streaming cancels the reader', async () => {
    const reading = Promise.withResolvers<void>();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { client, calls } = fixture([new Response(stream)], { maxRetries: 2 });
    const controller = new AbortController();
    const pending = client.fetchActivity('123', controller.signal);
    await reading.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
