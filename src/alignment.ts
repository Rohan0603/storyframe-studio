import type { Episode } from './types.js';

export const CINEMATIC_DENSITY = { targetMin: 14, targetMax: 18 } as const;

export function densityPerMinute(
  shotCount: number,
  durationMs: number,
): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return (shotCount * 60_000) / durationMs;
}

export function validateAlignment(
  episode: Episode,
  scriptText: string | null,
): string[] {
  const errors: string[] = [];
  const plan = episode.alignment;
  const shots = Array.isArray(episode.shots) ? episode.shots : [];
  const beats = Array.isArray(episode.beats) ? episode.beats : [];
  if (!plan)
    return shots.length ? ['alignment plan is required when shots exist'] : [];
  if (!/^[a-f0-9]{64}$/.test(plan.scriptSha256))
    errors.push('alignment script hash is invalid');
  if (!['provisional', 'verified'].includes(plan.timingStatus))
    errors.push('alignment timing status is invalid');
  if (plan.scriptSha256 !== episode.script.sha256)
    errors.push('alignment is stale for the approved script hash');
  if (
    episode.story &&
    plan.scriptRevisionId !== episode.story.scriptRevision.id
  )
    errors.push('alignment is stale for the approved script revision');
  if (
    episode.story &&
    plan.scriptRevisionSha256 !== episode.story.scriptRevision.textSha256
  )
    errors.push(
      'alignment is stale for the approved normalized script revision hash',
    );
  if (
    plan.timingStatus === 'verified' &&
    (!Number.isInteger(plan.audioDurationMs) ||
      (plan.audioDurationMs ?? 0) <= 0)
  )
    errors.push('verified alignment requires a positive audio duration');
  if (
    plan.timingStatus === 'provisional' &&
    episode.narration.alignmentVerified
  )
    errors.push(
      'narration cannot be verified while shot timing is provisional',
    );
  if (plan.timingStatus !== 'verified' && episode.release.productionQAPassed)
    errors.push('production QA cannot pass with provisional shot timing');
  if (
    !Number.isFinite(plan.density.targetMin) ||
    !Number.isFinite(plan.density.targetMax) ||
    plan.density.targetMin < 0 ||
    plan.density.targetMax < plan.density.targetMin
  )
    errors.push('density target is invalid');

  const beatById = new Map(beats.map((beat) => [beat.id, beat]));
  let previousBeatEnd = 0;
  for (const beat of beats) {
    if (typeof beat.spokenText !== 'string' || !beat.spokenText.trim())
      errors.push(`beat ${beat.id} has empty spoken text`);
    if (shots.length && (!beat.scriptRevisionId || !beat.scriptRevisionSha256))
      errors.push(`beat ${beat.id} is missing script revision binding`);
    if (
      episode.story &&
      beat.scriptRevisionId !== episode.story.scriptRevision.id
    )
      errors.push(`beat ${beat.id} has an invalid script revision`);
    if (beat.scriptStartChar < previousBeatEnd)
      errors.push(`beat order overlaps at ${beat.id}`);
    previousBeatEnd = Math.max(previousBeatEnd, beat.scriptEndChar);
    if (
      plan.scriptRevisionId &&
      beat.scriptRevisionId &&
      beat.scriptRevisionId !== plan.scriptRevisionId
    )
      errors.push(`beat ${beat.id} belongs to a different script revision`);
    if (
      beat.scriptRevisionSha256 &&
      beat.scriptRevisionSha256 !== plan.scriptSha256
    )
      errors.push(`beat ${beat.id} has a stale script hash`);
    if (
      episode.story &&
      beat.scriptRevisionSha256 !== episode.story.scriptRevision.textSha256
    )
      errors.push(
        `beat ${beat.id} is not bound to the approved normalized script revision`,
      );
    if (
      scriptText !== null &&
      scriptText.slice(beat.scriptStartChar, beat.scriptEndChar) !==
        beat.spokenText
    )
      errors.push(`beat ${beat.id} spoken span is not bound to the script`);
  }

  const seenShotIds = new Set<string>();
  let previousEnd = 0;
  for (const shot of shots) {
    if (!shot || !Array.isArray(shot.beatIds)) {
      errors.push('shot has an invalid beat mapping');
      continue;
    }
    if (seenShotIds.has(shot.id)) errors.push(`duplicate shot ID: ${shot.id}`);
    seenShotIds.add(shot.id);
    if (
      !Number.isInteger(shot.audioStartMs) ||
      !Number.isInteger(shot.audioEndMs)
    )
      errors.push(`shot ${shot.id} timing must use integer milliseconds`);
    if (shot.audioStartMs < previousEnd)
      errors.push(`shot order overlaps at ${shot.id}`);
    if (shot.audioStartMs > previousEnd)
      errors.push(`unplanned timing gap before ${shot.id}`);
    previousEnd = shot.audioEndMs;
    if (plan.audioDurationMs !== null && shot.audioEndMs > plan.audioDurationMs)
      errors.push(`shot ${shot.id} exceeds audio duration`);
    if (!shot.requiredVisualEvent.trim())
      errors.push(`shot ${shot.id} has no visual event`);
    if (!shot.visualPurpose)
      errors.push(`shot ${shot.id} has no visual purpose`);
    if (
      shot.visualPurpose === 'hold' &&
      (!shot.intentionalHold?.reason.trim() ||
        shot.intentionalHold.relatedBeatIds.length === 0)
    )
      errors.push(
        `shot ${shot.id} hold is not intentional or related to a beat`,
      );
    if (shot.visualPurpose !== 'hold' && shot.intentionalHold)
      errors.push(`shot ${shot.id} has hold metadata but is not a hold`);
    if (shot.beatIds.some((id) => !beatById.has(id)))
      errors.push(`shot ${shot.id} references a missing beat`);
    if (
      shot.visualPurpose === 'hold' &&
      shot.intentionalHold &&
      shot.intentionalHold.relatedBeatIds.some(
        (id) => !shot.beatIds.includes(id),
      )
    )
      errors.push(`shot ${shot.id} hold beats must be mapped on the shot`);
    if (!shot.environment.trim())
      errors.push(`shot ${shot.id} requires a location`);
  }
  for (const beat of beats) {
    if (!shots.some((shot) => shot.beatIds.includes(beat.id)))
      errors.push(`beat ${beat.id} has no mapped shot`);
  }
  if (
    plan.timingStatus === 'verified' &&
    shots.length &&
    previousEnd !== plan.audioDurationMs
  )
    errors.push('verified shot plan does not cover the full audio duration');
  return errors;
}

export function storyboardMarkdown(episode: Episode): string {
  const lines = [
    '# Storyboard',
    '',
    `Script hash: ${episode.alignment?.scriptSha256 ?? episode.script.sha256}`,
    '',
  ];
  for (const shot of episode.shots) {
    lines.push(
      `## ${shot.id} (${shot.audioStartMs}-${shot.audioEndMs}ms)`,
      '',
      `- Beats: ${shot.beatIds.join(', ')}`,
      `- Purpose: ${shot.visualPurpose ?? 'unspecified'}`,
      `- Event: ${shot.requiredVisualEvent}`,
      `- Characters: ${shot.characters.join(', ') || 'none'}`,
      `- Props: ${shot.props.join(', ') || 'none'}`,
      `- Location: ${shot.environment}`,
      '',
    );
  }
  return lines.join('\n');
}

export function densityNote(episode: Episode): string {
  const plan = episode.alignment;
  if (!plan || plan.audioDurationMs === null)
    return 'Still density is provisional until verified audio duration is available.';
  const rate = densityPerMinute(episode.shots.length, plan.audioDurationMs);
  return `Planned density: ${rate.toFixed(2)} stills/minute; target ${plan.density.targetMin}-${plan.density.targetMax}. Every shot must retain a meaningful event.`;
}
