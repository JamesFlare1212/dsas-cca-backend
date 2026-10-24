import { expect, test } from 'bun:test';
import { launch } from 'cloakbrowser';
import { Metrics } from '../src/core/metrics.ts';
import { createApp } from '../src/http/app.ts';
import { activity, MemoryRepository, silentLogger } from './helpers.ts';

const browserTest = process.env.RUN_BROWSER_TESTS === '1' ? test : test.skip;

browserTest(
  'interactive documentation sends real requests, renders errors safely, and recovers after cancellation',
  async () => {
    const repository = new MemoryRepository();
    const fetchedAt = '2026-10-24T12:00:00.000Z';
    const value = {
      ...activity('42', '<img src=x onerror="window.docsXss=true">'),
      category: 'Arts & STEM',
      grades: { min: '-2', max: '0' },
    };
    repository.activities.set('42', { value, fetchedAt });
    const dataRequests: URL[] = [];
    const app = createApp({
      config: { allowedOrigins: [], HTTP_REQUESTS_PER_MINUTE: 0, HTTP_TIMEOUT_MS: 1000 },
      repository,
      catalog: {
        queueSize: 0,
        getActivity: async (id) => ({
          entry: { value: id === '42' ? value : null, fetchedAt },
          cache: 'HIT',
        }),
        getStaff: async () => ({
          entry: { value: { T1: 'Example Teacher' }, fetchedAt },
          cache: 'HIT',
        }),
      },
      logger: silentLogger,
      metrics: new Metrics(),
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname !== '/v1/' && url.pathname !== '/favicon.ico') dataRequests.push(url);
        return app.fetch(request);
      },
    });
    let browser: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      browser = await launch({ headless: true });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/v1/`, { waitUntil: 'networkidle' });
      expect(dataRequests).toHaveLength(0);
      const send = page.getByRole('button', { name: '发送请求', exact: true });
      const endpoint = page.getByLabel('接口', { exact: true });
      const responseBody = page.locator('#response-body');
      const responseStatus = page.locator('#response-status');
      const finish = () =>
        page.waitForFunction(
          () => document.querySelector('#api-explorer')?.getAttribute('aria-busy') === 'false',
        );

      await page.getByLabel('category', { exact: true }).fill('Arts & STEM');
      await page.getByLabel('academicYear', { exact: true }).fill('2026/2027');
      await page.getByLabel('grade', { exact: true }).fill('0');
      await page.getByLabel('isStudentLed', { exact: true }).selectOption('false');
      await page.getByLabel('offset', { exact: true }).fill('0');
      const preview = new URL((await page.locator('#request-url').textContent()) ?? '');
      expect(Object.fromEntries(preview.searchParams)).toEqual({
        category: 'Arts & STEM',
        academicYear: '2026/2027',
        grade: '0',
        isStudentLed: 'false',
        offset: '0',
      });
      await send.click();
      await finish();
      expect(dataRequests.at(-1)?.href).toBe(preview.href);
      expect(await responseStatus.textContent()).toMatch(/^200 OK · \d+ ms$/);
      expect(JSON.parse((await responseBody.textContent()) ?? '')).toEqual({
        '42': { name: value.name, photo: '' },
      });
      expect(await page.locator('#response-headers').textContent()).toContain('x-total-count: 1');
      expect(await responseBody.locator('img').count()).toBe(0);
      expect(await page.evaluate(() => 'docsXss' in window)).toBe(false);
      expect(await page.locator('#request-curl').textContent()).toContain(`'${preview.href}'`);

      await page.getByLabel('category', { exact: true }).fill('不存在 & Unknown');
      await send.click();
      await finish();
      expect(await responseStatus.textContent()).toStartWith('400 Bad Request');
      expect(await responseBody.textContent()).toContain('availableCategories');

      // Required path parameters block requests, and hidden list filters never leak into other endpoints.
      await endpoint.selectOption('/v1/activity/:activityId');
      const beforeInvalid = dataRequests.length;
      await send.click();
      expect(dataRequests).toHaveLength(beforeInvalid);
      await page.getByLabel('activityId（必填）').fill('00042');
      await send.click();
      await finish();
      expect(dataRequests.at(-1)?.pathname).toBe('/v1/activity/00042');
      expect(dataRequests.at(-1)?.search).toBe('');
      expect(JSON.parse((await responseBody.textContent()) ?? '').id).toBe('42');
      expect(await page.locator('#response-headers').textContent()).toContain('x-cache: HIT');
      await page.getByLabel('activityId（必填）').fill('404');
      await send.click();
      await finish();
      expect(await responseStatus.textContent()).toStartWith('404 Not Found');
      expect(await responseBody.textContent()).toContain('api-fetch-empty');

      for (const path of [
        '/v1/activity/category',
        '/v1/activity/academicYear',
        '/v1/staffs',
        '/health/live',
        '/health/ready',
        '/metrics',
      ]) {
        await endpoint.selectOption(path);
        await send.click();
        await finish();
        expect(dataRequests.at(-1)?.pathname).toBe(path);
        expect(dataRequests.at(-1)?.search).toBe('');
        expect(await responseStatus.textContent()).toStartWith('200 OK');
      }
      expect(await responseBody.textContent()).toContain('# TYPE dsas_http_requests_total counter');

      await endpoint.selectOption('/v1/activity/list');
      await page.getByRole('button', { name: '重置参数' }).click();
      await page.waitForFunction(
        () => !document.querySelector('#request-url')?.textContent?.includes('?'),
      );
      expect(await page.locator('#request-url').textContent()).toBe(
        `http://127.0.0.1:${server.port}/v1/activity/list`,
      );
      expect(await page.getByLabel('isStudentLed', { exact: true }).inputValue()).toBe('');
      await page.getByRole('button', { name: '复制 cURL' }).click();
      await page.waitForFunction(() =>
        Boolean(document.querySelector('#copy-status')?.textContent),
      );

      // Hold one real browser request to exercise cancellation deterministically.
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/v1/activity/list', async (route) => {
        await held;
        await route.abort().catch(() => {});
      });
      await send.click();
      expect(await send.isDisabled()).toBe(true);
      await page.getByRole('button', { name: '取消请求' }).click();
      await finish();
      expect(await responseStatus.textContent()).toContain('请求已取消');
      expect(await send.isEnabled()).toBe(true);
      release?.();
      await page.unrouteAll({ behavior: 'wait' });

      await page.context().setOffline(true);
      await send.click();
      await finish();
      expect(await responseStatus.textContent()).toContain('网络请求失败');
      await page.context().setOffline(false);
      await send.click();
      await finish();
      expect(await responseStatus.textContent()).toStartWith('200 OK');

      await page.setViewportSize({ width: 375, height: 812 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await server.stop(true);
    }
  },
  45000,
);
