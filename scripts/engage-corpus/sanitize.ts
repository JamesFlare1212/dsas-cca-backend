import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { HttpInput, SourceBody, SourceField } from './model.ts';
import {
  captions,
  decodeSource,
  excludedStaff,
  sourceCaption,
  sourceList,
  sourceText,
} from './oracle.ts';

const gradeTokens =
  /(?<![A-Za-z0-9])(?:KG|G|Grades?|Years?)\s*\d+(?:\s*[-–—−~～至]\s*(?:(?:KG|G|Grades?|Years?)\s*)?\d*)?/gi;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const genericNames = new Set([
  'none',
  'null',
  'unknown',
  'staff',
  'student',
  'test',
  'teacher',
  'error',
  'name',
  'n/a',
]);
const isAscii = (value: string) =>
  [...value].every((character) => (character.codePointAt(0) ?? 0) < 128);

const referenceControls = new Set([
  'academicyear',
  'schedule',
  'category',
  'yeargroup',
  'day',
  'start',
  'end',
  'site',
  'block',
  'room',
  'runsfrom',
  'runsto',
  'linkedperiod',
]);
export function assertReferencesPreserved(original: HttpInput, cleaned: HttpInput): void {
  const references = (input: HttpInput) =>
    decodeSource(input).newRows.map((row) => ({
      rowId: row.rID,
      fields: row.fields
        .filter((field) => referenceControls.has(field.fID?.toLowerCase() ?? ''))
        .map((field) => ({
          id: field.fID,
          value: field.fData,
          options: field.lParms?.map((option) => ({ key: option.key, val: option.val })),
        })),
    }));
  if (!isDeepStrictEqual(references(original), references(cleaned)))
    throw new Error('Cleaning changed source references or location/time values');
}

export class Sanitizer {
  private readonly people = new Map<string, string>();
  private pattern: RegExp | undefined;
  constructor(
    private readonly seed: Uint8Array,
    private readonly image: string,
  ) {}
  token(kind: string, value: string): string {
    return `${kind}-${createHmac('sha256', this.seed).update(value.trim()).digest('hex').slice(0, 16)}`;
  }
  private addPerson(value: string | null, kind: string) {
    for (const name of sourceList(value)) {
      if (
        name.length >= (isAscii(name) ? 3 : 2) &&
        !genericNames.has(name.toLowerCase()) &&
        !this.people.has(name)
      )
        this.people.set(name, this.token(kind, name));
    }
  }
  observe(source: SourceBody) {
    for (const row of source.newRows) {
      const first = sourceCaption(row);
      if (first === 'Student Leader Name(s)') this.addPerson(sourceText(row.fields[1]), 'Student');
      if (first === 'Name To Appear On Reports')
        this.addPerson(sourceText(row.fields[1]), 'Teacher');
      for (const field of row.fields)
        if (field.fID === 'staff') {
          this.addPerson(sourceText(field), 'Teacher');
          for (const option of field.lParms ?? []) this.addPerson(option.val ?? null, 'Teacher');
        }
    }
  }
  seal() {
    const patterns = [...this.people.keys()]
      .sort((a, b) => b.length - a.length)
      .map((name) => {
        const escaped = escapeRegex(name);
        return isAscii(name) ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped;
      });
    this.pattern = patterns.length ? new RegExp(patterns.join('|'), 'g') : undefined;
  }
  private text(value: string): string {
    return (
      this.pattern
        ? value.replace(this.pattern, (name) => this.people.get(name) ?? 'Person')
        : value
    )
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, 'contact@example.test')
      .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, 'PHONE_REDACTED')
      .replace(/https?:\/\/[^\s<>"']+/g, 'https://example.test/resource');
  }
  private staffKey(key: string): string {
    return excludedStaff.has(key.replace(/^ID:\s*/i, '')) ? key : this.token('T', key);
  }
  private peopleList(value: string, kind: string): string {
    return value
      .split(/(,\s*|\r?\n)/)
      .map((part, index) => (index % 2 || !part.trim() ? part : this.token(kind, part)))
      .join('');
  }
  private prose(value: string): string {
    if (!value.trim()) return value;
    // Opaque free text can contain people not listed in the directory. Retain
    // paragraph/tag/whitespace shape, but never publish the original text nodes.
    return value
      .split(/(<[^>]*>|\r?\n)/g)
      .map((part) => {
        if (/^\r?\n$/.test(part) || !part.trim()) return part;
        if (part.startsWith('<')) {
          const tag = /^<(\/?)(br|p|div|span|ul|ol|li|b|strong|i|em|a)\b[^>]*>/i.exec(part);
          return tag ? `<${tag[1]}${tag[2]?.toLowerCase()}>` : '<span>';
        }
        return 'Corpus content 中文内容';
      })
      .join('');
  }
  private title(value: string, id: number): string {
    if (!value.trim()) return value;
    const grades = [...value.matchAll(gradeTokens)].map((match) => match[0]).join(' ');
    const led = /student[\s-]led/i.test(value)
      ? 'student-led'
      : value.includes('学生社团')
        ? '学生社团'
        : /[（(]SL[）)]/.test(value)
          ? '(SL)'
          : '';
    return `Corpus Club 社团 ${id} ${grades} ${led}`.trim();
  }
  group(input: HttpInput): string {
    const source = decodeSource(input);
    const title = source.newRows
      .flatMap((row) => row.fields)
      .find((field) => field.fID === 'activityname');
    if (!title?.fData || source.isError) return this.token('group', `negative:${input.id}`);
    const canonical = String(title.fData)
      .normalize('NFKC')
      .toLowerCase()
      .replace(gradeTokens, '')
      .replace(/student[\s-]led|学生社团|\(sl\)/g, '')
      .replace(/[\s().,_-]/g, '');
    return this.token('group', canonical);
  }
  clean(input: HttpInput): HttpInput {
    const source = decodeSource(input);
    const rows = source.newRows.map((row) => ({
      rID: row.rID,
      fields: row.fields.map((field, index): SourceField => {
        const caption = sourceCaption(row);
        const role =
          index === 1 && caption && Object.hasOwn(captions, caption)
            ? captions[caption]
            : undefined;
        const id = field.fID?.toLowerCase();
        const isCaption =
          index === 0 || (field.fID === null && [2, 4, 5, 6, 50, 62].includes(field.fType ?? -1));
        let value = field.fData;
        if (typeof value === 'string') {
          if (id === 'activityname') value = this.title(value, input.id);
          else if (
            role === 'description' ||
            role === 'descriptionZh' ||
            role === 'poorWeatherPlan' ||
            role === 'semesterCost'
          )
            value = this.prose(value);
          else if (role === 'studentLeaders') value = this.peopleList(value, 'Student');
          else if (id === 'staff' || role === 'staffForReports')
            value = this.peopleList(value, 'Teacher');
          else if (role === 'photo' || id === 'photo')
            value = value
              ? /^data:/i.test(value)
                ? this.image
                : 'https://images.example.test/fixture.png'
              : value;
          else if (isCaption || id === 'error') value = this.text(value);
          else if (referenceControls.has(id ?? '') || id === '1') value = this.text(value);
          else value = value ? 'Fixture control' : value;
        }
        const clean: SourceField = { fID: field.fID, fData: value };
        if (field.fType !== undefined) clean.fType = field.fType;
        for (const key of [
          'readOnly',
          'disabled',
          'fSize',
          'fStyle',
          'columnSet',
          'subSet',
          'subColumn',
        ]) {
          if (typeof field[key] === 'boolean' || typeof field[key] === 'number')
            clean[key] = field[key];
        }
        if (field.lParms !== undefined)
          clean.lParms =
            field.lParms?.map((option) => ({
              key: id === 'staff' ? this.staffKey(option.key) : this.text(option.key),
              ...(option.val !== undefined
                ? {
                    val:
                      typeof option.val === 'string'
                        ? id === 'staff' && option.val
                          ? this.token('Teacher', option.val)
                          : this.text(option.val)
                        : option.val,
                  }
                : {}),
            })) ?? null;
        return clean;
      }),
    }));
    const body = JSON.stringify({
      d: JSON.stringify({
        ...('isError' in source ? { isError: source.isError } : {}),
        newRows: rows,
        ...('PupilIDsLookup' in source ? { PupilIDsLookup: {} } : {}),
      }),
    });
    return {
      id: input.id,
      status: input.status,
      statusText: input.statusText,
      headers: [
        ['content-type', 'application/json; charset=utf-8'],
        ['content-length', String(Buffer.byteLength(body))],
      ],
      body,
    };
  }
  assertPrivateDataRemoved(input: HttpInput) {
    if (this.pattern) {
      this.pattern.lastIndex = 0;
      const matched = this.pattern.test(input.body);
      this.pattern.lastIndex = 0;
      if (matched) throw new Error('Private name survived sanitization');
    }
    if (/set-cookie|authorization|loginControl\$txtPwd/i.test(JSON.stringify(input.headers)))
      throw new Error('Sensitive header survived');
    if (/data:image\//i.test(input.body)) {
      const decoded = decodeSource(input);
      for (const row of decoded.newRows)
        for (const field of row.fields) {
          if (
            typeof field.fData === 'string' &&
            /^data:/i.test(field.fData) &&
            field.fData !== this.image
          )
            throw new Error('Original image survived');
        }
    }
  }
}
