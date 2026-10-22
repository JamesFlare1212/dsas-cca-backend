import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, readCapture } from '../scripts/engage-corpus/io.ts';
import type { HttpInput, SourceBody } from '../scripts/engage-corpus/model.ts';
import { decodeSource, deriveExpected, referenceGrades } from '../scripts/engage-corpus/oracle.ts';
import { Sanitizer } from '../scripts/engage-corpus/sanitize.ts';
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
  expect(referenceGrades('KG2-KG3 - Internal')).toEqual({ min: '2', max: '3' });
  for (const text of ['G5-1', 'G1-', 'G1-G', 'G1.5-G3', 'KG1-G3', 'G1 and KG2']) {
    expect(referenceGrades(text)).toEqual({ min: null, max: null });
  }
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
    { newRows: [{ rID: '0:1', fields: [{ fID: 'activityname', fData: '' }] }] },
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
