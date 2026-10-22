import { describe, expect, test } from 'bun:test';
import { ZodError } from 'zod';
import type { Activity, StaffDirectory } from '../src/domain/activity';
import {
  ActivityNormalizationError,
  normalizeActivity,
  normalizeStaff,
  parseRawActivity,
  type RawActivity,
  type RawActivityField,
  rawActivitySchema,
} from '../src/domain/normalize';

function fixture(fields: readonly RawActivityField[] = [], name = 'Chess'): RawActivity {
  return parseRawActivity({
    newRows: [{ rID: '42:1:0:0', fields: [{ fID: 'activityname', fData: name }, ...fields] }],
  });
}

function activity(fields: readonly RawActivityField[] = [], name?: string): Activity {
  return normalizeActivity(fixture(fields, name), '42');
}

function staffFixture(
  options: readonly { readonly key: string; readonly val?: string }[],
): RawActivity {
  return fixture([{ fID: 'staff', lParms: options }]);
}

describe('activity normalization', () => {
  test('returns every public property with legacy empty defaults and no response metadata', () => {
    expect(activity()).toEqual({
      id: '42',
      name: 'Chess',
      academicYear: null,
      category: null,
      description: '',
      descriptionZh: null,
      photo: null,
      duration: { startDate: null, endDate: null, isRecurringWeekly: null },
      grades: { min: null, max: null },
      isPreSignup: null,
      isStudentLed: false,
      materials: [],
      meetings: [],
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
    });
    expect(activity()).not.toHaveProperty('cache');
    expect(activity()).not.toHaveProperty('lastCheck');
  });

  test('maps direct fields and legacy adjacent label/value controls', () => {
    const result = activity([
      { fID: 'academicyear', fData: '2026/27' },
      { fID: 'schedule', fData: 'Monday G1-G5' },
      { fID: 'category', fData: 'Sport' },
      { fID: 'day', fData: 'Monday' },
      { fID: 'start', fData: '15:30' },
      { fID: 'end', fData: '16:30' },
      { fID: 'site', fData: 'Main' },
      { fID: 'block', fData: 'B' },
      { fID: 'room', fData: '201' },
      { fID: 'staff', fData: 'S1, S2,S3' },
      { fID: 'label', fData: 'Description' },
      { fID: 'value', fData: 'We  play<br/> 每周play' },
      { fID: 'label', fData: 'Name To Appear On Reports' },
      { fID: 'value', fData: 'S2, S3' },
      { fID: 'label', fData: 'Upload Photo' },
      { fID: 'value', fData: 'photo.jpg' },
      { fID: 'label', fData: 'Poor Weather Plan' },
      { fID: 'value', fData: 'Indoor<br />  室内play' },
      { fID: 'label', fData: 'Is Pre Sign-up' },
      { fID: 'value', fData: 'false' },
      { fID: 'label', fData: 'Semester Cost' },
      { fID: 'value', fData: '人民币10元' },
      { fID: 'label', fData: 'Activity Runs From' },
      { fID: 'runsfrom', fData: '2026-10-01' },
      { fID: 'label', fData: 'Activity Runs To' },
      { fID: 'runsto', fData: '2027-01-01' },
      { fID: 'frequency', fData: 'Recurring Weekly' },
      { fID: 'materials', fData: 'Board, Pieces' },
      { fID: 'requirements', fData: 'Shoes\nWater' },
      { fID: 'studentleaders', fData: 'L1, L2' },
    ]);
    expect(result).toMatchObject({
      academicYear: '2026/27',
      category: 'Sport',
      schedule: 'Monday G1-G5',
      description: 'We play\n每周 play',
      photo: 'photo.jpg',
      meeting: {
        day: 'Monday',
        startTime: '15:30',
        endTime: '16:30',
        location: { site: 'Main', block: 'B', room: '201' },
      },
      duration: { startDate: '2026-10-01', endDate: '2027-01-01', isRecurringWeekly: true },
      grades: { min: '1', max: '5' },
      isPreSignup: false,
      poorWeatherPlan: 'Indoor\n室内 play',
      semesterCost: '人民币 10 元',
      staff: ['S1', 'S2', 'S3'],
      staffForReports: ['S2', 'S3'],
      materials: ['Board', 'Pieces'],
      requirements: ['Shoes', 'Water'],
      studentLeaders: ['L1', 'L2'],
    });
  });

  test('recognizes legacy labels even when a control has a direct field ID', () => {
    const result = activity([
      { fID: 'description', fData: 'Description' },
      { fID: 'textarea', fData: 'Actual description' },
      { fID: 'ispresignup', fData: 'Is Pre Sign-up' },
      { fID: 'checkbox', fData: false },
      { fID: 'poorweatherplan', fData: 'Poor Weather Plan' },
      { fID: 'textarea', fData: null },
    ]);
    expect(result.description).toBe('Actual description');
    expect(result.isPreSignup).toBe(false);
    expect(result.poorWeatherPlan).toBe('');
  });

  test('parses Engage null-ID labels, numeric value controls and layout placeholders', () => {
    // Reduced live-response structure; all activity and directory values are synthetic.
    const raw = fixture([
      { fID: null, fData: 'Activity Schedule' },
      { fID: 'academicyear', fData: '2026/2027' },
      { fID: 'schedule', fData: 'Monday G7-G9' },
      { fID: null, fData: 'Day' },
      { fID: 'day', fData: 'Monday' },
      { fID: null, fData: 'Staff' },
      { fID: 'staff', fData: 'S1', lParms: [{ key: 'S1', val: 'Example Teacher' }] },
      { fID: null, fData: null, fType: 0 },
      { fID: null, fData: 'Description' },
      { fID: '1', fData: 'Play chess' },
      { fID: null, fData: 'Upload Photo' },
      { fID: '1', fData: 'https://example.org/chess.png' },
      { fID: null, fData: 'Name To Appear On Reports' },
      { fID: '1', fData: 'Example Teacher' },
      { fID: null, fData: 'Is Pre Sign-up' },
      { fID: '1', fData: '' },
      { fID: null, fData: 'Student Led' },
      { fID: '1', fData: 'Yes' },
      { fID: null, fData: 'Student Leader Name(s)' },
      { fID: '1', fData: 'Example Leader, Another Leader' },
      { fID: null, fData: 'Semester Cost' },
      { fID: '1', fData: 'Free' },
      { fID: null, fData: 'Poor Weather Plan' },
      { fID: '1', fData: 'Indoors' },
      { fID: null, fData: 'Activity Runs From' },
      { fID: 'runsfrom', fData: '01/09/2026' },
      { fID: null, fData: 'To' },
      { fID: 'runsto', fData: '18/12/2026' },
      { fID: null, fData: 'Recurring Weekly' },
      { fID: null, fData: null, fType: 0 },
    ]);
    const before = JSON.stringify(raw);
    expect(normalizeActivity(raw, '42')).toMatchObject({
      name: 'Chess',
      academicYear: '2026/2027',
      grades: { min: '7', max: '9' },
      description: 'Play chess',
      photo: 'https://example.org/chess.png',
      meeting: { day: 'Monday' },
      staff: ['S1'],
      staffForReports: ['Example Teacher'],
      isPreSignup: false,
      isStudentLed: true,
      studentLeaders: ['Example Leader', 'Another Leader'],
      semesterCost: 'Free',
      poorWeatherPlan: 'Indoors',
      duration: { startDate: '01/09/2026', endDate: '18/12/2026', isRecurringWeekly: true },
    });
    expect(normalizeStaff(raw)).toEqual({ S1: 'Example Teacher' });
    expect(JSON.stringify(raw)).toBe(before);
  });

  test.each([
    ['No', false],
    ['', false],
    [null, true],
  ] as const)('preserves Student Led label value %s before name inference', (value, expected) => {
    expect(
      activity(
        [
          { fID: null, fData: 'Student Led' },
          { fID: '1', fData: value },
        ],
        'Chess (SL)',
      ).isStudentLed,
    ).toBe(expected);
  });

  test('treats explicit empty Engage checkboxes as unchecked before name inference', () => {
    const result = activity(
      [
        { fID: null, fData: 'Student Led' },
        { fID: '1', fType: 18, fData: null },
        { fID: null, fData: 'Is Pre Sign-up' },
        { fID: '1', fType: 18, fData: null },
        { fID: 'isrecurringweekly', fType: 18, fData: null },
      ],
      'Chess (SL)',
    );
    expect(result.isStudentLed).toBe(false);
    expect(result.isPreSignup).toBe(false);
    expect(result.duration.isRecurringWeekly).toBe(false);
    expect(
      activity([{ fID: 'isstudentled', fType: 18, fData: null }], 'Chess (SL)').isStudentLed,
    ).toBe(false);
    expect(activity([{ fID: 'ispresignup', fType: 18, fData: null }]).isPreSignup).toBe(false);
    expect(
      activity([
        { fID: null, fData: 'Student Led' },
        { fID: '1', fType: 18, fData: 'x' },
      ]).isStudentLed,
    ).toBe(true);
  });

  test.each([
    ['SLAM', false],
    ['SLAM Chess', false],
    ['Chess (SL)', true],
    ['Chess（SL）', true],
    ['Student-led Chess', true],
    ['学生社团 Chess', true],
    ['Chess', false],
  ] as const)('classifies %s as student-led=%s', (name, expected) => {
    expect(activity([], name).isStudentLed).toBe(expected);
  });

  test.each([
    [false, false],
    ['false', false],
    ['FALSE', false],
    ['No', false],
    ['0', false],
    ['', false],
    [true, true],
    ['true', true],
    ['Yes', true],
    ['1', true],
    ['x', true],
    ['X', true],
  ] as const)('preserves explicit pre-signup value %s', (value, expected) => {
    expect(activity([{ fID: 'ispresignup', fData: value }]).isPreSignup).toBe(expected);
    expect(
      activity([
        { fID: 'label', fData: 'Is Pre Sign-up' },
        { fID: 'checkbox', fData: value },
      ]).isPreSignup,
    ).toBe(expected);
  });

  test('preserves explicit false for recurring and student-led controls', () => {
    const result = activity(
      [
        { fID: 'isrecurringweekly', fData: false },
        { fID: 'isstudentled', fData: 'false' },
      ],
      'Chess (SL)',
    );
    expect(result.duration.isRecurringWeekly).toBe(false);
    expect(result.isStudentLed).toBe(false);
  });

  test('handles recurring and non-weekly dropdown values', () => {
    expect(
      activity([{ fID: 'unknown', fData: 'Recurring Weekly' }]).duration.isRecurringWeekly,
    ).toBe(true);
    expect(activity([{ fID: 'frequency', fData: 'Once' }]).duration.isRecurringWeekly).toBe(false);
    expect(activity([{ fID: 'frequency', fData: 'false' }]).duration.isRecurringWeekly).toBe(false);
  });

  test.each([
    ['IssuesT台上的社会问题', 'Issues T 台上的社会问题'],
    ['校管弦乐团（新老成员都适用', '校管弦乐团 (新老成员都适用)'],
    ['校管弦乐团(新老成员都适用)', '校管弦乐团 (新老成员都适用)'],
    ['Dr. Smith’s  Club', "Dr Smith's Club"],
  ])('preserves school-specific name correction for %s', (name, expected) => {
    expect(activity([], name).name).toBe(expected);
  });

  test('keeps independent nested state without changing frozen raw data', () => {
    const raw = fixture([{ fID: 'staff', fData: 'S1' }]);
    const before = JSON.stringify(raw);
    const first = normalizeActivity(raw, '42');
    first.staff.push('S2');
    first.materials.push('Board');
    first.requirements.push('Shoes');
    first.staffForReports.push('S3');
    first.studentLeaders.push('L1');
    first.duration.startDate = 'changed';
    first.meeting.location.room = 'changed';
    first.grades.min = '99';
    const second = normalizeActivity(raw, '42');
    expect(second.staff).toEqual(['S1']);
    expect(second.materials).toEqual([]);
    expect(second.requirements).toEqual([]);
    expect(second.staffForReports).toEqual([]);
    expect(second.studentLeaders).toEqual([]);
    expect(second.duration.startDate).toBeNull();
    expect(second.meeting.location.room).toBeNull();
    expect(second.grades.min).toBeNull();
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe('grade schedules', () => {
  test('resolves selection keys locally and uses explicit title grades only as fallback', () => {
    const result = activity(
      [
        { fID: 'academicyear', fData: '2026', lParms: [{ key: '2026', val: '2026/2027' }] },
        { fID: 'schedule', fData: '91', lParms: [{ key: '91', val: 'G7-G9' }] },
        { fID: 'day', fData: '1', lParms: [{ key: '1', val: 'dwMonday' }] },
      ],
      'Chess (G10-12)',
    );
    expect(result.academicYear).toBe('2026/2027');
    expect(result.schedule).toBe('G7-G9');
    expect(result.grades).toEqual({ min: '7', max: '9' });
    expect(result.meeting.day).toBe('Monday');
    expect(
      activity([
        {
          fID: 'room',
          fData: '201',
          lParms: [
            { key: '201', val: '202' },
            { key: '9', val: '201' },
          ],
        },
      ]).meeting.location.room,
    ).toBe('201');
    expect(
      activity([{ fID: 'schedule', fData: 'Evening study session' }], '托福强化班（G10-11） E')
        .grades,
    ).toEqual({ min: '10', max: '11' });
    expect(activity([{ fID: 'yeargroup', fData: 'G3-G5' }]).grades).toEqual({ min: '3', max: '5' });
    expect(activity([{ fID: 'schedule', fData: 'G5-1' }], 'Chess (G1-3)').grades).toEqual({
      min: null,
      max: null,
    });
    expect(
      activity([{ fID: 'schedule', fData: '65', lParms: [{ key: '66', val: 'G7-G9' }] }]).grades,
    ).toEqual({ min: null, max: null });
  });
  test.each([
    ['G1-5', '1', '5'],
    ['G1-G5', '1', '5'],
    ['KG1-KG3', '1', '3'],
    ['KG1-3', '1', '3'],
    ['Monday G10 – G12', '10', '12'],
    ['Grades 2 — 6', '2', '6'],
    ['Year 3 to be confirmed', '3', '3'],
    ['g01-03', '1', '3'],
    ['G7', '7', '7'],
    ['KG2', '2', '2'],
    ['G1, G3, G5', '1', '5'],
    ['G1-G3 & G7-G9', '1', '9'],
    ['年级G2至G4', '2', '4'],
    ['2022.23 CCA S2 - KG2-KG3 - Internal', '2', '3'],
    ['G1-G5 - External', '1', '5'],
  ])('parses %s', (schedule, min, max) => {
    expect(activity([{ fID: 'schedule', fData: schedule }]).grades).toEqual({ min, max });
  });

  test.each([
    '',
    'All grades',
    '15:00-16:00',
    'G5-1',
    'G1-',
    'G1-G',
    'KG2-KG3 -',
    'KG2-KG3 - KG',
    'KG3-G2',
    'G1 and KG2',
    'Gx-5',
    'G1.5-G3',
    'GROUPG1-5',
    'G9007199254740992-9007199254740993',
  ])('leaves unsupported or invalid schedule %s unset', (schedule) => {
    expect(activity([{ fID: 'schedule', fData: schedule }]).grades).toEqual({
      min: null,
      max: null,
    });
  });
});

describe('structured recognition rules', () => {
  test('normalizes labels without interpreting literal data as labels', () => {
    const result = activity(
      [
        { fID: null, fData: '  CHINESE_DESCRIPTION： ' },
        { fID: '1', fData: '每周play' },
        { fID: null, fData: 'STUDENT-LED:' },
        { fID: '1', fType: 18, fData: 'x' },
        { fID: 'description', fType: 4, fData: 'Description' },
        { fID: 'category', fData: 'Requirements' },
      ],
      'Description',
    );
    expect(result.name).toBe('Description');
    expect(result.description).toBe('Description');
    expect(result.category).toBe('Requirements');
    expect(result.descriptionZh).toBe('每周 play');
    expect(result.isStudentLed).toBe(true);
    expect(
      activity([
        { fID: 'activityname', fType: 4, fData: 'Description' },
        { fID: 'value', fData: 'ignored' },
      ]).name,
    ).toBe('Description');
  });

  test('keeps both languages and falls back to Chinese when English is empty', () => {
    const fields: RawActivityField[] = [
      { fID: null, fData: 'Chinese Description' },
      { fID: '1', fData: '每周play<br/> 社团club' },
    ];
    expect(activity(fields)).toMatchObject({
      descriptionZh: '每周 play\n社团 club',
      description: '每周 play\n社团 club',
    });
    expect(
      activity([...fields, { fID: 'description', fData: 'English description' }]),
    ).toMatchObject({ description: 'English description', descriptionZh: '每周 play\n社团 club' });
  });

  test('preserves every meeting and unions staff without changing legacy meeting selection', () => {
    const raw = parseRawActivity({
      newRows: [
        { rID: '42:3:3:0', fields: [{ fID: 'activityname', fData: 'Chess' }] },
        {
          rID: '42:4:4:1',
          fields: [
            { fID: 'day', fData: 'Monday' },
            { fID: 'start', fData: '15:30' },
            { fID: 'end', fData: '16:30' },
            { fID: 'room', fData: '201' },
            { fID: 'staff', fData: 'S1, S2' },
          ],
        },
        {
          rID: '42:4:4:2',
          fields: [
            { fID: 'day', fData: 'Friday' },
            { fID: 'start', fData: '16:00' },
            { fID: 'end', fData: '17:00' },
            { fID: 'room', fData: '202' },
            { fID: 'staff', fData: 'S2, S3' },
          ],
        },
        { rID: '42:SAVE', fields: [{ fID: 'close', fData: 'Close' }] },
      ],
    });
    const before = JSON.stringify(raw);
    const result = normalizeActivity(raw, '42');
    expect(result.meetings).toEqual([
      {
        day: 'Monday',
        startTime: '15:30',
        endTime: '16:30',
        location: { site: null, block: null, room: '201' },
        staff: ['S1', 'S2'],
      },
      {
        day: 'Friday',
        startTime: '16:00',
        endTime: '17:00',
        location: { site: null, block: null, room: '202' },
        staff: ['S2', 'S3'],
      },
    ]);
    expect(result.staff).toEqual(['S1', 'S2', 'S3']);
    expect(result.meeting).toMatchObject({ day: 'Friday', location: { room: '202' } });
    result.meeting.location.room = 'changed';
    expect(result.meetings[1]?.location.room).toBe('202');
    expect(JSON.stringify(raw)).toBe(before);
  });

  test('recognizes recurrence by its control rather than a fixed column offset', () => {
    expect(
      activity([
        { fID: null, fData: 'Recurring Two-Weekly' },
        { fID: 'checkbox', fType: 18, fData: 'x' },
      ]).duration.isRecurringWeekly,
    ).toBe(false);
    expect(
      activity([
        { fID: null, fData: 'Activity Runs From' },
        { fID: 'runsfrom', fData: '2026-09-01' },
        { fID: null, fData: 'Extra layout' },
        { fID: 'runsto', fData: '2026-12-31' },
        { fID: null, fData: 'More layout' },
        { fID: null, fData: 'Recurring Two-Weekly' },
      ]).duration,
    ).toEqual({ startDate: '2026-09-01', endDate: '2026-12-31', isRecurringWeekly: false });
    expect(
      activity([
        { fID: null, fData: 'Recurring Weekly' },
        { fID: 'checkbox', fType: 18, fData: null },
      ]).duration.isRecurringWeekly,
    ).toBe(false);
  });
});

describe('staff directory', () => {
  test('removed staff disappears on the next response and on missing staff controls', () => {
    const first: StaffDirectory = normalizeStaff(
      staffFixture([
        { key: 'A', val: 'Alice' },
        { key: 'B', val: 'Bob' },
      ]),
    );
    expect(first).toEqual({ A: 'Alice', B: 'Bob' });
    expect(normalizeStaff(staffFixture([{ key: 'B', val: 'Bob' }]))).toEqual({ B: 'Bob' });
    expect(normalizeStaff(fixture())).toEqual({});
    expect(normalizeStaff(parseRawActivity({ newRows: [] }))).toEqual({});
    expect(first).toEqual({ A: 'Alice', B: 'Bob' });
  });

  test('returns independent objects and merges staff options across rows', () => {
    const raw = parseRawActivity({
      newRows: [
        { fields: [{ fID: 'staff', lParms: [{ key: 'A', val: 'Alice' }] }] },
        {
          fields: [
            {
              fID: 'staff',
              lParms: [
                { key: 'B', val: 'Bob' },
                { key: 'A', val: 'Updated' },
              ],
            },
          ],
        },
      ],
    });
    const first = normalizeStaff(raw);
    first.A = 'Changed';
    expect(normalizeStaff(raw)).toEqual({ A: 'Updated', B: 'Bob' });
  });

  test('preserves every legacy blacklist entry', () => {
    const keys = [
      'CL1-827',
      'CL1-831',
      'ID: CL1-832',
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
    ];
    expect(normalizeStaff(staffFixture(keys.map((key) => ({ key, val: 'Placeholder' }))))).toEqual(
      {},
    );
  });

  test.each([
    ['Mr TT15 Pri KinLiu TT15 Pri KinLiu', 'Mr Kin Liu'],
    ['Mr TT13 Yanni Shen TT13 Yanni Shen', 'Mr Yanni Shen'],
    ['Mr TT19 Pri Saima Salem TT19 Pri Saima Salem', 'Mr Saima Salem'],
    ['Ms TT Ca(CCA) TT Ma', 'Ms Ca Ma'],
    ['Mr JackyT JackyT', 'Mr JackyT'],
    ['Ms TT Ma TT M', 'Ms Ma M'],
    ['TT01 Fang TT01 Dong', 'Mr Fang Dong'],
    ['Mr TT18 Shane Rose TT18 Shane Rose', 'Mr Shane Rose'],
    ['Ms Caroline Malone(id)', 'Ms Caroline Malone'],
    ['Ms Marina Mao(id)', 'Ms Marina Mao'],
    ['Mrs Amy Yuan (Lower Secondary Secretary初中部学部助理)', 'Mrs Amy Yuan'],
    ['Ms Lily Liu (Primary)', 'Ms Lily Liu'],
    ['Ms Cindy 薛', 'Ms Cindy Xue'],
    ['Ms SiSi Li', 'Ms Sisi Li'],
  ])('preserves name correction for %s', (name, corrected) => {
    expect(normalizeStaff(staffFixture([{ key: 'S1', val: name }]))).toEqual({ S1: corrected });
  });

  test('handles absent names and special object keys without inherited corrections', () => {
    const directory = normalizeStaff(
      staffFixture([
        { key: 'empty' },
        { key: '__proto__', val: 'Safe' },
        { key: 'constructor', val: 'constructor' },
        { key: 'other', val: 'toString' },
      ]),
    );
    expect(directory.empty).toBe('');
    expect(Object.hasOwn(directory, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(directory, '__proto__')?.value).toBe('Safe');
    expect(Object.getOwnPropertyDescriptor(directory, 'constructor')?.value).toBe('constructor');
    expect(directory.other).toBe('toString');
    expect(Object.getPrototypeOf(directory)).toBe(Object.prototype);
  });
});

describe('payload validation', () => {
  test.each(
    [
      null,
      undefined,
      [],
      '{}',
      {},
      { newRows: null },
      { newRows: {} },
      { newRows: [null] },
      { newRows: [{}] },
      { newRows: [{ fields: null }] },
      { newRows: [{ rID: 42, fields: [] }] },
      { newRows: [{ fields: [null] }] },
      { newRows: [{ fields: [{}] }] },
      { newRows: [{ fields: [{ fID: 1 }] }] },
      { newRows: [{ fields: [{ fID: null, fData: {} }] }] },
      { newRows: [{ fields: [{ fID: 'activityname', fData: {} }] }] },
      { newRows: [{ fields: [{ fID: 'activityname', fData: 123 }] }] },
      { isError: 'false', newRows: [] },
      { newRows: [{ fields: [{ fID: 'staff', lParms: {} }] }] },
      { newRows: [{ fields: [{ fID: 'staff', lParms: [null] }] }] },
      { newRows: [{ fields: [{ fID: 'staff', lParms: [{ val: 'No ID' }] }] }] },
      { newRows: [{ fields: [{ fID: 'staff', lParms: [{ key: 'A', val: 42 }] }] }] },
    ].map((value) => [value]),
  )('rejects malformed payload %# with a ZodError', (value) => {
    expect(() => parseRawActivity(value)).toThrow(ZodError);
  });

  test('accepts empty rows at the protocol boundary but rejects missing activities', () => {
    const raw = parseRawActivity({ newRows: [] });
    expect(rawActivitySchema.safeParse(raw).success).toBe(true);
    expect(() => normalizeActivity(raw, '42')).toThrow(ActivityNormalizationError);
    expect(() => normalizeActivity(parseRawActivity({ newRows: [{ fields: [] }] }), '42')).toThrow(
      ActivityNormalizationError,
    );
    expect(() => activity([], '  ')).toThrow(ActivityNormalizationError);
  });

  test('preserves upstream error flags for classification and refuses to normalize them', () => {
    for (const value of [
      { isError: true },
      { isError: true, newRows: [] },
      { isError: true, newRows: [{ fields: [{ fID: 'activityname', fData: 'Chess' }] }] },
    ]) {
      const raw = parseRawActivity(value);
      expect(raw.isError).toBe(true);
      expect(() => normalizeActivity(raw, '42')).toThrow(ActivityNormalizationError);
      expect(() => normalizeStaff(raw)).toThrow(ActivityNormalizationError);
    }
  });

  test('accepts harmless metadata and non-staff control parameters', () => {
    const raw = parseRawActivity({
      metadata: { version: 1 },
      newRows: [
        {
          extra: true,
          fields: [
            { fID: 'activityname', fData: 'Chess', fType: 'text' },
            { fID: 'schedule', fData: null, lParms: ['custom control metadata', 1] },
          ],
        },
      ],
    });
    expect(raw.metadata).toEqual({ version: 1 });
    expect(normalizeActivity(raw, '42').schedule).toBeNull();
  });

  test('rejects invalid semantic data and incomplete label/value pairs', () => {
    expect(() => activity([{ fID: 'ispresignup', fData: 'maybe' }])).toThrow(
      ActivityNormalizationError,
    );
    expect(() => activity([{ fID: 'day', fData: false }])).toThrow(ActivityNormalizationError);
    expect(() => activity([{ fID: 'label', fData: 'Description' }])).toThrow(
      ActivityNormalizationError,
    );
    expect(() => normalizeActivity(fixture(), '')).toThrow(ZodError);
    expect(() => normalizeActivity(fixture(), '43')).toThrow(ActivityNormalizationError);
  });

  test('normalizers also validate callers that bypass parseRawActivity', () => {
    const malformed = {
      newRows: [{ fields: [{ fID: 'staff', lParms: [42] }] }],
    } as unknown as RawActivity;
    expect(() => normalizeActivity(malformed, '42')).toThrow(ZodError);
    expect(() => normalizeStaff(malformed)).toThrow(ZodError);
  });
});
