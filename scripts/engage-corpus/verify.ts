import { isDeepStrictEqual } from 'node:util';
import pangu from 'pangu';
import { createLogger } from '../../src/core/logger.ts';
import type { Activity, StaffDirectory } from '../../src/domain/activity.ts';
import {
  ActivityNormalizationError,
  normalizeActivity,
  normalizeStaff,
} from '../../src/domain/normalize.ts';
import { activityEntrySchema } from '../../src/storage/redis.ts';
import { EngageClient } from '../../src/upstream/client.ts';
import { hash } from './io.ts';
import type { Expected, HttpInput } from './model.ts';
import { reviewedStaffAliases } from './reviewed-staff-aliases.ts';

const logger = createLogger('silent');
// Format only the source expectation. Formatting the actual output too would
// hide a parser that removes word boundaries, line breaks or punctuation.
const prose = (value: string | null) =>
  value === null
    ? null
    : pangu
        .spaceText(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/ {2,}/g, ' '))
        .replace(/\n[ \t]+/g, '\n');
function formattedExpectation(activity: Activity) {
  return {
    ...activity,
    name: pangu.spaceText(
      activity.name
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/ {2,}/g, ' ')
        .replaceAll('（', '(')
        .replaceAll('）', ')')
        .replaceAll('’', "'")
        .replaceAll('.', '')
        .replaceAll('IssuesT台上的社会问题', 'Issues T 台上的社会问题')
        .replaceAll('校管弦乐团(新老成员都适用', '校管弦乐团(新老成员都适用)')
        .replace(/\){2,}/g, ')')
        .trim(),
    ),
    description: prose(activity.description),
    descriptionZh: prose(activity.descriptionZh),
    poorWeatherPlan: prose(activity.poorWeatherPlan),
    semesterCost: prose(activity.semesterCost),
  };
}
export function differences(
  actual: Activity,
  directory: StaffDirectory,
  expected: Extract<Expected, { kind: 'activity' }>,
  compareDirectoryNames = true,
): string[] {
  const errors: string[] = [];
  if (!isDeepStrictEqual(Object.keys(actual).sort(), Object.keys(expected.activity).sort()))
    errors.push('activity.keys');
  const right = formattedExpectation(expected.activity);
  for (const key of Object.keys(right) as (keyof Activity)[]) {
    if (!isDeepStrictEqual(actual[key], right[key])) errors.push(`activity.${key}`);
  }
  if (
    !isDeepStrictEqual(Object.keys(directory).sort(), Object.keys(expected.staffDirectory).sort())
  )
    errors.push('staffDirectory.keys');
  // Raw names must match literally or a frozen, independently reviewed alias digest.
  // Clean fixtures have synthetic names and are always compared literally.
  const directoryValuesMatch = compareDirectoryNames
    ? isDeepStrictEqual(directory, expected.staffDirectory)
    : Object.entries(expected.staffDirectory).every(
        ([key, name]) =>
          hash(directory[key] ?? '') === (reviewedStaffAliases.get(hash(name)) ?? hash(name)),
      );
  if (!directoryValuesMatch) errors.push('staffDirectory.values');
  const cached = activityEntrySchema.parse(
    JSON.parse(JSON.stringify({ value: actual, fetchedAt: '2026-10-22T00:00:00Z' })),
  );
  if (!isDeepStrictEqual(cached.value, actual)) errors.push('cache.roundtrip');
  return errors;
}

export async function verifyCase(
  input: HttpInput,
  expected: Expected,
  compareDirectoryNames = true,
): Promise<void> {
  let refreshes = 0,
    posts = 0;
  const client = new EngageClient(
    {
      baseUrl: 'https://engage.invalid',
      requestTimeoutMs: 25000,
      maxRetries: 0,
      retryDelayMs: 0,
      maxResponseBytes: 20000000,
    },
    {
      getCookies: async () => 'fixture=offline',
      refreshCookies: async () => {
        refreshes++;
        return 'fixture=refreshed';
      },
    },
    logger,
    (async (_url, init) => {
      if (init?.method === 'GET') return new Response('', { status: 500 });
      if (init?.method !== 'POST' || JSON.parse(String(init.body)).activityID !== String(input.id))
        throw new Error('Fixture request ID mismatch');
      posts++;
      return new Response(input.body, {
        status: input.status,
        statusText: input.statusText,
        headers: input.headers,
      });
    }) as typeof fetch,
  );
  let raw: Awaited<ReturnType<EngageClient['fetchActivity']>>;
  try {
    raw = await client.fetchActivity(String(input.id));
  } catch (error) {
    if (
      expected.kind !== 'upstream-error' ||
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== expected.code ||
      !('status' in error) ||
      error.status !== expected.status
    ) {
      throw new Error(`ID ${input.id}: unexpected transport classification`);
    }
    if (posts !== 1 || refreshes !== 0)
      throw new Error(`ID ${input.id}: outage retried or refreshed authentication`);
    return;
  }
  if (refreshes !== 0 || posts !== 1)
    throw new Error(`ID ${input.id}: unexpected authentication/request count`);
  if (expected.kind === 'missing') {
    if (raw !== null) throw new Error(`ID ${input.id}: expected missing`);
    return;
  }
  if (raw === null) throw new Error(`ID ${input.id}: wrongly classified as missing`);
  if (expected.kind === 'empty-form') {
    try {
      normalizeActivity(raw, String(input.id));
    } catch (error) {
      if (error instanceof ActivityNormalizationError) return;
      throw error;
    }
    throw new Error(`ID ${input.id}: empty form accepted as an activity`);
  }
  if (expected.kind !== 'activity') throw new Error(`ID ${input.id}: upstream error accepted`);
  const errors = differences(
    normalizeActivity(raw, String(input.id)),
    normalizeStaff(raw),
    expected,
    compareDirectoryNames,
  );
  if (errors.length) throw new Error(`ID ${input.id}: ${errors.join(', ')}`);
}
