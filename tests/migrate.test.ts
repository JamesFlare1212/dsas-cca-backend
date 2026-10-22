import { expect, test } from 'bun:test';
import { decodeLegacyActivity, decodeLegacyStaff } from '../src/storage/migrate.ts';
import { activity } from './helpers.ts';

test('legacy migration keeps public activity data and freshness while removing response metadata', () => {
  const entry = decodeLegacyActivity(
    { ...activity(), lastCheck: '2026-01-01T00:00:00Z', cache: 'HIT' },
    '3350',
  );
  expect(entry?.value).toEqual(activity());
  expect(entry?.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
});
test('migration skips error, missing and mismatched records and strips embedded images', () => {
  expect(decodeLegacyActivity({ error: 'failed' }, '1')).toBeNull();
  expect(decodeLegacyActivity({ source: 'api-fetch-empty' }, '1')).toBeNull();
  expect(decodeLegacyActivity(activity('2'), '1')).toBeNull();
  const entry = decodeLegacyActivity(
    { id: '1', name: 'Chess', photo: 'data:image/png;base64,abc' },
    '1',
  );
  expect(entry?.value?.photo).toBeNull();
  expect(entry?.fetchedAt).toBe(new Date(0).toISOString());
});
test('staff migration removes cache metadata and never retains empty error snapshots', () => {
  expect(
    decodeLegacyStaff({ T1: 'Teacher', cache: 'HIT', lastCheck: '2026-01-01T00:00:00Z' })?.value,
  ).toEqual({ T1: 'Teacher' });
  expect(decodeLegacyStaff({ error: 'failed' })).toBeNull();
  expect(decodeLegacyStaff({ lastCheck: 'old' })).toBeNull();
});

test('migration retains bilingual and multiple-meeting data and defaults old payloads', () => {
  const current = activity();
  current.descriptionZh = '中文描述';
  current.meetings = [{ ...structuredClone(current.meeting), staff: ['T1'] }];
  expect(decodeLegacyActivity(current, current.id)?.value).toEqual(current);
  const { descriptionZh: _zh, meetings: _meetings, ...old } = current;
  expect(decodeLegacyActivity(old, current.id)?.value).toMatchObject({
    descriptionZh: null,
    meetings: [],
    meeting: current.meeting,
  });
});
