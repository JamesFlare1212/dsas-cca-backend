import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieAuth } from '../src/upstream/auth.ts';
import { EngageClient } from '../src/upstream/client.ts';
import { rawActivity, silentLogger } from './helpers.ts';

const browserTest = process.env.RUN_BROWSER_TESTS === '1' ? test : test.skip;
browserTest(
  'real CloakBrowser logs into a local Engage fixture and the client reuses and refreshes its session',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsas-browser-test-'));
    let logins = 0;
    let validSession = '';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/Login.aspx' && request.method === 'GET')
          return new Response(
            `<!doctype html><form method="POST" action="/Login.aspx"><input name="ctl00$PageContent$loginControl$txtUN"><input type="password" name="ctl00$PageContent$loginControl$txtPwd"><input type="checkbox" name="ctl00$PageContent$loginControl$cbRememberMe"><input type="submit" name="ctl00$PageContent$loginControl$btnLogin" value="Login"></form>`,
            { headers: { 'Content-Type': 'text/html' } },
          );
        if (url.pathname === '/Login.aspx' && request.method === 'POST') {
          const form = await request.formData();
          if (
            form.get('ctl00$PageContent$loginControl$txtUN') !== 'local-user' ||
            form.get('ctl00$PageContent$loginControl$txtPwd') !== 'local-password'
          )
            return new Response('invalid', { status: 403 });
          logins++;
          validSession = `local-${logins}`;
          return new Response(null, {
            status: 302,
            headers: {
              Location: '/Home.aspx',
              'Set-Cookie': `.ASPXFORMSAUTH=${validSession}; Path=/; HttpOnly; SameSite=Lax`,
            },
          });
        }
        if (url.pathname === '/Home.aspx')
          return new Response('<!doctype html><a href="/Logout.aspx">Logout</a>', {
            headers: { 'Content-Type': 'text/html' },
          });
        if (url.pathname === '/') {
          return request.headers.get('Cookie')?.includes(`.ASPXFORMSAUTH=${validSession}`)
            ? new Response('<!doctype html><a href="/Logout.aspx">Logout</a>', {
                headers: { 'Content-Type': 'text/html' },
              })
            : new Response(null, { status: 302, headers: { Location: '/Login.aspx' } });
        }
        if (url.pathname === '/Services/ActivitiesService.asmx/GetActivityDetails') {
          if (!request.headers.get('Cookie')?.includes(`.ASPXFORMSAUTH=${validSession}`))
            return new Response(null, { status: 500 }); // Engage's legacy expired-session response.
          const payload = (await request.json()) as { activityID: string };
          if (payload.activityID === '404') return new Response(null, { status: 404 });
          return Response.json({ d: JSON.stringify(rawActivity(payload.activityID)) });
        }
        return new Response(null, { status: 404 });
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const auth = new CookieAuth(
      {
        baseUrl,
        username: 'local-user',
        password: 'local-password',
        cookiePath: join(directory, 'cookies.json'),
        loginTimeoutMs: 15000,
        authCooldownMs: 1000,
        credentialsEncoded: false,
      },
      silentLogger,
    );
    const client = new EngageClient(
      { baseUrl, requestTimeoutMs: 5000, maxRetries: 0, retryDelayMs: 0, maxResponseBytes: 100000 },
      auth,
      silentLogger,
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => client.fetchActivity('3350')),
      );
      expect(results.every((result) => result?.newRows?.length === 1)).toBe(true);
      expect(logins).toBe(1);
      expect(await client.fetchActivity('404')).toBeNull();
      validSession = 'expired';
      expect((await client.fetchActivity('3350'))?.newRows).toHaveLength(1);
      expect(logins).toBe(2);
    } finally {
      await auth.close();
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  45000,
);
