import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveContained } from './paths.js';
import { isStableId } from './ids.js';
import {
  validateCanon,
  validateClaimLedger,
  validateScriptRevision,
} from './story-layer.js';
import type { Episode, ValidationResult } from './types.js';

const HASH = /^[a-f0-9]{64}$/;
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function addId(
  errors: string[],
  seen: Set<string>,
  id: unknown,
  label: string,
): void {
  if (!isStableId(id)) errors.push(`${label} must be a stable ID`);
  else if (seen.has(id)) errors.push(`duplicate ID: ${id}`);
  else seen.add(id);
}

async function verifyFile(
  root: string,
  path: string,
  expected: string,
  label: string,
  errors: string[],
): Promise<void> {
  try {
    const file = await resolveContained(root, path);
    const actual = sha256(await readFile(file));
    if (!HASH.test(expected) || actual !== expected)
      errors.push(`${label} hash mismatch`);
  } catch (error) {
    errors.push(
      `${label} path is unsafe or unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function validateEpisode(
  episode: Episode,
  root: string,
): Promise<ValidationResult> {
  const errors: string[] = [];
  if (!episode || typeof episode !== 'object')
    return { valid: false, errors: ['episode must be an object'] };
  if (!Array.isArray(episode.beats)) errors.push('beats must be an array');
  if (!Array.isArray(episode.shots)) errors.push('shots must be an array');
  if (!episode.narration || typeof episode.narration !== 'object')
    errors.push('narration is required');
  if (!episode.release || typeof episode.release !== 'object')
    errors.push('release is required');
  if (episode?.schemaVersion !== 1)
    errors.push('unsupported schemaVersion; expected 1');
  const ids = new Set<string>();
  addId(errors, ids, episode?.episodeId, 'episodeId');
  if (!episode || !['guided', 'auto'].includes(episode.mode))
    errors.push('mode must be guided or auto');
  if (!HASH.test(episode?.script?.sha256 ?? ''))
    errors.push('script.sha256 must be a SHA-256');
  if (!HASH.test(episode?.referenceBundle?.sha256 ?? ''))
    errors.push('referenceBundle.sha256 must be a SHA-256');
  if (!HASH.test(episode?.narration?.textSha256 ?? ''))
    errors.push('narration.textSha256 must be a SHA-256');
  if (episode?.script)
    await verifyFile(
      root,
      episode.script.path,
      episode.script.sha256,
      'script',
      errors,
    );
  if (episode?.referenceBundle)
    await verifyFile(
      root,
      episode.referenceBundle.path,
      episode.referenceBundle.sha256,
      'reference bundle',
      errors,
    );
  if (episode?.narration) {
    for (const [label, path] of [
      ['narration audio', episode.narration.audioPath],
      ['narration alignment', episode.narration.alignmentPath],
    ] as const) {
      try {
        await resolveContained(root, path);
      } catch (error) {
        errors.push(
          `${label} path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (episode?.story) {
    try {
      if (
        !episode.story.scriptRevision ||
        !Array.isArray(episode.story.sourceClaims) ||
        !episode.story.canon ||
        !Array.isArray(episode.story.beatCandidates)
      )
        throw new Error('required story fields are missing');
      errors.push(...validateScriptRevision(episode.story.scriptRevision));
      const claims = validateClaimLedger(episode.story.sourceClaims, {
        factualRelease: episode.release?.productionQAPassed === true,
      });
      errors.push(...claims.errors);
      errors.push(...validateCanon(episode.story.canon).errors);
      for (const candidate of episode.story.beatCandidates) {
        addId(errors, ids, candidate.id, 'beat candidate ID');
        if (
          !Number.isInteger(candidate.scriptStartChar) ||
          !Number.isInteger(candidate.scriptEndChar) ||
          candidate.scriptStartChar < 0 ||
          candidate.scriptEndChar < candidate.scriptStartChar ||
          candidate.scriptEndChar > episode.story.scriptRevision.text.length
        )
          errors.push(`invalid script span for beat candidate ${candidate.id}`);
        else if (
          episode.story.scriptRevision.text.slice(
            candidate.scriptStartChar,
            candidate.scriptEndChar,
          ) !== candidate.spokenText
        )
          errors.push(
            `spoken text mismatch for beat candidate ${candidate.id}`,
          );
        for (const claimId of candidate.sourceClaimIds)
          if (!episode.story.sourceClaims.some((claim) => claim.id === claimId))
            errors.push(
              `beat candidate ${candidate.id} references missing claim ${claimId}`,
            );
      }
    } catch (error) {
      errors.push(
        `story section is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const beat of episode?.beats ?? []) {
    addId(errors, ids, beat.id, 'beat ID');
    if (
      !Number.isInteger(beat.scriptStartChar) ||
      !Number.isInteger(beat.scriptEndChar) ||
      beat.scriptStartChar < 0 ||
      beat.scriptEndChar < beat.scriptStartChar
    )
      errors.push(`invalid script span for ${beat.id}`);
  }
  const shotIds = new Set<string>();
  for (const shot of episode?.shots ?? []) {
    addId(errors, shotIds, shot.id, 'shot ID');
    if (shot.audioEndMs <= shot.audioStartMs || shot.audioStartMs < 0)
      errors.push(`invalid audio range for ${shot.id}`);
    if (!shot.requiredVisualEvent?.trim() || shot.beatIds.length === 0)
      errors.push(`shot ${shot.id} requires a visual event and beat`);
    for (const beatId of shot.beatIds)
      if (!(episode.beats ?? []).some((beat) => beat.id === beatId))
        errors.push(`shot ${shot.id} references missing beat ${beatId}`);
    if (shot.image.sha256 !== null && !HASH.test(shot.image.sha256))
      errors.push(`invalid image hash for ${shot.id}`);
    try {
      await resolveContained(root, shot.image.path);
    } catch (error) {
      errors.push(
        `image path is unsafe for ${shot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (shot.image.sha256 !== null)
      await verifyFile(
        root,
        shot.image.path,
        shot.image.sha256,
        `image ${shot.id}`,
        errors,
      );
    if (
      shot.semanticReview.status === 'pass' &&
      shot.semanticReview.reviewedImageSha256 !== shot.image.sha256
    )
      errors.push(`review hash is not bound to image for ${shot.id}`);
  }
  return { valid: errors.length === 0, errors };
}
