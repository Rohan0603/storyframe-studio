import type { SyncTimeline } from './types.js';

interface TimingUnit {
  text: string;
  startMs: number;
  endMs: number;
}

export interface MeasuredAlignment {
  granularity?: 'word' | 'phrase';
  wordEvidence?: 'token-aligned' | 'manual-reviewed' | 'group-count-only';
  source?: string;
  evidenceNotes?: string;
  words?: Array<{ word: string; startMs: number; endMs: number }>;
  phrases?: TimingUnit[];
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Match each cue to a consecutive, non-reused measured unit range.
 * Cuts may fall in the silence between adjacent measured units, with at
 * most one 30fps frame of rounding error; never inside another spoken unit.
 */
export function validateMeasuredCueTiming(
  timeline: SyncTimeline,
  alignment: MeasuredAlignment,
): string[] {
  if (
    !['provider', 'manual'].includes(alignment.source ?? '') ||
    !alignment.evidenceNotes?.trim()
  )
    return ['measured alignment requires source and evidence notes'];
  if (
    alignment.granularity === 'word' &&
    !['token-aligned', 'manual-reviewed'].includes(alignment.wordEvidence ?? '')
  )
    return [
      'verified word alignment requires lexical token mapping or manual review',
    ];
  const units =
    alignment.granularity === 'phrase'
      ? alignment.phrases
      : alignment.granularity === 'word'
        ? alignment.words?.map(({ word, startMs, endMs }) => ({
            text: word,
            startMs,
            endMs,
          }))
        : undefined;
  if (!units?.length)
    return ['measured alignment requires explicit word or phrase units'];
  let previousEnd = 0;
  for (const unit of units) {
    if (
      typeof unit.text !== 'string' ||
      !normalize(unit.text) ||
      !Number.isInteger(unit.startMs) ||
      !Number.isInteger(unit.endMs) ||
      unit.startMs < previousEnd ||
      unit.endMs <= unit.startMs ||
      unit.endMs > timeline.audioDurationMs
    )
      return ['measured alignment contains invalid or overlapping intervals'];
    previousEnd = unit.endMs;
  }
  const errors: string[] = [];
  const tolerance = 34;
  let cursor = 0;
  for (const record of timeline.records) {
    for (const cue of record.subtitles) {
      const wanted = normalize(cue.text);
      const first = cursor;
      let joined = '';
      while (cursor < units.length && joined.length < wanted.length) {
        joined = normalize(joined + ' ' + units[cursor]!.text);
        cursor += 1;
        if (!wanted.startsWith(joined)) break;
      }
      if (joined !== wanted || cursor === first) {
        errors.push(
          `subtitle ${cue.cueId} does not match consecutive measured speech`,
        );
        return errors;
      }
      const speechStart = units[first]!.startMs;
      const speechEnd = units[cursor - 1]!.endMs;
      const left = first === 0 ? 0 : units[first - 1]!.endMs;
      const right =
        cursor === units.length
          ? timeline.audioDurationMs
          : units[cursor]!.startMs;
      if (
        cue.startMs < left - tolerance ||
        cue.startMs > speechStart + tolerance ||
        cue.endMs < speechEnd - tolerance ||
        cue.endMs > right + tolerance
      )
        errors.push(
          `subtitle ${cue.cueId} timing disagrees with measured speech boundaries`,
        );
    }
  }
  if (cursor !== units.length)
    errors.push('measured speech units are not fully covered by subtitle cues');
  return errors;
}
