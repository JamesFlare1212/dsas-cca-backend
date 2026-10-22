import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import type { CorpusManifest, GoldenCase, HttpInput, InputCase, RawCapture } from './model.ts';

export const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export async function readCapture(directory: string, id: number) {
  const bytes = await readFile(
    join(directory, 'responses', `${String(id).padStart(5, '0')}.http.json.gz`),
  );
  const record: RawCapture = JSON.parse(Buffer.from(Bun.gunzipSync(bytes)).toString());
  if (
    record.schemaVersion !== 1 ||
    record.id !== id ||
    record.request.method !== 'POST' ||
    record.request.path !== '/Services/ActivitiesService.asmx/GetActivityDetails' ||
    JSON.parse(record.request.body).activityID !== String(id)
  )
    throw new Error('Capture identity mismatch');
  const body = Buffer.from(record.response.bodyBase64, 'base64');
  if (
    body.toString('base64') !== record.response.bodyBase64 ||
    hash(body) !== record.response.bodySha256
  )
    throw new Error('Raw response hash mismatch');
  const input: HttpInput = {
    id,
    status: record.response.status,
    statusText: record.response.statusText,
    headers: record.response.headers,
    body: new TextDecoder('utf-8', { fatal: true }).decode(body),
  };
  return { record, input, recordSha256: hash(bytes) };
}

export async function loadCorpus(directory: string) {
  const manifest: CorpusManifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.version !== 1 ||
    manifest.generatedBy !== 'engage-corpus-builder' ||
    manifest.sourceRange.min !== 0 ||
    manifest.sourceRange.max !== 11000 ||
    manifest.sourceRange.count !== 11001
  )
    throw new Error('Unexpected corpus manifest');
  const cases: { input: InputCase; golden: GoldenCase }[] = [];
  const ids = new Set<number>(),
    groups = new Map<string, string>();
  for (const shard of manifest.shards) {
    if (
      !/^\d{3}\.http\.json\.br$/.test(shard.input) ||
      !/^\d{3}\.expected\.json\.br$/.test(shard.expected)
    )
      throw new Error('Invalid shard path');
    const [inputBytes, expectedBytes] = await Promise.all([
      readFile(join(directory, shard.input)),
      readFile(join(directory, shard.expected)),
    ]);
    if (hash(inputBytes) !== shard.inputSha256 || hash(expectedBytes) !== shard.expectedSha256)
      throw new Error('Corpus shard hash mismatch');
    const inputs: InputCase[] = JSON.parse(brotliDecompressSync(inputBytes).toString());
    const goldens: GoldenCase[] = JSON.parse(brotliDecompressSync(expectedBytes).toString());
    if (inputs.length !== shard.count || goldens.length !== shard.count)
      throw new Error('Corpus shard count mismatch');
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index],
        golden = goldens[index];
      if (
        !input ||
        !golden ||
        input.id !== golden.id ||
        input.response.id !== input.id ||
        !Number.isInteger(input.id) ||
        input.id < 0 ||
        input.id > 11000 ||
        ids.has(input.id) ||
        !['regression', 'validation'].includes(input.partition)
      )
        throw new Error('Corpus ID/partition mismatch');
      if (
        hash(input.response.body) !== input.cleanBodySha256 ||
        hash(JSON.stringify(golden.expected)) !== golden.sha256
      )
        throw new Error('Corpus case hash mismatch');
      const partition = groups.get(input.group);
      if (partition && partition !== input.partition)
        throw new Error('Activity group leaks across partitions');
      groups.set(input.group, input.partition);
      ids.add(input.id);
      cases.push({ input, golden });
    }
  }
  if (cases.length !== 11001 || ids.size !== 11001)
    throw new Error('Corpus coverage is incomplete');
  return { manifest, cases };
}
