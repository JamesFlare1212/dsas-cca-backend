import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash, readCapture } from './engage-corpus/io.ts';
import { deriveExpected } from './engage-corpus/oracle.ts';
import { verifyCase } from './engage-corpus/verify.ts';

const directory = resolve(process.env.RAW_CORPUS_DIR ?? 'data/engage-corpus/raw');
const bytes = await readFile(join(directory, 'manifest.json'));
const manifest = JSON.parse(bytes.toString());
if (!manifest.complete || manifest.completed !== 11001)
  throw new Error('Raw capture is incomplete');
const results: { id: number; kind?: string; bodySha256?: string; ok: boolean; error?: string }[] =
  [];
for (let id = 0; id <= 11000; id++) {
  try {
    const { record, input } = await readCapture(directory, id);
    const indexed = manifest.entries[id];
    if (indexed.id !== id || indexed.bodySha256 !== record.response.bodySha256)
      throw new Error('Raw manifest mismatch');
    const expected = deriveExpected(input);
    await verifyCase(input, expected, false);
    results.push({ id, kind: expected.kind, bodySha256: record.response.bodySha256, ok: true });
  } catch (error) {
    results.push({
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  if ((id + 1) % 1000 === 0)
    console.log(
      JSON.stringify({ checked: id + 1, failed: results.filter((row) => !row.ok).length }),
    );
}
const failed = results.filter((row) => !row.ok).length;
await writeFile(
  resolve('data/engage-corpus/raw-verification.json'),
  JSON.stringify(
    {
      sourceManifestSha256: hash(bytes),
      checked: results.length,
      failed,
      results,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(JSON.stringify({ checked: results.length, failed }));
if (failed) process.exitCode = 1;
