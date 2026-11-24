import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { resolveContained } from './paths.js';
import type { Episode, SyncTimeline, SyncTimelineRecord } from './types.js';
import {
  validateMeasuredCueTiming,
  type MeasuredAlignment,
} from './measured-timing.js';

const HASH = /^[a-f0-9]{64}$/;
const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const srtTime = (ms: number): string => {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor(safe / 60_000) % 60;
  const seconds = Math.floor(safe / 1_000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(safe % 1000).padStart(3, '0')}`;
};

export async function validateSyncTimeline(
  episode: Episode,
  root: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const timeline = episode.syncTimeline;
  const errors: string[] = [];
  if (!timeline) return { valid: true, errors: [] };
  if (timeline.version !== 1)
    errors.push('sync timeline version is unsupported');
  if (timeline.status !== 'verified')
    errors.push('sync timeline is not verified');
  if (!HASH.test(timeline.audioSha256))
    errors.push('sync timeline audio hash is invalid');
  if (timeline.audioSha256 !== episode.narration.audioSha256)
    errors.push('sync timeline audio hash is stale');
  if (timeline.alignmentPath !== episode.narration.alignmentPath)
    errors.push('sync timeline alignment path is stale');
  if (timeline.scriptSha256 !== episode.script.sha256)
    errors.push('sync timeline script hash is stale');
  if (
    !Number.isInteger(timeline.audioDurationMs) ||
    timeline.audioDurationMs <= 0
  )
    errors.push('sync timeline duration must be a positive integer');
  if (timeline.audioDurationMs !== episode.narration.audioDurationMs)
    errors.push('sync timeline duration is not bound to narration');
  if (!episode.narration.alignmentVerified)
    errors.push('sync timeline requires verified narration alignment');
  try {
    const audio = await readFile(
      await resolveContained(root, episode.narration.audioPath),
    );
    if (hash(audio) !== timeline.audioSha256)
      errors.push('sync timeline audio bytes do not match audio hash');
  } catch {
    errors.push('sync timeline audio is unavailable or unsafe');
  }
  try {
    const alignmentBytes = await readFile(
      await resolveContained(root, timeline.alignmentPath),
    );
    if (
      (episode.imagePolicy || episode.series?.evolution) &&
      episode.narration.alignmentSha256 !== hash(alignmentBytes)
    )
      errors.push(
        'strict sync timeline requires current alignment evidence hash',
      );
    const alignment = JSON.parse(alignmentBytes.toString('utf8')) as {
      verified?: boolean;
      source?: string;
      audioSha256?: string;
      durationMs?: number;
      transcriptSha256?: string;
    } & MeasuredAlignment;
    if (
      alignment.verified !== true ||
      alignment.source === 'estimated' ||
      alignment.audioSha256 !== timeline.audioSha256 ||
      alignment.durationMs !== timeline.audioDurationMs ||
      alignment.transcriptSha256 !== episode.narration.textSha256
    )
      errors.push('sync timeline alignment evidence is stale or unverified');
    if (
      episode.imagePolicy ||
      episode.series?.evolution ||
      alignment.granularity
    )
      errors.push(...validateMeasuredCueTiming(timeline, alignment));
  } catch {
    errors.push('sync timeline alignment evidence is unavailable or unsafe');
  }
  let scriptText = '';
  try {
    scriptText = await readFile(
      await resolveContained(root, episode.script.path),
      'utf8',
    );
  } catch {
    errors.push('sync timeline script is unavailable or unsafe');
  }
  if (
    !Array.isArray(timeline.records) ||
    timeline.records.length !== episode.shots.length
  )
    errors.push('sync timeline must contain exactly one record per shot');

  const beatById = new Map(
    (episode.beats ?? []).map((beat) => [beat.id, beat]),
  );
  const shotById = new Map(
    (episode.shots ?? []).map((shot) => [shot.id, shot]),
  );
  const cueIds = new Set<string>();
  let previousEnd = 0;
  for (const [index, record] of (timeline.records ?? []).entries()) {
    const prefix = `sync record ${record?.shotId ?? index}`;
    if (!record || typeof record !== 'object') {
      errors.push(`${prefix} is invalid`);
      continue;
    }
    const shot = shotById.get(record.shotId);
    if (!shot) errors.push(`${prefix} references missing shot`);
    if (episode.shots[index]?.id !== record.shotId)
      errors.push(`${prefix} is out of shot order`);
    if (
      !Number.isInteger(record.startMs) ||
      !Number.isInteger(record.endMs) ||
      record.startMs < 0 ||
      record.endMs <= record.startMs
    )
      errors.push(`${prefix} has invalid timestamps`);
    if (
      record.startMs !== shot?.audioStartMs ||
      record.endMs !== shot?.audioEndMs
    )
      errors.push(`${prefix} timing disagrees with canonical shot timing`);
    if (record.startMs !== previousEnd)
      errors.push(`${prefix} has a gap or overlap`);
    previousEnd = record.endMs;
    if (record.endMs > timeline.audioDurationMs)
      errors.push(`${prefix} exceeds audio duration`);
    if (!record.sceneId?.trim()) errors.push(`${prefix} is missing sceneId`);
    if (shot && record.image.sourceShotId !== shot.id)
      errors.push(`${prefix} image sourceShotId does not match shot`);
    if (shot && record.image.path !== shot.image.path)
      errors.push(`${prefix} image path disagrees with shot`);
    if (shot && record.image.sha256 !== shot.image.sha256)
      errors.push(`${prefix} image SHA disagrees with shot`);
    if (shot && record.image.requiredVisualEvent !== shot.requiredVisualEvent)
      errors.push(`${prefix} visual event disagrees with shot`);
    if (
      !record.image?.prompt?.trim() ||
      record.image.promptSha256 !== hash(record.image.prompt)
    )
      errors.push(`${prefix} prompt binding is invalid`);
    if (shot && shot.imagePrompt && shot.imagePrompt !== record.image.prompt)
      errors.push(`${prefix} prompt disagrees with shot binding`);
    if (!HASH.test(record.image.sha256 ?? ''))
      errors.push(`${prefix} image SHA is missing or invalid`);
    if (
      !['pass', 'fail', 'unknown', 'pending'].includes(record.image.pixelReview)
    )
      errors.push(`${prefix} pixel review is invalid`);
    if (record.image.pixelReview !== 'pass')
      errors.push(`${prefix} actual-pixel QA is not passing`);
    if (
      shot &&
      (shot.semanticReview.status !== 'pass' ||
        shot.semanticReview.reviewedImageSha256 !== record.image.sha256)
    )
      errors.push(`${prefix} pixel review is not bound to the image SHA`);
    if (!record.narration || record.narration.timingSource !== 'audio-verified')
      errors.push(`${prefix} narration timing is not audio-verified`);
    if (
      !Number.isInteger(record.narration.scriptStartChar) ||
      !Number.isInteger(record.narration.scriptEndChar) ||
      record.narration.scriptEndChar <= record.narration.scriptStartChar
    )
      errors.push(`${prefix} has an invalid script span`);
    const beatTexts: string[] = [];
    for (const beatId of record.narration.beatIds ?? []) {
      const beat = beatById.get(beatId);
      if (!beat) errors.push(`${prefix} references missing beat ${beatId}`);
      else beatTexts.push(beat.spokenText);
    }
    if (!record.narration.beatIds?.length)
      errors.push(`${prefix} has no narration beats`);
    const mappedBeats = (record.narration.beatIds ?? [])
      .map((id) => beatById.get(id))
      .filter((beat): beat is NonNullable<typeof beat> => Boolean(beat));
    if (
      mappedBeats.length &&
      (record.narration.scriptStartChar !==
        Math.min(...mappedBeats.map((beat) => beat.scriptStartChar)) ||
        record.narration.scriptEndChar !==
          Math.max(...mappedBeats.map((beat) => beat.scriptEndChar)))
    )
      errors.push(`${prefix} script span disagrees with mapped beats`);
    if (
      scriptText &&
      scriptText.slice(
        record.narration.scriptStartChar,
        record.narration.scriptEndChar,
      ) !== record.narration.text
    )
      errors.push(
        `${prefix} narration text does not match the approved script slice`,
      );
    if (
      shot &&
      JSON.stringify(record.narration.beatIds) !== JSON.stringify(shot.beatIds)
    )
      errors.push(`${prefix} beat IDs disagree with shot`);
    if (shot?.image.provenance === undefined)
      errors.push(`${prefix} image provenance is missing`);
    if (
      shot?.referenceBinding &&
      record.image.referenceFreezeSha256 !== shot.referenceBinding.freezeSha256
    )
      errors.push(`${prefix} reference freeze hash is stale`);
    try {
      const image = await readFile(
        await resolveContained(root, record.image.path),
      );
      if (hash(image) !== record.image.sha256)
        errors.push(`${prefix} image bytes do not match image SHA`);
    } catch {
      errors.push(`${prefix} image is unavailable or unsafe`);
    }
    if (normalise(record.narration.text) !== normalise(beatTexts.join(' ')))
      errors.push(`${prefix} narration text disagrees with beat text`);
    for (const cue of record.subtitles ?? []) {
      if (cueIds.has(cue.cueId))
        errors.push(`duplicate subtitle cue ${cue.cueId}`);
      cueIds.add(cue.cueId);
      if (cue.alignmentStatus !== 'verified')
        errors.push(`${prefix} subtitle ${cue.cueId} is not verified`);
      if (
        !Number.isInteger(cue.startMs) ||
        !Number.isInteger(cue.endMs) ||
        cue.startMs < record.startMs ||
        cue.endMs > record.endMs ||
        cue.endMs <= cue.startMs
      )
        errors.push(`${prefix} subtitle ${cue.cueId} has invalid timestamps`);
    }
    const cues = record.subtitles ?? [];
    const captionText = cues
      .map((cue) => cue.text.replace(/\s+/g, ' ').trim())
      .join(' ');
    if (captionText !== record.narration.text.replace(/\s+/g, ' ').trim())
      errors.push(`${prefix} subtitle text does not match narration`);
    if (
      !cues.length ||
      cues[0]!.startMs !== record.startMs ||
      cues.at(-1)!.endMs !== record.endMs ||
      cues.some(
        (cue, cueIndex) =>
          cueIndex > 0 && cue.startMs !== cues[cueIndex - 1]!.endMs,
      )
    )
      errors.push(
        `${prefix} subtitle cues do not continuously cover the narration interval`,
      );
  }
  if (timeline.records?.length && previousEnd !== timeline.audioDurationMs)
    errors.push('sync timeline does not cover full audio duration');
  return { valid: errors.length === 0, errors };
}

export function timelineSrt(timeline: SyncTimeline): string {
  const cues = timeline.records.flatMap((record) => record.subtitles);
  const seen = new Set<string>();
  return `${cues
    .map((cue, index) => {
      if (seen.has(cue.cueId))
        throw new Error(`duplicate subtitle cue ${cue.cueId}`);
      seen.add(cue.cueId);
      return `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`;
    })
    .join('\n')}\n`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export async function writeTimelineReview(
  root: string,
  episode: Episode,
  outputDir = 'output',
): Promise<{ csvPath: string; htmlPath: string; status: string }> {
  const timeline = episode.syncTimeline;
  const records: SyncTimelineRecord[] =
    timeline?.records ??
    episode.shots.map((shot) => ({
      shotId: shot.id,
      sceneId: shot.sceneId ?? 'legacy',
      startMs: shot.audioStartMs,
      endMs: shot.audioEndMs,
      narration: {
        beatIds: shot.beatIds,
        text: episode.beats
          .filter((beat) => shot.beatIds.includes(beat.id))
          .map((beat) => beat.spokenText)
          .join(' '),
        scriptStartChar: 0,
        scriptEndChar: 0,
        timingSource: 'audio-verified',
      },
      image: {
        prompt: shot.imagePrompt ?? '',
        promptSha256: shot.imagePrompt
          ? hash(shot.imagePrompt)
          : ''.padStart(64, '0'),
        requiredVisualEvent: shot.requiredVisualEvent,
        path: shot.image.path,
        sha256: shot.image.sha256,
        sourceShotId: shot.id,
        pixelReview: 'unknown',
      },
      subtitles: [],
      ...(shot.visualPurpose ? { purpose: shot.visualPurpose } : {}),
    }));
  const status = timeline?.status ?? 'legacy-unverified';
  const header = [
    'Time',
    'Shot',
    'Narration',
    'Expected image',
    'Subtitle',
    'QA state',
  ];
  const rows = records.map((record) =>
    [
      `${record.startMs}-${record.endMs}ms`,
      record.shotId,
      record.narration.text,
      record.image.requiredVisualEvent,
      record.subtitles.map((cue) => cue.text).join(' '),
      `${status}/${record.image.pixelReview}`,
    ]
      .map(csvCell)
      .join(','),
  );
  const csv = `${header.map(csvCell).join(',')}\n${rows.join('\n')}\n`;
  const htmlRows = await Promise.all(
    records.map(async (record) => {
      let imageSrc = '';
      try {
        imageSrc = relative(
          dirname(
            await resolveContained(root, `${outputDir}/timeline-review.html`),
          ),
          await resolveContained(root, record.image.path),
        ).replaceAll('\\', '/');
      } catch {
        /* projection remains reviewable */
      }
      return `<tr><td>${escapeHtml(record.shotId)}</td><td>${record.startMs}–${record.endMs}ms</td><td><img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(record.image.requiredVisualEvent)}"><p>${escapeHtml(record.image.requiredVisualEvent)}</p></td><td>${escapeHtml(record.narration.text)}</td><td>${escapeHtml(record.subtitles.map((cue) => cue.text).join(' '))}</td><td>${escapeHtml(`${status}/${record.image.pixelReview}`)}</td></tr>`;
    }),
  );
  const html = `<!doctype html><meta charset="utf-8"><title>Timeline review</title><style>body{font:14px system-ui}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;vertical-align:top}img{max-width:240px;max-height:135px;background:#111}</style><h1>Timeline review</h1><p>Status: ${escapeHtml(status)}. Images require actual-pixel inspection.</p><table><thead><tr>${header.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${htmlRows.join('')}</tbody></table>`;
  const csvPath = `${outputDir}/timeline-review.csv`;
  const htmlPath = `${outputDir}/timeline-review.html`;
  await mkdir(await resolveContained(root, outputDir), { recursive: true });
  await writeFile(await resolveContained(root, csvPath), csv, 'utf8');
  await writeFile(await resolveContained(root, htmlPath), html, 'utf8');
  return { csvPath, htmlPath, status };
}

export async function validateAndWriteTimelineReview(
  root: string,
  episode: Episode,
): Promise<{
  validation: { valid: boolean; errors: string[] };
  csvPath: string;
  htmlPath: string;
  status: string;
}> {
  const validation = await validateSyncTimeline(episode, root);
  const projection = await writeTimelineReview(root, episode);
  return { validation, ...projection };
}
