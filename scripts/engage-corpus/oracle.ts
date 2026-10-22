// A source-control reference, deliberately independent of normalize.ts and its rules.
// It reads named controls and row captions, not parser output or parser snapshots.
import type { Activity, ActivityMeeting } from '../../src/domain/activity.ts';
import type { Expected, HttpInput, SourceBody, SourceField, SourceRow } from './model.ts';

export const excludedStaff = new Set([
  'CL1-827',
  'CL1-831',
  'CL1-832',
  'CL1-834',
  'CL1-835',
  'CL1-836',
  'CL1-838',
  'CL1-842',
  'CL1-843',
  'CL1-844',
  'CL1-845',
  'CL1-846',
]);
export const captions: Record<string, string> = {
  Description: 'description',
  'Chinese Description': 'descriptionZh',
  'Upload Photo': 'photo',
  'Name To Appear On Reports': 'staffForReports',
  'Is Pre Sign-up': 'isPreSignup',
  'Student Led': 'isStudentLed',
  'Student Leader Name(s)': 'studentLeaders',
  'Semester Cost': 'semesterCost',
  'Poor Weather Plan': 'poorWeatherPlan',
};
const reviewedControls = new Set([
  'academicyear',
  'schedule',
  'yeargroup',
  'category',
  'activityname',
  'description',
  'descriptionzh',
  'photo',
  'day',
  'start',
  'end',
  'site',
  'block',
  'room',
  'staff',
  'registerlink',
  'linkedperiod',
  'runsfrom',
  'runsto',
  'materials',
  'requirements',
  ...Object.values(captions).map((value) => value.toLowerCase()),
  'close',
  'previewactivity',
]);
// These are the business templates observed in the private captures and checked
// against Engage's template type definitions. New/renamed templates need review.
const reviewedTemplates: Record<string, readonly string[]> = {
  '0': ['Activity Schedule'],
  '2': ['Activity Category'],
  '3': ['Activity Name'],
  '4': [], // The portal numbers repeated "Activity Place And Time" row captions.
  '5': ['Name To Appear On Reports'],
  '11': ['Description'],
  '12': ['Activity Runs From'],
  '14': ['Upload Photo'],
  '15': ['Is Pre Sign-up'],
  '17': ['Chinese Description', 'Student Leader Name(s)', 'Semester Cost', 'Poor Weather Plan'],
  '20': ['Student Led'],
};
function requireReviewedControls(source: SourceBody): void {
  for (const row of source.newRows) {
    if ('isDeleted' in row && row.isDeleted === true)
      throw new Error('Unreviewed deleted source row');
    const parts = row.rID.split(':');
    const type = parts.length >= 4 ? parts[2] : undefined;
    const caption = sourceCaption(row);
    if (type !== undefined) {
      const titles = Object.hasOwn(reviewedTemplates, type) ? reviewedTemplates[type] : undefined;
      if (
        !titles ||
        (type === '4'
          ? !/^Activity Place And Time \d+$/.test(caption ?? '')
          : !titles.includes(caption ?? ''))
      )
        throw new Error(`Unreviewed business template type ${type} or caption`);
    }
    for (const field of row.fields) {
      if (!field.fID || field.fData == null || field.fData === '') continue;
      if (field.fID === '1') {
        if (!caption || !Object.hasOwn(captions, caption))
          throw new Error('Unreviewed generic business value control');
      } else if (!reviewedControls.has(field.fID.toLowerCase())) {
        throw new Error('Unreviewed named business control');
      }
    }
  }
}
export function decodeSource(input: HttpInput): SourceBody {
  const envelope: unknown = JSON.parse(input.body);
  if (!envelope || typeof envelope !== 'object' || !('d' in envelope))
    throw new Error('No ASP.NET envelope');
  const decoded = typeof envelope.d === 'string' ? JSON.parse(envelope.d) : envelope.d;
  if (!decoded || typeof decoded !== 'object' || !Array.isArray(decoded.newRows))
    throw new Error('Unknown source body');
  for (const row of decoded.newRows) {
    if (!row || typeof row.rID !== 'string' || !Array.isArray(row.fields))
      throw new Error('Unknown source row');
    for (const field of row.fields) {
      if (!field || !(typeof field.fID === 'string' || field.fID === null))
        throw new Error('Unknown source control');
    }
  }
  return decoded as SourceBody;
}
export function sourceText(field?: SourceField): string | null {
  if (field?.fData == null) return null;
  if (typeof field.fData !== 'string') throw new Error('Text control contains non-text');
  return field.fData;
}
export function sourceCaption(row: SourceRow): string | null {
  const field = row.fields[0];
  return field?.fID === null ? sourceText(field) : null;
}
export const sourceList = (value: string | null): string[] =>
  (value ?? '')
    .split(/,\s*|\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

function selection(field?: SourceField): string | null {
  const value = sourceText(field);
  if (!value || field?.lParms?.some((option) => option.val === value)) return value;
  const option = field?.lParms?.find((item) => item.key === value);
  if (!option?.val) return value;
  return /^dw(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(option.val)
    ? option.val.slice(2)
    : option.val;
}
function checked(field?: SourceField): boolean | null {
  if (field?.fData == null) return field?.fType === 18 ? false : null;
  if (typeof field.fData === 'boolean') return field.fData;
  const value = field.fData.trim().toLowerCase();
  if (['x', 'true', 'yes', 'y', '1', 'on', 'checked', '✓', '✔'].includes(value)) return true;
  if (['', 'false', 'no', 'n', '0', 'off', 'unchecked'].includes(value)) return false;
  throw new Error('Unknown checkbox encoding');
}

// The reference scans explicit grade tokens and rejects conflicting/unfinished ranges.
export function referenceGrades(value: string | null): Activity['grades'] {
  const unknown = { min: null, max: null };
  if (!value) return unknown;
  const tokens = [
    ...value.matchAll(/(?<![A-Za-z0-9])(KG|G|Grades?|Years?)\s*(\d+)(?![A-Za-z0-9])/gi),
  ];
  if (!tokens.length) return unknown;
  const numbers: number[] = [];
  let family = '';
  let consumedThrough = 0;
  for (const token of tokens) {
    const position = token.index ?? 0;
    if (position < consumedThrough) continue;
    const current = token[1]?.toUpperCase() === 'KG' ? 'KG' : 'G';
    if (family && family !== current) return unknown;
    family = current;
    const tailStart = position + token[0].length;
    const tail = value.slice(tailStart);
    const range = /^\s*[-–—−~～至]\s*(?:(KG|G|Grades?|Years?)\s*)?(\d+)(?![A-Za-z0-9])/i.exec(tail);
    if (range?.[1] && (range[1].toUpperCase() === 'KG' ? 'KG' : 'G') !== current) return unknown;
    const first = Number(token[2]),
      last = Number(range?.[2] ?? token[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) return unknown;
    if (current === 'KG' && (first < 1 || last > 3)) return unknown;
    consumedThrough = tailStart + (range?.[0].length ?? 0);
    const rest = value.slice(consumedThrough);
    if (/^\s*[-–—−~～至]/.test(rest)) {
      const label = /^\s+[-–—]\s+(\p{L}+)/u.exec(rest);
      if (!range || !label || /^(?:KG|G|Grades?|Years?)$/i.test(label[1] ?? '')) return unknown;
    }
    if (/^\.\d/.test(rest)) return unknown;
    numbers.push(current === 'KG' ? first - 3 : first, current === 'KG' ? last - 3 : last);
  }
  return { min: String(Math.min(...numbers)), max: String(Math.max(...numbers)) };
}

export function deriveExpected(input: HttpInput): Expected {
  if (input.status === 404) return { kind: 'missing' };
  if (input.status >= 500)
    return {
      kind: 'upstream-error',
      code: 'UPSTREAM_UNAVAILABLE',
      status: 503,
      sourceMessage: `HTTP ${input.status}`,
    };
  if (input.status !== 200) throw new Error(`Unreviewed HTTP status ${input.status}`);
  const source = decodeSource(input);
  if (source.isError === true) {
    const errors = source.newRows
      .filter((row) => row.rID === 'errorblock')
      .flatMap((row) =>
        row.fields.filter((field) => field.fID === 'error').map((field) => sourceText(field)),
      );
    if (errors.length !== 1 || errors[0] !== 'Sequence contains no elements')
      throw new Error('Unreviewed upstream business error');
    return {
      kind: 'upstream-error',
      code: 'UPSTREAM_UNAVAILABLE',
      status: 503,
      sourceMessage: errors[0],
    };
  }
  const named = new Map<string, SourceField>();
  const byCaption = new Map<string, SourceField>();
  for (const row of source.newRows) {
    if (row.rID.split(':')[0] !== String(input.id)) throw new Error('Source row ID mismatch');
    for (const field of row.fields) if (field.fID) named.set(field.fID.toLowerCase(), field);
    const caption = sourceCaption(row);
    const target = caption && Object.hasOwn(captions, caption) ? captions[caption] : undefined;
    if (target) {
      const value = row.fields[1];
      if (!value) throw new Error('Caption has no value control');
      byCaption.set(target, value);
    }
  }
  const name = sourceText(named.get('activityname'));
  if (input.id === 0 && !name?.trim()) return { kind: 'empty-form' };
  if (!name?.trim()) throw new Error('Unreviewed nameless activity');
  requireReviewedControls(source);
  const field = (key: string) => byCaption.get(key) ?? named.get(key.toLowerCase());
  const text = (key: string) => sourceText(field(key));
  const meetings: ActivityMeeting[] = [];
  const allStaff: string[] = [];
  const directory = new Map<string, string>();
  for (const row of source.newRows) {
    const controls = new Map(row.fields.filter((x) => x.fID).map((x) => [x.fID?.toLowerCase(), x]));
    const staff = sourceList(sourceText(controls.get('staff')));
    allStaff.push(...staff);
    for (const option of controls.get('staff')?.lParms ?? []) {
      if (
        typeof option.key !== 'string' ||
        (option.val !== undefined && typeof option.val !== 'string')
      )
        throw new Error('Unreviewed staff option');
      if (!excludedStaff.has(option.key.replace(/^ID:\s*/i, '')))
        directory.set(option.key, option.val ?? '');
    }
    if (controls.has('day'))
      meetings.push({
        day: selection(controls.get('day')),
        startTime: sourceText(controls.get('start')),
        endTime: sourceText(controls.get('end')),
        location: {
          site: selection(controls.get('site')),
          block: selection(controls.get('block')),
          room: selection(controls.get('room')),
        },
        staff: [...new Set(staff)],
      });
  }
  const last = meetings.at(-1);
  const meeting = last
    ? {
        day: last.day,
        startTime: last.startTime,
        endTime: last.endTime,
        location: { ...last.location },
      }
    : {
        day: null,
        startTime: null,
        endTime: null,
        location: { site: null, block: null, room: null },
      };
  const schedule = selection(named.get('schedule'));
  let grades = referenceGrades(schedule);
  if (
    grades.min === null &&
    !/(?:^|[^A-Za-z0-9])(?:KG|G|Grades?|Years?)\s*\d/i.test(schedule ?? '')
  ) {
    for (const hint of [selection(named.get('yeargroup')), name]) {
      const candidate = referenceGrades(hint);
      if (candidate.min !== null) {
        grades = candidate;
        break;
      }
    }
  }
  const weekly = source.newRows
    .flatMap((row) => row.fields)
    .filter(
      (x) => x.fID === null && /^(?:Recurring Weekly|Recurring Two-Weekly)$/.test(String(x.fData)),
    )
    .at(-1);
  const english = text('description') ?? '',
    chinese = text('descriptionZh');
  return {
    kind: 'activity',
    staffDirectory: Object.fromEntries(directory),
    activity: {
      id: String(input.id),
      name,
      academicYear: selection(named.get('academicyear')),
      category: selection(named.get('category')),
      schedule,
      grades,
      description: english.trim() ? english : (chinese ?? ''),
      descriptionZh: chinese,
      photo: text('photo'),
      duration: {
        startDate: text('runsfrom'),
        endDate: text('runsto'),
        isRecurringWeekly: weekly ? weekly.fData === 'Recurring Weekly' : null,
      },
      isPreSignup: checked(field('isPreSignup')),
      isStudentLed:
        checked(field('isStudentLed')) ?? /student[\s-]led|学生社团|[（(]SL[）)]/i.test(name),
      materials: sourceList(text('materials')),
      meeting,
      meetings,
      poorWeatherPlan: text('poorWeatherPlan') ?? '',
      semesterCost: text('semesterCost') ?? '',
      requirements: sourceList(text('requirements')),
      staff: [...new Set(allStaff)],
      staffForReports: sourceList(text('staffForReports')),
      studentLeaders: sourceList(text('studentLeaders')),
    },
  };
}
