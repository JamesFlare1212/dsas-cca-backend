import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFeatures } from '../scripts/engage-corpus/features.ts';
import { hash, readCapture } from '../scripts/engage-corpus/io.ts';
import type { HttpInput, SourceBody } from '../scripts/engage-corpus/model.ts';
import { decodeSource, deriveExpected, referenceGrades } from '../scripts/engage-corpus/oracle.ts';
import { assertReferencesPreserved, Sanitizer } from '../scripts/engage-corpus/sanitize.ts';
import { differences, verifyCase } from '../scripts/engage-corpus/verify.ts';
import { normalizeActivity, parseRawActivity } from '../src/domain/normalize.ts';

function input(body: SourceBody, id = 42): HttpInput {
  return {
    id,
    status: 200,
    statusText: 'OK',
    headers: [
      ['content-type', 'application/json'],
      ['set-cookie', 'fixture-private-session=example'],
    ],
    body: JSON.stringify({ d: JSON.stringify(body) }),
  };
}
const source: SourceBody = {
  isError: false,
  PupilIDsLookup: { privatePupil: 'Example Pupil' },
  newRows: [
    {
      rID: '42:1',
      fields: [
        { fID: 'activityname', fData: 'Private Person Club (G7-G9)' },
        { fID: 'schedule', fData: 'Evening study' },
      ],
    },
    {
      rID: '42:2',
      fields: [
        { fID: null, fData: 'Description' },
        { fID: '1', fData: 'Private Person contact private@example.org' },
      ],
    },
    {
      rID: '42:3',
      fields: [
        { fID: null, fData: 'Chinese Description' },
        { fID: '1', fData: '学生说明' },
      ],
    },
    {
      rID: '42:4',
      fields: [
        { fID: 'day', fData: 'Monday' },
        {
          fID: 'staff',
          fData: 'Private Person',
          lParms: [{ key: 'privateStaff', val: 'Private Person' }],
        },
      ],
    },
    {
      rID: '42:5',
      fields: [
        { fID: 'day', fData: 'Friday' },
        {
          fID: 'staff',
          fData: 'Another Person',
          lParms: [{ key: 'otherStaff', val: 'Another Person' }],
        },
      ],
    },
  ],
};

test('the independent reference follows source controls and detects damaged parser results', () => {
  const expected = deriveExpected(input(source));
  expect(expected.kind).toBe('activity');
  if (expected.kind !== 'activity') throw new Error('Expected activity');
  expect(expected.activity.grades).toEqual({ min: '7', max: '9' });
  expect(expected.activity.meetings).toHaveLength(2);
  const actual = normalizeActivity(parseRawActivity(source), '42');
  expect(differences(actual, expected.staffDirectory, expected)).toEqual([]);
  expect(differences(actual, expected.staffDirectory, expected, false)).toEqual([]);
  expect(
    differences(
      actual,
      { ...expected.staffDirectory, privateStaff: 'Incorrect person' },
      expected,
      false,
    ),
  ).toContain('staffDirectory.values');
  const mutations = [
    (value: typeof actual) => {
      value.meetings.pop();
    },
    (value: typeof actual) => {
      value.descriptionZh = null;
    },
    (value: typeof actual) => {
      value.staff = [];
    },
    (value: typeof actual) => {
      value.grades.min = '12';
    },
    (value: typeof actual) => {
      value.isStudentLed = !value.isStudentLed;
    },
    (value: typeof actual) => {
      value.name = 'Wrong club';
    },
  ];
  for (const mutation of mutations) {
    const changed = structuredClone(actual);
    mutation(changed);
    expect(differences(changed, expected.staffDirectory, expected).length).toBeGreaterThan(0);
  }
});

test('the reference grade lexer checks range grammar independently of the parser', () => {
  expect(referenceGrades('G1-G3 & G7-G9')).toEqual({ min: '1', max: '9' });
  expect(referenceGrades('KG1')).toEqual({ min: '-2', max: '-2' });
  expect(referenceGrades('KG2')).toEqual({ min: '-1', max: '-1' });
  expect(referenceGrades('KG3')).toEqual({ min: '0', max: '0' });
  expect(referenceGrades('KG1-3')).toEqual({ min: '-2', max: '0' });
  expect(referenceGrades('KG2-KG3 - Internal')).toEqual({ min: '-1', max: '0' });
  for (const text of [
    'G5-1',
    'G1-',
    'G1-G',
    'G1.5-G3',
    'KG1-G3',
    'G1 and KG2',
    'KG0',
    'KG4',
    'KG1-KG4',
    'KG3-KG1',
  ]) {
    expect(referenceGrades(text)).toEqual({ min: null, max: null });
  }
});

test('comparison preserves word boundaries, line breaks and title parentheses', () => {
  const body: SourceBody = {
    newRows: [
      {
        rID: '42:1',
        fields: [
          { fID: 'activityname', fData: 'Science Club (G7)' },
          { fID: 'description', fData: 'Bring water<br/>Do not eat' },
        ],
      },
    ],
  };
  const expected = deriveExpected(input(body));
  if (expected.kind !== 'activity') throw new Error('Expected activity');
  const actual = normalizeActivity(parseRawActivity(body), '42');
  expect(differences(actual, expected.staffDirectory, expected)).toEqual([]);
  for (const description of ['BringwaterDonoteat', 'Bring waterDo not eat', 'Bringwater\nDonoteat'])
    expect(differences({ ...actual, description }, expected.staffDirectory, expected)).toContain(
      'activity.description',
    );
  expect(
    differences({ ...actual, name: 'Science Club G7' }, expected.staffDirectory, expected),
  ).toContain('activity.name');
});

test('literal caption words in named values are not interpreted as source labels', async () => {
  const body: SourceBody = {
    newRows: [
      {
        rID: '42:1',
        fields: [
          { fID: 'activityname', fData: 'Description' },
          { fID: 'schedule', fData: 'G7-G9' },
        ],
      },
    ],
  };
  const response = input(body);
  const expected = deriveExpected(response);
  if (expected.kind !== 'activity') throw new Error('Expected activity');
  expect(expected.activity.description).toBe('');
  expect(expected.activity.schedule).toBe('G7-G9');
  await verifyCase(response, expected);
});

test('unknown business templates and controls require review instead of empty expectations', () => {
  const namedRow = source.newRows[0];
  if (!namedRow) throw new Error('Missing named row');
  for (const row of [
    {
      rID: '42:99:17:0',
      fields: [
        { fID: null, fData: 'Unreviewed Field' },
        { fID: '1', fData: 'Important value' },
      ],
    },
    {
      rID: '42:99:7:0',
      fields: [
        { fID: null, fData: 'Maximum Capacity' },
        { fID: '1', fData: '20' },
      ],
    },
    { rID: '42:99', fields: [{ fID: 'seatCount', fData: '20' }] },
    { rID: '42:99', fields: [{ fID: '1', fData: 'Unlabelled value' }] },
    { ...namedRow, isDeleted: true },
  ]) {
    if (!row.rID || !row.fields) throw new Error('Missing fixture');
    expect(() => deriveExpected(input({ newRows: [...source.newRows, row] }))).toThrow(
      'Unreviewed',
    );
  }
});

test('Chinese fallback is not counted as bilingual source content', () => {
  for (const english of ['', '   ', 'English description']) {
    const body: SourceBody = {
      newRows: [
        {
          rID: '42:1',
          fields: [
            { fID: 'activityname', fData: 'Science Club' },
            { fID: 'description', fData: english },
            { fID: 'descriptionZh', fData: '中文描述' },
          ],
        },
      ],
    };
    const response = input(body);
    const features = sourceFeatures(response, deriveExpected(response));
    expect(features).toContain('chinese-description');
    expect(features.includes('bilingual')).toBe(Boolean(english.trim()));
    expect(features.includes('chinese-only')).toBe(!english.trim());
  }
});

test('cleaning preserves period and room references and rejects altered mappings', () => {
  const body = structuredClone(source);
  const row = body.newRows[3];
  if (!row) throw new Error('Missing meeting');
  row.fields.push(
    { fID: 'linkedPeriod', fData: '11', lParms: [{ key: '11', val: 'Period 11' }] },
    { fID: 'room', fData: 'R1', lParms: [{ key: '100|101|102', val: 'R1' }] },
  );
  const original = input(body);
  const sanitizer = new Sanitizer(Buffer.alloc(32, 1), 'data:image/png;base64,fixture');
  sanitizer.observe(body);
  sanitizer.seal();
  const cleaned = sanitizer.clean(original);
  expect(() => assertReferencesPreserved(original, cleaned)).not.toThrow();
  const cleanSource = decodeSource(cleaned);
  const period = cleanSource.newRows
    .flatMap((entry) => entry.fields)
    .find((f) => f.fID === 'linkedPeriod');
  expect(period?.fData).toBe('11');
  for (const id of ['linkedPeriod', 'room']) {
    const changed = decodeSource(cleaned);
    const field = changed.newRows.flatMap((entry) => entry.fields).find((f) => f.fID === id);
    if (!field) throw new Error('Missing source reference');
    field.fData = 'Fixture control';
    expect(() => assertReferencesPreserved(original, input(changed))).toThrow(
      'Cleaning changed source references',
    );
  }
  const room = cleanSource.newRows.flatMap((entry) => entry.fields).find((f) => f.fID === 'room');
  if (!room?.lParms?.[0]) throw new Error('Missing room lookup');
  room.lParms[0].key = 'different-room';
  expect(() => assertReferencesPreserved(original, input(cleanSource))).toThrow(
    'Cleaning changed source references',
  );
});

test('sanitization removes sensitive fields and preserves parser-relevant source structure', async () => {
  const sanitizer = new Sanitizer(Buffer.alloc(32, 1), 'data:image/png;base64,fixture');
  sanitizer.observe(source);
  sanitizer.seal();
  const cleaned = sanitizer.clean(input(source));
  sanitizer.assertPrivateDataRemoved(cleaned);
  expect(cleaned.body).not.toContain('Private Person');
  expect(cleaned.body).not.toContain('private@example.org');
  expect(cleaned.body).not.toContain('Example Pupil');
  expect(cleaned.body).not.toContain('privateStaff');
  expect(JSON.stringify(cleaned.headers)).not.toContain('set-cookie');
  const expected = deriveExpected(cleaned);
  if (expected.kind !== 'activity') throw new Error('Expected cleaned activity');
  expect(expected.activity.grades).toEqual({ min: '7', max: '9' });
  expect(expected.activity.meetings).toHaveLength(2);
  expect(Object.keys(expected.staffDirectory)).toHaveLength(2);
  await verifyCase(cleaned, expected);
});

test('source negative cases are retained as outages and empty forms, never invented activities', async () => {
  const failed = input({
    isError: true,
    newRows: [
      { rID: 'errorblock', fields: [{ fID: 'error', fData: 'Sequence contains no elements' }] },
    ],
  });
  const expected = deriveExpected(failed);
  expect(expected.kind).toBe('upstream-error');
  await verifyCase(failed, expected);
  const empty = input(
    {
      newRows: [
        { rID: '0:1', fields: [{ fID: 'activityname', fData: '' }] },
        {
          rID: '0:99:7:0',
          fields: [
            { fID: null, fData: 'Maximum Capacity' },
            { fID: '1', fData: '20' },
          ],
        },
      ],
    },
    0,
  );
  expect(deriveExpected(empty)).toEqual({ kind: 'empty-form' });
  await verifyCase(empty, deriveExpected(empty));
  expect(() => decodeSource({ ...empty, body: '{}' })).toThrow();
});

test('original capture hashes detect modification before response decoding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cca-corpus-integrity-'));
  try {
    await mkdir(join(directory, 'responses'));
    const bytes = Buffer.from(input(source).body);
    const snapshot = {
      schemaVersion: 1,
      id: 42,
      request: {
        method: 'POST',
        path: '/Services/ActivitiesService.asmx/GetActivityDetails',
        body: '{"activityID":"42"}',
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [],
        setCookie: [],
        capturedAt: '2026-10-22T00:00:00Z',
        bodyBase64: bytes.toString('base64'),
        bodySha256: hash(bytes),
      },
    };
    const path = join(directory, 'responses', '00042.http.json.gz');
    await writeFile(path, Bun.gzipSync(JSON.stringify(snapshot)));
    expect((await readCapture(directory, 42)).input.body).toBe(bytes.toString());
    snapshot.response.bodyBase64 = Buffer.from('altered').toString('base64');
    await writeFile(path, Bun.gzipSync(JSON.stringify(snapshot)));
    await expect(readCapture(directory, 42)).rejects.toThrow('Raw response hash mismatch');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
