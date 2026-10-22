import { createLogger } from '../src/core/logger.ts';
import type { Activity, StaffDirectory } from '../src/domain/activity.ts';
import type { ActivitySummary, CacheEntry, Lease, Repository } from '../src/storage/repository.ts';

export const silentLogger = createLogger('silent');
export function activity(id = '3350', name = 'Chess Club'): Activity {
  return {
    id,
    name,
    academicYear: '2026/2027',
    category: 'Clubs',
    description: 'A club',
    descriptionZh: null,
    photo: null,
    duration: { startDate: null, endDate: null, isRecurringWeekly: true },
    grades: { min: '3', max: '12' },
    isPreSignup: false,
    isStudentLed: false,
    materials: [],
    meetings: [],
    meeting: {
      day: 'Monday',
      startTime: null,
      endTime: null,
      location: { block: null, room: null, site: null },
    },
    poorWeatherPlan: null,
    schedule: 'G3-12',
    semesterCost: null,
    requirements: [],
    staff: ['T1'],
    staffForReports: [],
    studentLeaders: [],
  };
}
export function rawActivity(id = '3350', name = 'Chess Club') {
  return {
    newRows: [
      {
        rID: `${id}:1:0:0`,
        fields: [
          { fID: 'activityname', fData: name },
          { fID: 'category', fData: 'Clubs' },
          { fID: 'academicyear', fData: '2026/2027' },
        ],
      },
    ],
  };
}

export class MemoryRepository implements Repository {
  readonly activities = new Map<string, CacheEntry<Activity>>();
  readonly due = new Map<string, number>();
  readonly transient = new Map<string, { fetchedAt: string; expiresAt: number }>();
  readonly leases = new Map<string, AbortController>();
  staff: CacheEntry<StaffDirectory> | null = null;
  failure: Error | undefined;
  private check() {
    if (this.failure) throw this.failure;
  }
  async getActivity(id: string) {
    this.check();
    const durable = this.activities.get(id);
    const transient = this.transient.get(id);
    return structuredClone(
      durable ??
        (transient && transient.expiresAt > Date.now()
          ? { value: null, fetchedAt: transient.fetchedAt }
          : null),
    );
  }
  async saveActivity(id: string, entry: CacheEntry<Activity>, after: number) {
    this.check();
    this.activities.set(id, structuredClone(entry));
    this.due.set(id, Date.parse(entry.fetchedAt) + after);
  }
  async hasDurableActivity(id: string) {
    this.check();
    return this.activities.has(id);
  }
  async saveTransientMissing(id: string, fetchedAt: string, ttlMs: number) {
    this.check();
    if (!this.activities.has(id))
      this.transient.set(id, { fetchedAt, expiresAt: Date.now() + ttlMs });
  }
  async listActivitySummaries(): Promise<ActivitySummary[]> {
    this.check();
    return [...this.activities.values()].flatMap((entry) =>
      entry.value
        ? [
            {
              id: entry.value.id,
              name: entry.value.name,
              photo: entry.value.photo,
              category: entry.value.category,
              academicYear: entry.value.academicYear,
              grades: entry.value.grades,
              isStudentLed: entry.value.isStudentLed,
              lastCheck: entry.fetchedAt,
            },
          ]
        : [],
    );
  }
  async getDueActivityIds(before: number, limit: number) {
    this.check();
    return [...this.due]
      .filter(([, at]) => at <= before)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([id]) => id);
  }
  async deferActivity(id: string, retryAt: number) {
    this.check();
    this.due.set(id, retryAt);
  }
  async getStaff() {
    this.check();
    return structuredClone(this.staff);
  }
  async saveStaff(entry: CacheEntry<StaffDirectory>) {
    this.check();
    this.staff = structuredClone(entry);
  }
  async acquireLease(name: string): Promise<Lease | null> {
    this.check();
    if (this.leases.has(name)) return null;
    const controller = new AbortController();
    this.leases.set(name, controller);
    return {
      signal: controller.signal,
      release: async () => {
        controller.abort();
        this.leases.delete(name);
      },
    };
  }
  async ping() {
    this.check();
  }
  async close() {}
}
