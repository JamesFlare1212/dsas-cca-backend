import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import sharp from 'sharp';
import { hash, readCapture } from './engage-corpus/io.ts';
import type { CorpusManifest, Expected, GoldenCase, InputCase } from './engage-corpus/model.ts';
import { decodeSource, deriveExpected } from './engage-corpus/oracle.ts';
import { Sanitizer } from './engage-corpus/sanitize.ts';
import { verifyCase } from './engage-corpus/verify.ts';

const rawDirectory = resolve(process.env.RAW_CORPUS_DIR ?? 'data/engage-corpus/raw');
const output = resolve(process.env.CORPUS_OUTPUT ?? 'tests/fixtures/engage-corpus');
const sourceManifestBytes = await readFile(join(rawDirectory, 'manifest.json'));
const sourceManifest = JSON.parse(sourceManifestBytes.toString());
if (
  !sourceManifest.complete ||
  sourceManifest.completed !== 11001 ||
  sourceManifest.minId !== 0 ||
  sourceManifest.maxId !== 11000 ||
  sourceManifest.entries.length !== 11001
) {
  throw new Error('Raw capture is incomplete; no fixture publication is allowed');
}
const seedPath = join(rawDirectory, 'sanitization-seed');
let seed: Buffer;
try {
  seed = await readFile(seedPath);
} catch {
  seed = randomBytes(32);
  await writeFile(seedPath, seed, { mode: 0o600, flag: 'wx' });
}
const image = `data:image/png;base64,${(
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#315276' } })
    .png()
    .toBuffer()
).toString('base64')}`;
const sanitizer = new Sanitizer(seed, image);
const metadata: { id: number; group: string; forceValidation: boolean; features: string[] }[] = [];
const quarantine: { id: number; phase: string; reason: string }[] = [];
const recordSeals: { id: number; recordSha256: string; bodySha256: string }[] = [];
const counts: Record<string, number> = {},
  partitions: Record<string, number> = {};
const coverage: Record<string, Record<string, number>> = { regression: {}, validation: {} };

function traits(expected: Expected): string[] {
  const result: string[] = [expected.kind];
  if (expected.kind === 'activity') {
    const a = expected.activity;
    result.push(`year:${a.academicYear}`);
    if (a.meetings.length > 1) result.push('multiple-meetings');
    if (a.descriptionZh) result.push('bilingual');
    if (a.isPreSignup) result.push('pre-signup');
    if (a.isStudentLed) result.push('student-led');
    if (/^\d+$/.test(a.schedule ?? '')) result.push('orphan-schedule');
    if (/KG\d/i.test(a.schedule ?? '')) result.push('kindergarten');
  }
  return result;
}
function invariants(expected: Expected) {
  if (expected.kind !== 'activity') return { kind: expected.kind };
  const a = expected.activity;
  return {
    kind: expected.kind,
    id: a.id,
    academicYear: a.academicYear,
    category: a.category,
    schedule: a.schedule,
    duration: a.duration,
    grades: a.grades,
    preSignup: a.isPreSignup,
    studentLed: a.isStudentLed,
    slots: a.meetings.map((slot) => ({
      day: slot.day,
      start: slot.startTime,
      end: slot.endTime,
      staff: slot.staff.length,
    })),
    staff: a.staff.length,
    directory: Object.keys(expected.staffDirectory).length,
    studentLeaders: a.studentLeaders.length,
    reports: a.staffForReports.length,
    photo: !!a.photo,
    zh: !!a.descriptionZh,
    description: !!a.description,
  };
}
const errors = (error: unknown) =>
  error instanceof Error ? error.message : 'Unknown validation error';
for (let id = 0; id <= 11000; id++) {
  try {
    const { record, input, recordSha256 } = await readCapture(rawDirectory, id);
    const entry = sourceManifest.entries[id];
    if (
      entry.id !== id ||
      entry.bodySha256 !== record.response.bodySha256 ||
      entry.status !== input.status
    )
      throw new Error('Raw index mismatch');
    const expected = deriveExpected(input);
    sanitizer.observe(decodeSource(input));
    const features = traits(expected);
    metadata.push({
      id,
      group: sanitizer.group(input),
      forceValidation: features.includes('empty-form') || features.includes('orphan-schedule'),
      features,
    });
    recordSeals.push({ id, recordSha256, bodySha256: record.response.bodySha256 });
  } catch (error) {
    quarantine.push({ id, phase: 'source', reason: errors(error) });
  }
  if (id % 1000 === 0)
    console.log(
      JSON.stringify({ phase: 'source-inventory', checked: id + 1, quarantine: quarantine.length }),
    );
}
sanitizer.seal();
const forced = new Set(metadata.filter((item) => item.forceValidation).map((item) => item.group));
const staging = resolve(`data/engage-corpus/staging-${Date.now()}`);
await mkdir(staging, { recursive: true });
const shards: CorpusManifest['shards'] = [];
let inputs: InputCase[] = [],
  goldens: GoldenCase[] = [],
  shardIndex = 0;
async function flush() {
  if (!inputs.length) return;
  const prefix = String(shardIndex++).padStart(3, '0');
  const input = `${prefix}.http.json.br`,
    expected = `${prefix}.expected.json.br`;
  const options = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } };
  const inputBytes = brotliCompressSync(JSON.stringify(inputs), options);
  const expectedBytes = brotliCompressSync(JSON.stringify(goldens), options);
  await writeFile(join(staging, input), inputBytes);
  await writeFile(join(staging, expected), expectedBytes);
  shards.push({
    input,
    inputSha256: hash(inputBytes),
    expected,
    expectedSha256: hash(expectedBytes),
    count: inputs.length,
  });
  inputs = [];
  goldens = [];
}
for (const item of metadata) {
  try {
    const { record, input } = await readCapture(rawDirectory, item.id);
    const sourceExpected = deriveExpected(input);
    await verifyCase(input, sourceExpected, false);
    const clean = sanitizer.clean(input);
    sanitizer.assertPrivateDataRemoved(clean);
    const expected = deriveExpected(clean);
    if (JSON.stringify(invariants(sourceExpected)) !== JSON.stringify(invariants(expected)))
      throw new Error('Cleaning changed semantic invariants');
    await verifyCase(clean, expected);
    const partition =
      forced.has(item.group) || Number.parseInt(item.group.slice(-8), 16) / 0x100000000 < 0.2
        ? 'validation'
        : 'regression';
    inputs.push({
      id: item.id,
      partition,
      group: item.group,
      sourceBodySha256: record.response.bodySha256,
      cleanBodySha256: hash(clean.body),
      features: item.features,
      response: clean,
    });
    goldens.push({ id: item.id, sha256: hash(JSON.stringify(expected)), expected });
    counts[expected.kind] = (counts[expected.kind] ?? 0) + 1;
    partitions[partition] = (partitions[partition] ?? 0) + 1;
    for (const feature of item.features) {
      const bucket = coverage[partition];
      if (bucket) bucket[feature] = (bucket[feature] ?? 0) + 1;
    }
    if (inputs.length >= 100) await flush();
  } catch (error) {
    quarantine.push({ id: item.id, phase: 'verification', reason: errors(error) });
  }
  if ((item.id + 1) % 100 === 0)
    console.log(
      JSON.stringify({
        phase: 'verify-original-and-clean',
        checked: item.id + 1,
        quarantine: quarantine.length,
      }),
    );
}
await flush();
await writeFile(join(rawDirectory, 'seal.json'), JSON.stringify(recordSeals), { mode: 0o600 });
await writeFile(
  resolve('data/engage-corpus/quarantine.json'),
  JSON.stringify(quarantine, null, 2),
  { mode: 0o600 },
);
if (
  quarantine.length ||
  metadata.length !== 11001 ||
  Object.values(counts).reduce((a, b) => a + b, 0) !== 11001
) {
  throw new Error(
    `${quarantine.length} quarantined records; corpus NOT published. Inspect data/engage-corpus/quarantine.json`,
  );
}
const manifest: CorpusManifest = {
  version: 1,
  generatedBy: 'engage-corpus-builder',
  sourceManifestSha256: hash(sourceManifestBytes),
  sourceRange: { min: 0, max: 11000, count: 11001 },
  generatedAt: new Date().toISOString(),
  oracleSha256: hash(await readFile(new URL('./engage-corpus/oracle.ts', import.meta.url))),
  reviewedAliasesSha256: hash(
    await readFile(new URL('./engage-corpus/reviewed-staff-aliases.ts', import.meta.url)),
  ),
  sanitization: [
    'Private raw Fetch response status, headers and unmodified body bytes remain outside Git; transfer/content decoding by Fetch is not a wire/packet capture.',
    'HTTP fixture bodies are cleaned derivatives, not original byte-for-byte responses. All originals are separately verified before cleaning.',
    'Names and free prose are replaced; title grade/student-led markers and text/tag/paragraph presence are retained. Original prose correctness is checked privately.',
    'Staff/student values and staff IDs use stable private-seed pseudonyms; public legacy blacklist IDs are retained to test filtering.',
    'Images are replaced by a valid one-pixel PNG; original photo bytes are checked privately, not published.',
    'Pupil lookup values, unused UI metadata and sensitive/volatile headers are removed; only safe response headers are reconstructed.',
    'Inputs and golden expectations are stored separately. Expectations come from source controls, never parser output.',
    'Canonical title groups stay within one partition. This is a regression validation split of previously observed activities, not an unseen-data generalization claim.',
  ],
  counts,
  partitions,
  coverage,
  shards,
};
await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await mkdir(dirname(output), { recursive: true });
try {
  const old = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  if (old.generatedBy !== 'engage-corpus-builder')
    throw new Error('Refusing to replace a non-generated directory');
  await rename(output, resolve(`data/engage-corpus/previous-${Date.now()}`));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
await rename(staging, output);
console.log(
  JSON.stringify({ published: output, counts, partitions, shards: shards.length, quarantined: 0 }),
);
