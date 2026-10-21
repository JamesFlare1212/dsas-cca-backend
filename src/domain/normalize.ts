import pangu from 'pangu';
import { z } from 'zod';
import type { Activity, StaffDirectory } from './activity';

const staffOptionSchema = z
  .looseObject({
    key: z.string().min(1),
    val: z.string().optional(),
  })
  .readonly();

function fieldKey(id: string): string {
  return id.replace(/[\s_-]/g, '').toLowerCase();
}

export const rawActivityFieldSchema = z
  .looseObject({
    fID: z.string(),
    fData: z.union([z.string(), z.boolean()]).nullish(),
    // Other controls also carry lParms, with control-specific metadata.
    lParms: z.array(z.unknown()).readonly().nullish(),
  })
  .superRefine((field, context) => {
    if (fieldKey(field.fID) !== 'staff' || field.lParms == null) return;
    const options = z.array(staffOptionSchema).safeParse(field.lParms);
    if (!options.success) {
      for (const issue of options.error.issues) {
        context.addIssue({
          code: 'custom',
          message: issue.message,
          path: ['lParms', ...issue.path],
        });
      }
    }
  })
  .readonly();

export const rawActivityRowSchema = z
  .looseObject({
    rID: z.string().min(1).optional(),
    fields: z.array(rawActivityFieldSchema).readonly(),
  })
  .readonly();

export const rawActivitySchema = z.union([
  z
    .looseObject({
      isError: z.literal(false).optional(),
      newRows: z.array(rawActivityRowSchema).readonly(),
    })
    .readonly(),
  // Upstream errors may omit rows. Keep the flag for the transport to classify.
  z
    .looseObject({
      isError: z.literal(true),
      newRows: z.array(rawActivityRowSchema).readonly().optional(),
    })
    .readonly(),
]);

export const RawActivitySchema = rawActivitySchema;
export type RawActivity = z.infer<typeof rawActivitySchema>;
export type RawActivityRow = z.infer<typeof rawActivityRowSchema>;
export type RawActivityField = z.infer<typeof rawActivityFieldSchema>;

export class ActivityNormalizationError extends Error {
  override name = 'ActivityNormalizationError';
}

export function parseRawActivity(value: unknown): RawActivity {
  return rawActivitySchema.parse(value);
}

function successfulRows(raw: RawActivity): readonly RawActivityRow[] {
  // Validate here too: callers can construct RawActivity themselves or pass JS.
  const parsed = parseRawActivity(raw);
  if (parsed.isError === true) {
    throw new ActivityNormalizationError('Cannot normalize an upstream error response');
  }
  return parsed.newRows;
}

function text(value: RawActivityField['fData'], field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ActivityNormalizationError(`Expected text for ${field}`);
  }
  return value;
}

function cleanText(value: string): string {
  return value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/ {2,}/g, ' ');
}

function prose(value: string | null): string {
  return pangu.spaceText(cleanText(value ?? '')).replace(/\n[ \t]+/g, '\n');
}

function cleanName(value: string): string {
  return pangu.spaceText(
    cleanText(value)
      .replaceAll('（', '(')
      .replaceAll('）', ')')
      .replaceAll('’', "'")
      .replaceAll('.', '')
      .replaceAll('IssuesT台上的社会问题', 'Issues T 台上的社会问题')
      .replaceAll('校管弦乐团(新老成员都适用', '校管弦乐团(新老成员都适用)')
      .replace(/\){2,}/g, ')')
      .trim(),
  );
}

function stringList(value: RawActivityField['fData'], field: string): string[] {
  return (text(value, field) ?? '')
    .split(/,\s*|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function booleanValue(
  value: RawActivityField['fData'],
  field: string,
  frequency = false,
): boolean | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on', 'checked', '✓', '✔'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'off', 'unchecked', ''].includes(normalized)) return false;
  if (frequency) return normalized === 'recurring weekly' || normalized === 'weekly';
  throw new ActivityNormalizationError(`Invalid boolean for ${field}`);
}

function parseGrades(schedule: string | null): Activity['grades'] {
  const absent: Activity['grades'] = { min: null, max: null };
  if (!schedule) return absent;
  const grades: number[] = [];
  let family: string | undefined;
  const pattern =
    /(?<![A-Za-z0-9])(KG|G|Grades?|Years?)\s*(\d+)(?![A-Za-z0-9])(?:\s*[-–—−~～至]\s*(?:(KG|G|Grades?|Years?)\s*)?(\d+)(?![A-Za-z0-9]))?/gi;
  for (const match of schedule.matchAll(pattern)) {
    const prefix = match[1];
    const first = match[2];
    if (!prefix || first === undefined || match.index === undefined) return absent;
    const currentFamily = prefix.toUpperCase() === 'KG' ? 'KG' : 'G';
    const endFamily = match[3]?.toUpperCase() === 'KG' ? 'KG' : 'G';
    if ((family && family !== currentFamily) || (match[3] && endFamily !== currentFamily))
      return absent;
    family = currentFamily;
    const min = Number(first);
    const max = Number(match[4] ?? first);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) return absent;
    // Do not silently interpret a broken range (G1-, G1-G) as a single grade.
    if (/^(?:\s*[-–—−~～至]|\.\d)/.test(schedule.slice(match.index + match[0].length)))
      return absent;
    grades.push(min, max);
  }
  return grades.length
    ? { min: String(Math.min(...grades)), max: String(Math.max(...grades)) }
    : absent;
}

function emptyActivity(id: string): Activity {
  return {
    id,
    name: '',
    academicYear: null,
    category: null,
    description: '',
    photo: null,
    duration: { startDate: null, endDate: null, isRecurringWeekly: null },
    grades: { min: null, max: null },
    isPreSignup: null,
    isStudentLed: null,
    materials: [],
    meeting: {
      day: null,
      startTime: null,
      endTime: null,
      location: { block: null, room: null, site: null },
    },
    poorWeatherPlan: '',
    schedule: null,
    semesterCost: '',
    requirements: [],
    staff: [],
    staffForReports: [],
    studentLeaders: [],
  };
}

function applyField(activity: Activity, field: RawActivityField): boolean {
  const value = field.fData;
  switch (fieldKey(field.fID)) {
    case 'academicyear':
      activity.academicYear = text(value, field.fID);
      break;
    case 'schedule':
      activity.schedule = text(value, field.fID);
      break;
    case 'category':
      activity.category = text(value, field.fID);
      break;
    case 'activityname':
    case 'name':
      activity.name = cleanName(text(value, field.fID) ?? '');
      break;
    case 'description':
      activity.description = text(value, field.fID);
      break;
    case 'photo':
      activity.photo = text(value, field.fID);
      break;
    case 'day':
      activity.meeting.day = text(value, field.fID);
      break;
    case 'start':
      activity.meeting.startTime = text(value, field.fID);
      break;
    case 'end':
      activity.meeting.endTime = text(value, field.fID);
      break;
    case 'site':
      activity.meeting.location.site = text(value, field.fID);
      break;
    case 'block':
      activity.meeting.location.block = text(value, field.fID);
      break;
    case 'room':
      activity.meeting.location.room = text(value, field.fID);
      break;
    case 'staff':
      activity.staff = stringList(value, field.fID);
      break;
    case 'staffforreports':
      activity.staffForReports = stringList(value, field.fID);
      break;
    case 'studentleaders':
      activity.studentLeaders = stringList(value, field.fID);
      break;
    case 'materials':
      activity.materials = stringList(value, field.fID);
      break;
    case 'requirements':
      activity.requirements = stringList(value, field.fID);
      break;
    case 'runsfrom':
      activity.duration.startDate = text(value, field.fID);
      break;
    case 'runsto':
      activity.duration.endDate = text(value, field.fID);
      break;
    case 'isrecurringweekly':
    case 'recurringweekly':
    case 'recurrence':
    case 'frequency':
      activity.duration.isRecurringWeekly = booleanValue(value, field.fID, true);
      break;
    case 'ispresignup':
    case 'presignup':
      activity.isPreSignup = booleanValue(value, field.fID);
      break;
    case 'isstudentled':
    case 'studentled':
      activity.isStudentLed = booleanValue(value, field.fID);
      break;
    case 'poorweatherplan':
      activity.poorWeatherPlan = text(value, field.fID);
      break;
    case 'semestercost':
      activity.semesterCost = text(value, field.fID);
      break;
    default:
      return false;
  }
  return true;
}

export function normalizeActivity(raw: RawActivity, requestedId: string): Activity {
  const rows = successfulRows(raw);
  const id = z.string().trim().min(1).parse(requestedId);
  if (rows.length === 0) throw new ActivityNormalizationError(`Activity ${id} is missing`);
  const rowId = rows[0]?.rID?.split(':')[0];
  if (rowId !== undefined && rowId !== id) {
    throw new ActivityNormalizationError(`Activity response ID does not match requested ID ${id}`);
  }
  const activity = emptyActivity(id);
  for (const row of rows) {
    for (let index = 0; index < row.fields.length; index++) {
      const field = row.fields[index];
      if (!field) continue;
      const next = (): RawActivityField['fData'] => {
        const following = row.fields[index + 1];
        if (!following || following.fData === undefined) {
          throw new ActivityNormalizationError(`Missing value after ${String(field.fData)}`);
        }
        return following.fData;
      };
      switch (field.fData) {
        case 'Description':
          activity.description = text(next(), 'Description');
          index++;
          break;
        case 'Name To Appear On Reports':
          activity.staffForReports = stringList(next(), 'Name To Appear On Reports');
          index++;
          break;
        case 'Upload Photo':
          activity.photo = text(next(), 'Upload Photo');
          index++;
          break;
        case 'Poor Weather Plan':
          activity.poorWeatherPlan = text(next(), 'Poor Weather Plan');
          index++;
          break;
        case 'Is Pre Sign-up':
          activity.isPreSignup = booleanValue(next(), 'Is Pre Sign-up');
          index++;
          break;
        case 'Semester Cost':
          activity.semesterCost = text(next(), 'Semester Cost');
          index++;
          break;
        case 'Activity Runs From': {
          const recurrence = row.fields[index + 4];
          if (recurrence)
            activity.duration.isRecurringWeekly = booleanValue(
              recurrence.fData,
              'recurrence',
              true,
            );
          break;
        }
        default:
          if (!applyField(activity, field) && field.fData === 'Recurring Weekly') {
            activity.duration.isRecurringWeekly = true;
          }
          break;
      }
    }
  }
  if (!activity.name) throw new ActivityNormalizationError(`Activity ${id} has no name`);
  activity.description = prose(activity.description);
  activity.poorWeatherPlan = prose(activity.poorWeatherPlan);
  activity.semesterCost = prose(activity.semesterCost);
  activity.isStudentLed ??=
    /student[\s-]led/i.test(activity.name) ||
    activity.name.includes('学生社团') ||
    activity.name.includes('(SL)');
  activity.grades = parseGrades(activity.schedule);
  return activity;
}

const blacklistedStaff = new Set([
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

const correctedStaffNames: Readonly<Record<string, string>> = {
  'Mr TT15 Pri KinLiu TT15 Pri KinLiu': 'Mr Kin Liu',
  'Mr TT13 Yanni Shen TT13 Yanni Shen': 'Mr Yanni Shen',
  'Mr TT19 Pri Saima Salem TT19 Pri Saima Salem': 'Mr Saima Salem',
  'Ms TT Ca(CCA) TT Ma': 'Ms Ca Ma',
  'Mr JackyT JackyT': 'Mr JackyT',
  'Ms TT Ma TT M': 'Ms Ma M',
  'TT01 Fang TT01 Dong': 'Mr Fang Dong',
  'Mr TT18 Shane Rose TT18 Shane Rose': 'Mr Shane Rose',
  'Ms Caroline Malone(id)': 'Ms Caroline Malone',
  'Ms Marina Mao(id)': 'Ms Marina Mao',
  'Mrs Amy Yuan (Lower Secondary Secretary初中部学部助理)': 'Mrs Amy Yuan',
  'Ms Lily Liu (Primary)': 'Ms Lily Liu',
  'Ms Cindy 薛': 'Ms Cindy Xue',
  'Ms SiSi Li': 'Ms Sisi Li',
};

export function normalizeStaff(raw: RawActivity): StaffDirectory {
  const staff = new Map<string, string>();
  for (const row of successfulRows(raw)) {
    for (const field of row.fields) {
      if (fieldKey(field.fID) !== 'staff' || field.lParms == null) continue;
      for (const option of z.array(staffOptionSchema).parse(field.lParms)) {
        if (blacklistedStaff.has(option.key.replace(/^ID:\s*/i, ''))) continue;
        const name = option.val ?? '';
        staff.set(
          option.key,
          Object.hasOwn(correctedStaffNames, name) ? (correctedStaffNames[name] ?? name) : name,
        );
      }
    }
  }
  return Object.fromEntries(staff);
}
