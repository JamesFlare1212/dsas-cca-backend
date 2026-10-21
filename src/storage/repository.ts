import type { Activity, StaffDirectory } from '../domain/activity.ts';

export interface CacheEntry<T> {
  value: T | null;
  fetchedAt: string;
}

export interface ActivitySummary {
  id: string;
  name: string;
  photo: string | null;
  category: string | null;
  academicYear: string | null;
  grades: { min: string | null; max: string | null };
  isStudentLed: boolean | null;
  lastCheck: string;
}

export interface Lease {
  readonly signal: AbortSignal;
  release(): Promise<void>;
}

export interface Repository {
  getActivity(id: string): Promise<CacheEntry<Activity> | null>;
  hasDurableActivity(id: string): Promise<boolean>;
  saveActivity(id: string, entry: CacheEntry<Activity>, refreshAfterMs: number): Promise<void>;
  saveTransientMissing(id: string, fetchedAt: string, ttlMs: number): Promise<void>;
  listActivitySummaries(): Promise<ActivitySummary[]>;
  getDueActivityIds(before: number, limit: number): Promise<string[]>;
  deferActivity(id: string, retryAt: number): Promise<void>;
  getStaff(): Promise<CacheEntry<StaffDirectory> | null>;
  saveStaff(entry: CacheEntry<StaffDirectory>): Promise<void>;
  acquireLease(name: string, ttlMs: number): Promise<Lease | null>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
