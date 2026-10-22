import type { Activity, StaffDirectory } from '../../src/domain/activity.ts';

export interface RawCapture {
  schemaVersion: 1;
  id: number;
  request: { method: string; path: string; body: string };
  response: {
    capturedAt: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    setCookie: string[];
    bodyBase64: string;
    bodySha256: string;
  };
}
export interface HttpInput {
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}
export interface SourceField {
  fID: string | null;
  fData?: string | boolean | null;
  fType?: number;
  lParms?: { key: string; val?: string | null; [key: string]: unknown }[] | null;
  [key: string]: unknown;
}
export interface SourceRow {
  rID: string;
  fields: SourceField[];
}
export interface SourceBody {
  isError?: boolean;
  newRows: SourceRow[];
  [key: string]: unknown;
}
export type Expected =
  | { kind: 'activity'; activity: Activity; staffDirectory: StaffDirectory }
  | { kind: 'upstream-error'; code: 'UPSTREAM_UNAVAILABLE'; status: 503; sourceMessage: string }
  | { kind: 'empty-form' }
  | { kind: 'missing' };
export interface InputCase {
  id: number;
  partition: 'regression' | 'validation';
  group: string;
  sourceBodySha256: string;
  cleanBodySha256: string;
  features: string[];
  response: HttpInput;
}
export interface GoldenCase {
  id: number;
  sha256: string;
  expected: Expected;
}
export interface CorpusManifest {
  version: 1;
  generatedBy: 'engage-corpus-builder';
  sourceManifestSha256: string;
  sourceRange: { min: number; max: number; count: number };
  generatedAt: string;
  oracleSha256: string;
  reviewedAliasesSha256: string;
  sanitization: string[];
  counts: Record<string, number>;
  partitions: Record<string, number>;
  coverage: Record<string, Record<string, number>>;
  shards: {
    input: string;
    inputSha256: string;
    expected: string;
    expectedSha256: string;
    count: number;
  }[];
}
