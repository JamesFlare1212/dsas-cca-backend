import { z } from 'zod';
import type { Activity, StaffDirectory } from '../domain/activity.ts';
import type { CacheEntry } from './repository.ts';

const nullableText = z.string().nullable().default(null);
const list = z
  .array(z.unknown())
  .default([])
  .transform((values) => values.filter((value): value is string => typeof value === 'string'));
const legacyActivity = z.object({
  id: z.string().regex(/^\d{1,9}$/),
  name: z.string().min(1),
  academicYear: nullableText,
  category: nullableText,
  description: nullableText,
  descriptionZh: nullableText,
  photo: nullableText,
  duration: z
    .object({
      startDate: nullableText,
      endDate: nullableText,
      isRecurringWeekly: z.boolean().nullable().default(null),
    })
    .default({ startDate: null, endDate: null, isRecurringWeekly: null }),
  grades: z.object({ min: nullableText, max: nullableText }).default({ min: null, max: null }),
  isPreSignup: z.boolean().nullable().default(null),
  isStudentLed: z.boolean().nullable().default(null),
  materials: list,
  meeting: z
    .object({
      day: nullableText,
      startTime: nullableText,
      endTime: nullableText,
      location: z
        .object({ block: nullableText, room: nullableText, site: nullableText })
        .default({ block: null, room: null, site: null }),
    })
    .default({
      day: null,
      startTime: null,
      endTime: null,
      location: { block: null, room: null, site: null },
    }),
  poorWeatherPlan: nullableText,
  meetings: z
    .array(
      z.object({
        day: nullableText,
        startTime: nullableText,
        endTime: nullableText,
        location: z
          .object({ block: nullableText, room: nullableText, site: nullableText })
          .default({ block: null, room: null, site: null }),
        staff: list,
      }),
    )
    .default([]),
  schedule: nullableText,
  semesterCost: nullableText,
  requirements: list,
  staff: list,
  staffForReports: list,
  studentLeaders: list,
});

function validTimestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeLegacyActivity(value: unknown, id: string): CacheEntry<Activity> | null {
  if (!record(value) || value.error || value.source === 'api-fetch-empty') return null;
  const parsed = legacyActivity.safeParse({ ...value, id: value.id ?? id });
  if (!parsed.success || parsed.data.id !== id) return null;
  const activity = parsed.data;
  // Old deployments sometimes stored entire base64 images in Redis.
  if (activity.photo && /^data:/i.test(activity.photo)) activity.photo = null;
  return { value: activity, fetchedAt: validTimestamp(value.lastCheck) };
}

export function decodeLegacyStaff(value: unknown): CacheEntry<StaffDirectory> | null {
  if (!record(value) || value.error) return null;
  const entries = Object.entries(value).filter(
    ([key, item]) =>
      !['lastCheck', 'cache', 'source', 'error'].includes(key) && typeof item === 'string',
  );
  if (entries.length === 0) return null;
  return {
    value: Object.fromEntries(entries) as StaffDirectory,
    fetchedAt: validTimestamp(value.lastCheck),
  };
}
