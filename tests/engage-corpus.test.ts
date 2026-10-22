import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { sourceFeatures } from '../scripts/engage-corpus/features.ts';
import { hash, loadCorpus } from '../scripts/engage-corpus/io.ts';
import { verifyCase } from '../scripts/engage-corpus/verify.ts';

const directory = fileURLToPath(new URL('./fixtures/engage-corpus', import.meta.url));
const { manifest, cases } = await loadCorpus(directory);
const partition = process.env.CORPUS_PARTITION ?? 'all';
if (!['all', 'regression', 'validation'].includes(partition))
  throw new Error('Unknown CORPUS_PARTITION');
const selected = cases.filter(
  (entry) => partition === 'all' || entry.input.partition === partition,
);

test('frozen expectations identify the current independent oracle and reviewed aliases', async () => {
  for (const [file, expected] of [
    ['oracle.ts', manifest.oracleSha256],
    ['reviewed-staff-aliases.ts', manifest.reviewedAliasesSha256],
  ] as const) {
    const bytes = await Bun.file(
      new URL(`../scripts/engage-corpus/${file}`, import.meta.url),
    ).bytes();
    expect(hash(bytes)).toBe(expected);
  }
});

test('the frozen corpus covers every ID and keeps activity groups within one partition', () => {
  expect(cases).toHaveLength(11001);
  expect(selected.length).toBeGreaterThan(0);
  const counts: Record<string, number> = {},
    partitions: Record<string, number> = {};
  const coverage: Record<string, Record<string, number>> = { regression: {}, validation: {} };
  for (const entry of cases) {
    expect(entry.input.features).toEqual(
      sourceFeatures(entry.input.response, entry.golden.expected),
    );
    const kind = entry.golden.expected.kind;
    counts[kind] = (counts[kind] ?? 0) + 1;
    partitions[entry.input.partition] = (partitions[entry.input.partition] ?? 0) + 1;
    for (const feature of entry.input.features) {
      const bucket = coverage[entry.input.partition];
      if (bucket) bucket[feature] = (bucket[feature] ?? 0) + 1;
    }
    expect(entry.input.sourceBodySha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(counts).toEqual(manifest.counts);
  expect(partitions).toEqual(manifest.partitions);
  expect(coverage).toEqual(manifest.coverage);
  expect(partitions.validation).toBeGreaterThan(0);
  expect(partitions.regression).toBeGreaterThan(0);
  for (const feature of [
    'activity',
    'upstream-error',
    'multiple-meetings',
    'bilingual',
    'kindergarten',
    'pre-signup',
    'student-led',
  ]) {
    expect(manifest.coverage.validation?.[feature]).toBeGreaterThan(0);
    expect(manifest.coverage.regression?.[feature]).toBeGreaterThan(0);
  }
  expect(manifest.coverage.validation?.['empty-form']).toBe(1);
  for (const feature of Object.keys(coverage.regression ?? {}).filter((key) =>
    key.startsWith('year:'),
  )) {
    expect(coverage.validation?.[feature]).toBeGreaterThan(0);
  }
});

test('the published corpus contains only safe headers, pseudonyms and placeholder images', () => {
  const images = new Set<string>();
  for (const entry of cases) {
    const response = entry.input.response;
    for (const [header, value] of response.headers) {
      if (!['content-type', 'content-length'].includes(header))
        throw new Error(`ID ${entry.input.id}: unsafe header`);
      if (header === 'content-length' && Number(value) !== Buffer.byteLength(response.body))
        throw new Error('Clean body length mismatch');
    }
    const outer = JSON.parse(response.body);
    const source = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
    if (source.PupilIDsLookup && Object.keys(source.PupilIDsLookup).length)
      throw new Error('Pupil lookup was not cleared');
    for (const row of source.newRows) {
      const caption = row.fields[0]?.fData;
      for (const field of row.fields) {
        if (
          field.fID === 'activityname' &&
          field.fData &&
          !field.fData.startsWith(`Corpus Club 社团 ${entry.input.id}`)
        )
          throw new Error('Original activity title survived');
        if (typeof field.fData === 'string') {
          for (const match of field.fData.matchAll(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g))
            images.add(match[0]);
        }
        if (field.fID === 'staff')
          for (const option of field.lParms ?? []) {
            if (
              !/^T-[a-f0-9]{16}$/.test(option.key) &&
              !/^(?:ID:\s*)?CL1-(?:827|831|832|834|835|836|838|842|843|844|845|846)$/.test(
                option.key,
              )
            )
              throw new Error('Original staff ID survived');
            if (option.val && !/^Teacher-[a-f0-9]{16}$/.test(option.val))
              throw new Error('Original staff name survived');
          }
      }
      if (
        ['Description', 'Chinese Description', 'Poor Weather Plan', 'Semester Cost'].includes(
          caption,
        )
      ) {
        const value = String(row.fields[1]?.fData ?? '');
        if (
          value
            .replace(/<\/?(?:br|p|div|span|ul|ol|li|b|strong|i|em|a)>/g, '')
            .replaceAll('Corpus content 中文内容', '')
            .trim()
        )
          throw new Error('Original free prose survived');
      }
      if (['Name To Appear On Reports', 'Student Leader Name(s)'].includes(caption)) {
        const prefix = caption === 'Student Leader Name(s)' ? 'Student' : 'Teacher';
        for (const name of String(row.fields[1]?.fData ?? '')
          .split(/,\s*|\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean)) {
          if (!new RegExp(`^${prefix}-[a-f0-9]{16}$`).test(name))
            throw new Error('Original selected person survived');
        }
      }
    }
  }
  expect(images.size).toBe(1);
  const image = [...images][0];
  if (!image) throw new Error('Placeholder image missing');
  const bytes = Buffer.from(image.split(',')[1] ?? '', 'base64');
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  expect(bytes.readUInt32BE(16)).toBe(1);
  expect(bytes.readUInt32BE(20)).toBe(1);
});

for (const entry of selected) {
  test(`Engage ID ${entry.input.id} [${entry.input.partition}/${entry.golden.expected.kind}]`, async () => {
    await verifyCase(entry.input.response, entry.golden.expected);
  });
}
