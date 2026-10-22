import type { Expected, HttpInput } from './model.ts';
import { decodeSource, sourceCaption, sourceText } from './oracle.ts';

export function sourceFeatures(input: HttpInput, expected: Expected): string[] {
  const features: string[] = [expected.kind];
  if (expected.kind !== 'activity') return features;
  const activity = expected.activity;
  features.push(`year:${activity.academicYear}`);
  if (activity.meetings.length > 1) features.push('multiple-meetings');
  if (activity.descriptionZh?.trim()) {
    features.push('chinese-description');
    // Activity.description may already be the Chinese fallback, so inspect the
    // original English control before calling this a bilingual source example.
    let english: string | null = null;
    for (const row of decodeSource(input).newRows) {
      for (const field of row.fields)
        if (field.fID?.toLowerCase() === 'description') english = sourceText(field);
      if (sourceCaption(row) === 'Description') english = sourceText(row.fields[1]);
    }
    features.push(english?.trim() ? 'bilingual' : 'chinese-only');
  }
  if (activity.isPreSignup) features.push('pre-signup');
  if (activity.isStudentLed) features.push('student-led');
  if (/^\d+$/.test(activity.schedule ?? '')) features.push('orphan-schedule');
  if (/KG\d/i.test(activity.schedule ?? '')) features.push('kindergarten');
  return features;
}
