import pangu from 'pangu';
import { z } from 'zod';
import type { Activity, Meeting, StaffDirectory } from './activity';

const staffOptionSchema = z
  .looseObject({
    key: z.string().min(1),
    val: z.string().optional(),
  })
  .readonly();

function fieldKey(id: string | null): string {
  return (
    id
      ?.normalize('NFKC')
      .replace(/[\s_:-]/g, '')
      .toLowerCase() ?? ''
  );
}

// Labels identify generic value controls; named data fields remain authoritative.
const labelTargets = new Map(
  Object.entries({
    'Academic Year': 'academicyear',
    'Activity Schedule': 'schedule',
    'Activity Category': 'category',
    'Activity Name': 'activityname',
    Description: 'description',
    'Chinese Description': 'descriptionzh',
    'Name To Appear On Reports': 'staffforreports',
    'Upload Photo': 'photo',
    'Poor Weather Plan': 'poorweatherplan',
    'Is Pre Sign-up': 'ispresignup',
    'Student Led': 'isstudentled',
    'Student Leader Name(s)': 'studentleaders',
    'Semester Cost': 'semestercost',
    'Activity Runs From': 'runsfrom',
    'Activity Runs To': 'runsto',
    Materials: 'materials',
    Requirements: 'requirements',
    中文描述: 'descriptionzh',
    活动名称: 'activityname',
    活动描述: 'description',
    学生主导: 'isstudentled',
    学生负责人: 'studentleaders',
  }).map(([label, target]) => [fieldKey(label), target]),
);
const genericValueIds = new Set(['1', 'value', 'checkbox', 'textarea', 'text', 'input']);
const meetingFieldIds = new Set(['day', 'start', 'end', 'site', 'block', 'room']);
const fieldAliases: Readonly<Record<string, string>> = {
  name: 'activityname',
  chinesedescription: 'descriptionzh',
  presignup: 'ispresignup',
  studentled: 'isstudentled',
};
const namedFieldIds = new Set([
  ...labelTargets.values(),
  ...meetingFieldIds,
  ...Object.keys(fieldAliases),
  'staff',
  'isrecurringweekly',
  'recurringweekly',
  'recurrence',
  'frequency',
  'grade',
  'grades',
  'yeargroup',
  'yeargroups',
]);

function isLabel(field: RawActivityField, target: string, following?: RawActivityField): boolean {
  const id = fieldKey(field.fID);
  if (namedFieldIds.has(id) && (fieldAliases[id] ?? id) !== target) return false;
  return (
    field.fID === null ||
    id === 'label' ||
    id === 'title' ||
    [4, 5, 6].includes(Number(field.fType)) ||
    (id === target && following !== undefined && genericValueIds.has(fieldKey(following.fID)))
  );
}

function isLabelValue(field: RawActivityField, target: string): boolean {
  return (
    fieldKey(field.fID) === target ||
    genericValueIds.has(fieldKey(field.fID)) ||
    (field.fID === null && ![2, 4, 5, 6].includes(Number(field.fType)))
  );
}

export const rawActivityFieldSchema = z
  .looseObject({
    // Engage labels and layout placeholders have null IDs; their adjacent values
    // may use a generic ID, so retain them for label-based normalization.
    fID: z.string().nullable(),
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

function selectText(field: RawActivityField): string | null {
  const value = text(field.fData, field.fID ?? 'selection');
  if (value === null || value === '') return value;
  // Prefer display values, including numeric room names, over ambiguous keys.
  if (
    field.lParms?.some(
      (item) => typeof item === 'object' && item !== null && 'val' in item && item.val === value,
    )
  )
    return value;
  const option = field.lParms?.find(
    (item) => typeof item === 'object' && item !== null && 'key' in item && item.key === value,
  );
  if (typeof option === 'object' && option !== null && 'val' in option) {
    if (typeof option.val === 'string' && option.val.trim()) {
      // Engage's day options refer to localization resources rather than display text.
      return option.val.replace(
        /^dw(?=(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$)/,
        '',
      );
    }
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
  // Engage's own activity UI renders fType 18 as checked when fData is "x".
  if (['true', 'yes', 'y', '1', 'on', 'checked', 'x', '✓', '✔'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'off', 'unchecked', ''].includes(normalized)) return false;
  if (frequency) return normalized === 'recurring weekly' || normalized === 'weekly';
  throw new ActivityNormalizationError(`Invalid boolean for ${field}`);
}

function booleanControlValue(
  field: RawActivityField,
  name: string,
  frequency = false,
): boolean | null {
  // In Engage's fType 18 controls, null is an unchecked box rather than an
  // unspecified value. Keep legacy inference for payloads without that metadata.
  if (field.fType === 18 && field.fData == null) return false;
  return booleanValue(field.fData, name, frequency);
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
    if (currentFamily === 'KG' && (min < 1 || max > 3)) return absent;
    const remainder = schedule.slice(match.index + match[0].length);
    // Complete ranges may be followed by labels such as "KG2-KG3 - Internal".
    const hasLabelSuffix =
      match[4] !== undefined && /^\s+[-–—]\s+(?!(?:KG|G|Grades?|Years?)\b)\p{L}/iu.test(remainder);
    // Do not silently interpret a broken range (G1-, G1-G) as a single grade.
    if (!hasLabelSuffix && /^(?:\s*[-–—−~～至]|\.\d)/.test(remainder)) return absent;
    // Keep kindergarten below G1 on the same scale: KG1=-2, KG2=-1, KG3=0.
    const offset = currentFamily === 'KG' ? 3 : 0;
    grades.push(min - offset, max - offset);
  }
  return grades.length
    ? { min: String(Math.min(...grades)), max: String(Math.max(...grades)) }
    : absent;
}

function emptyMeeting(): Meeting {
  return {
    day: null,
    startTime: null,
    endTime: null,
    location: { block: null, room: null, site: null },
  };
}

function emptyActivity(id: string): Activity {
  return {
    id,
    name: '',
    academicYear: null,
    category: null,
    description: '',
    descriptionZh: null,
    photo: null,
    duration: { startDate: null, endDate: null, isRecurringWeekly: null },
    grades: { min: null, max: null },
    isPreSignup: null,
    isStudentLed: null,
    materials: [],
    meeting: emptyMeeting(),
    meetings: [],
    poorWeatherPlan: '',
    schedule: null,
    semesterCost: '',
    requirements: [],
    staff: [],
    staffForReports: [],
    studentLeaders: [],
  };
}

function applyField(activity: Activity, field: RawActivityField, meetingStaff: string[]): boolean {
  if (field.fID === null) return false;
  const value = field.fData;
  switch (fieldKey(field.fID)) {
    case 'academicyear':
      activity.academicYear = selectText(field);
      break;
    case 'schedule':
      activity.schedule = selectText(field);
      break;
    case 'category':
      activity.category = selectText(field);
      break;
    case 'activityname':
    case 'name':
      activity.name = cleanName(text(value, field.fID) ?? '');
      break;
    case 'description':
      activity.description = text(value, field.fID);
      break;
    case 'descriptionzh':
    case 'chinesedescription':
      activity.descriptionZh = text(value, field.fID);
      break;
    case 'photo':
      activity.photo = text(value, field.fID);
      break;
    case 'day':
      activity.meeting.day = selectText(field);
      break;
    case 'start':
      activity.meeting.startTime = text(value, field.fID);
      break;
    case 'end':
      activity.meeting.endTime = text(value, field.fID);
      break;
    case 'site':
      activity.meeting.location.site = selectText(field);
      break;
    case 'block':
      activity.meeting.location.block = selectText(field);
      break;
    case 'room':
      activity.meeting.location.room = selectText(field);
      break;
    case 'staff':
      meetingStaff.push(...stringList(value, field.fID));
      activity.staff = [...new Set([...activity.staff, ...meetingStaff])];
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
      activity.duration.isRecurringWeekly = booleanControlValue(field, field.fID, true);
      break;
    case 'ispresignup':
    case 'presignup':
      activity.isPreSignup = booleanControlValue(field, field.fID);
      break;
    case 'isstudentled':
    case 'studentled':
      activity.isStudentLed = booleanControlValue(field, field.fID);
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
  let legacyMeeting = activity.meeting;
  const gradeHints: string[] = [];
  for (const row of rows) {
    activity.meeting = emptyMeeting();
    const meetingStaff: string[] = [];
    let hasMeeting = false;
    const apply = (field: RawActivityField): boolean => {
      const key = fieldKey(field.fID);
      if (meetingFieldIds.has(key)) hasMeeting = true;
      if (['grade', 'grades', 'yeargroup', 'yeargroups'].includes(key)) {
        const hint = selectText(field);
        if (hint) gradeHints.push(hint);
      }
      return applyField(activity, field, meetingStaff);
    };
    for (let index = 0; index < row.fields.length; index++) {
      const field = row.fields[index];
      if (!field) continue;
      const following = row.fields[index + 1];
      const target =
        typeof field.fData === 'string' ? labelTargets.get(fieldKey(field.fData)) : undefined;
      if (target && isLabel(field, target, following)) {
        if (!following || following.fData === undefined) {
          throw new ActivityNormalizationError(`Missing value after ${String(field.fData)}`);
        }
        if (isLabelValue(following, target)) {
          apply({ ...following, fID: target });
          index++;
          continue;
        }
      }
      if (apply(field)) continue;
      const recurrence = typeof field.fData === 'string' ? fieldKey(field.fData) : '';
      if (['recurringweekly', 'weekly', 'recurringtwoweekly'].includes(recurrence)) {
        if (following?.fType === 18) {
          const checked = booleanControlValue(following, 'recurrence');
          activity.duration.isRecurringWeekly =
            recurrence === 'recurringtwoweekly' ? false : checked;
          index++;
        } else activity.duration.isRecurringWeekly = recurrence !== 'recurringtwoweekly';
      }
    }
    if (hasMeeting) {
      activity.meetings.push({ ...activity.meeting, staff: [...new Set(meetingStaff)] });
      // Preserve the existing singular field for clients that have not adopted meetings.
      legacyMeeting = structuredClone(activity.meeting);
    }
  }
  activity.meeting = legacyMeeting;
  if (!activity.name) throw new ActivityNormalizationError(`Activity ${id} has no name`);
  activity.description = prose(activity.description);
  activity.descriptionZh = activity.descriptionZh === null ? null : prose(activity.descriptionZh);
  if (!activity.description.trim() && activity.descriptionZh)
    activity.description = activity.descriptionZh;
  activity.poorWeatherPlan = prose(activity.poorWeatherPlan);
  activity.semesterCost = prose(activity.semesterCost);
  activity.isStudentLed ??=
    /student[\s-]led/i.test(activity.name) ||
    activity.name.includes('学生社团') ||
    activity.name.includes('(SL)');
  activity.grades = parseGrades(activity.schedule);
  // Use explicit grade hints only when the schedule has no grade constraint.
  // Never replace a broken schedule range with a guess from a title or year.
  if (
    activity.grades.min === null &&
    !/(?:^|[^A-Za-z0-9])(?:KG|G|Grades?|Years?)\s*\d/i.test(activity.schedule ?? '')
  ) {
    for (const hint of [...gradeHints, activity.name]) {
      const grades = parseGrades(hint);
      if (grades.min !== null) {
        activity.grades = grades;
        break;
      }
    }
  }
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
