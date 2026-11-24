import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveContained } from './paths.js';
import { isStableId } from './ids.js';
import {
  validateCanon,
  validateClaimLedger,
  validateNarrativePlan,
  validateScriptRevision,
} from './story-layer.js';
import type { Episode, ValidationResult } from './types.js';
import { validateAlignment } from './alignment.js';
import { canonHash, validateReferenceBible } from './reference-bible.js';
import { readPersistedImage } from './image-generation.js';
import { validateSyncTimeline } from './sync.js';
import {
  loadSeriesEvolution,
  validateShotEvolution,
} from './series-evolution.js';
import type { SeriesEvolution } from './series-evolution.js';

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
  let scriptText: string | null = null;
  if (!episode || typeof episode !== 'object')
    return { valid: false, errors: ['episode must be an object'] };
  if (!Array.isArray(episode.beats)) errors.push('beats must be an array');
  if (!Array.isArray(episode.shots)) errors.push('shots must be an array');
  if (!episode.narration || typeof episode.narration !== 'object')
    errors.push('narration is required');
  if (
    !episode.release ||
    typeof episode.release !== 'object' ||
    Array.isArray(episode.release) ||
    typeof episode.release.productionQAPassed !== 'boolean' ||
    !(
      episode.release.creativeApproval === null ||
      typeof episode.release.creativeApproval === 'string'
    ) ||
    !(
      episode.release.publishAuthorization === null ||
      typeof episode.release.publishAuthorization === 'string'
    )
  )
    errors.push('release is required and has an invalid shape');
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
  let seriesEvolution: SeriesEvolution | null = null;
  if (episode?.series) {
    const series = episode.series;
    if (!isStableId(series.seriesId))
      errors.push('series.seriesId must be a stable ID');
    if (!isStableId(series.revisionId))
      errors.push('series.revisionId must be a stable ID');
    if (!HASH.test(series.bibleSha256))
      errors.push('series.bibleSha256 must be a SHA-256');
    if (!['2d-still', '3d-still'].includes(series.visualFormat))
      errors.push('series.visualFormat must be 2d-still or 3d-still');
    if (typeof series.applied !== 'boolean')
      errors.push('series.applied must be boolean');
    if (series.evolution) {
      const loaded = await loadSeriesEvolution(root, series);
      errors.push(...loaded.errors);
      if (loaded.errors.length === 0) seriesEvolution = loaded.evolution;
    }
    await verifyFile(
      root,
      series.biblePath,
      series.bibleSha256,
      'series bible',
      errors,
    );
    if (
      series.applied &&
      (!episode.story || episode.referenceBible?.status !== 'frozen')
    )
      errors.push(
        'applied series configuration requires story canon and a frozen reference bible',
      );
  }
  if (
    episode.imagePolicy &&
    (episode.imagePolicy.width !== 1920 ||
      episode.imagePolicy.height !== 1080 ||
      typeof episode.imagePolicy.requireNativeReceipt !== 'boolean' ||
      typeof episode.imagePolicy.requireVisualScreening !== 'boolean')
  )
    errors.push('imagePolicy must define 1920x1080 and both QA switches');
  if (!HASH.test(episode?.narration?.textSha256 ?? ''))
    errors.push('narration.textSha256 must be a SHA-256');
  if (
    episode?.narration?.audioSha256 !== undefined &&
    !HASH.test(episode.narration.audioSha256)
  )
    errors.push('narration.audioSha256 must be a SHA-256');
  if (
    episode?.narration?.audioDurationMs !== undefined &&
    (!Number.isInteger(episode.narration.audioDurationMs) ||
      episode.narration.audioDurationMs <= 0)
  )
    errors.push('narration.audioDurationMs must be a positive integer');
  if (episode?.script)
    await verifyFile(
      root,
      episode.script.path,
      episode.script.sha256,
      'script',
      errors,
    );
  if (episode?.script) {
    try {
      scriptText = await readFile(
        await resolveContained(root, episode.script.path),
        'utf8',
      );
    } catch {
      scriptText = null;
    }
  }
  if (episode?.referenceBundle)
    await verifyFile(
      root,
      episode.referenceBundle.path,
      episode.referenceBundle.sha256,
      'reference bundle',
      errors,
    );
  let loadedReferenceBible: Awaited<
    ReturnType<typeof validateReferenceBible>
  > | null = null;
  let referenceIds = new Set<string>();
  let referenceHashes = new Map<string, string>();
  if (episode?.referenceBible) {
    try {
      const biblePath = await resolveContained(
        root,
        episode.referenceBible.path,
      );
      const bibleBytes = await readFile(biblePath);
      if (sha256(bibleBytes) !== episode.referenceBible.sha256)
        errors.push('reference bible manifest hash mismatch');
      const parsed = JSON.parse(bibleBytes.toString('utf8')) as Parameters<
        typeof validateReferenceBible
      >[1];
      const expected = episode.story
        ? {
            storyRevisionId: episode.story.scriptRevision.id,
            storyRevisionSha256: episode.story.scriptRevision.textSha256,
            canonSha256: canonHash(episode.story.canon),
            canon: episode.story.canon,
          }
        : {};
      loadedReferenceBible = await validateReferenceBible(
        root,
        parsed,
        expected,
      );
      errors.push(...loadedReferenceBible.errors);
      if (
        loadedReferenceBible.freezeSha256 !==
        episode.referenceBible.freezeSha256
      )
        errors.push('reference bible freeze hash mismatch');
      if (episode.referenceBible.status === 'stale')
        errors.push('reference bible is explicitly stale');
      if (
        episode.referenceBible.storyRevisionId !== parsed.storyRevisionId ||
        episode.referenceBible.storyRevisionSha256 !==
          parsed.storyRevisionSha256 ||
        episode.referenceBible.canonSha256 !== parsed.canonSha256
      )
        errors.push(
          'reference bible manifest binding does not match its bundle',
        );
      referenceIds = new Set(parsed.entries.map((entry) => entry.id));
      referenceHashes = new Map(
        parsed.entries.map((entry) => [entry.id, entry.image.sha256]),
      );
      if (
        episode.referenceBible.status === 'frozen' &&
        !loadedReferenceBible.valid
      )
        errors.push('frozen reference bible is invalid');
    } catch (error) {
      errors.push(
        `reference bible is unsafe or unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (episode.shots?.some((shot) => shot.referenceBinding)) {
    errors.push('shot reference bindings require a reference bible');
  }
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
    if (episode.narration.audioSha256) {
      try {
        const audio = await resolveContained(root, episode.narration.audioPath);
        if (sha256(await readFile(audio)) !== episode.narration.audioSha256)
          errors.push('narration audio hash mismatch');
      } catch (error) {
        errors.push(
          `narration audio is unsafe or unavailable: ${error instanceof Error ? error.message : String(error)}`,
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
      if (episode.story.narrativePlan)
        errors.push(
          ...validateNarrativePlan(episode.story.narrativePlan).map(
            (error) => `narrative plan: ${error}`,
          ),
        );
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
  for (const beat of Array.isArray(episode?.beats) ? episode.beats : []) {
    if (!beat || typeof beat !== 'object') {
      errors.push('beat must be an object');
      continue;
    }
    addId(errors, ids, beat.id, 'beat ID');
    if (
      !Number.isInteger(beat.scriptStartChar) ||
      !Number.isInteger(beat.scriptEndChar) ||
      beat.scriptStartChar < 0 ||
      beat.scriptEndChar < beat.scriptStartChar
    )
      errors.push(`invalid script span for ${beat.id}`);
    if (
      Number.isInteger(beat.scriptStartChar) &&
      Number.isInteger(beat.scriptEndChar) &&
      beat.scriptStartChar >= 0 &&
      scriptText !== null &&
      beat.scriptEndChar <= scriptText.length &&
      scriptText.slice(beat.scriptStartChar, beat.scriptEndChar) !==
        beat.spokenText
    )
      errors.push(`spoken text mismatch for beat ${beat.id}`);
    if (episode.story) {
      if (beat.scriptRevisionId !== episode.story.scriptRevision.id)
        errors.push(`beat ${beat.id} has an invalid script revision ID`);
      if (beat.scriptRevisionSha256 !== episode.story.scriptRevision.textSha256)
        errors.push(`beat ${beat.id} has an invalid script revision hash`);
    }
    if (
      scriptText !== null &&
      (beat.scriptEndChar > scriptText.length ||
        beat.scriptStartChar > scriptText.length)
    )
      errors.push(`invalid script span for beat ${beat.id}`);
    if (episode?.story)
      for (const claimId of beat.sourceClaimIds ?? [])
        if (!episode.story.sourceClaims.some((claim) => claim.id === claimId))
          errors.push(`beat ${beat.id} references missing claim ${claimId}`);
  }
  const shotIds = new Set<string>();
  for (const [shotIndex, shot] of (Array.isArray(episode?.shots)
    ? episode.shots
    : []
  ).entries()) {
    if (!shot || typeof shot !== 'object') {
      errors.push('shot must be an object');
      continue;
    }
    if (!Array.isArray(shot.beatIds) || !shot.image || !shot.semanticReview) {
      errors.push(`shot ${shot.id ?? 'unknown'} has an invalid shape`);
      continue;
    }
    addId(errors, shotIds, shot.id, 'shot ID');
    if (
      !Number.isFinite(shot.audioStartMs) ||
      !Number.isFinite(shot.audioEndMs) ||
      shot.audioEndMs <= shot.audioStartMs ||
      shot.audioStartMs < 0
    )
      errors.push(`invalid audio range for ${shot.id}`);
    if (
      typeof shot.requiredVisualEvent !== 'string' ||
      !shot.requiredVisualEvent.trim() ||
      shot.beatIds.length === 0 ||
      !Array.isArray(shot.characters) ||
      !Array.isArray(shot.props) ||
      !Array.isArray(shot.forbidden) ||
      typeof shot.environment !== 'string' ||
      !shot.environment.trim() ||
      typeof shot.composition !== 'string' ||
      !shot.composition.trim()
    )
      errors.push(`shot ${shot.id} requires a visual event and beat`);
    for (const beatId of shot.beatIds)
      if (
        !Array.isArray(episode.beats) ||
        !episode.beats.some(
          (beat) => beat && typeof beat === 'object' && beat.id === beatId,
        )
      )
        errors.push(`shot ${shot.id} references missing beat ${beatId}`);
    if (shot.image.sha256 !== null && !HASH.test(shot.image.sha256))
      errors.push(`invalid image hash for ${shot.id}`);
    const imageStatuses = [
      'pending',
      'ready',
      'running',
      'needs-review',
      'approved',
      'rejected',
      'blocked',
      'failed',
      'stale',
    ];
    if (!imageStatuses.includes(shot.image.status))
      errors.push(`invalid image status for ${shot.id}`);
    if (shot.image.sha256 !== null) {
      const provenance = shot.image.provenance;
      if (!provenance) errors.push(`image ${shot.id} is missing provenance`);
      else {
        if (
          provenance.tool !== 'codex-desktop.image_gen' ||
          !HASH.test(provenance.packetSha256) ||
          !provenance.attemptId.trim()
        )
          errors.push(`image ${shot.id} has invalid provenance identity`);
        if (
          !['persisted', 'reconciled'].includes(provenance.receiptStatus) ||
          !Number.isInteger(provenance.width) ||
          !Number.isInteger(provenance.height) ||
          provenance.width < 1 ||
          provenance.height < 1
        )
          errors.push(
            `image ${shot.id} has invalid provenance receipt or dimensions`,
          );
        if (
          episode.imagePolicy?.requireNativeReceipt &&
          !provenance.nativeReceiptId?.trim()
        )
          errors.push(
            `image ${shot.id} lacks a genuine native provider receipt ID`,
          );
        if (provenance.nativeImage) {
          const native = provenance.nativeImage;
          if (
            !HASH.test(native.sha256) ||
            native.width < 1 ||
            native.height < 1
          )
            errors.push(`image ${shot.id} has invalid native image provenance`);
          else
            await verifyFile(
              root,
              native.path,
              native.sha256,
              `native image ${shot.id}`,
              errors,
            );
        }
      }
    }
    if (
      !['pending', 'pass', 'fail', 'unknown'].includes(
        shot.semanticReview.status,
      )
    )
      errors.push(`invalid semantic review status for ${shot.id}`);
    if (
      shot.semanticReview.status === 'pass' &&
      shot.semanticReview.pixelsDecoded !== true
    )
      errors.push(
        `passing semantic review requires decoded pixels for ${shot.id}`,
      );
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
    if (shot.image.sha256 !== null) {
      try {
        const inspected = await readPersistedImage(root, shot.image.path);
        if (inspected.sha256 !== shot.image.sha256)
          errors.push(`image ${shot.id} decode hash mismatch`);
        if (
          episode.imagePolicy &&
          (inspected.width !== episode.imagePolicy.width ||
            inspected.height !== episode.imagePolicy.height)
        )
          errors.push(`image ${shot.id} must be normalized to 1920x1080`);
        if (!shot.image.provenance)
          errors.push(`image ${shot.id} is missing generation provenance`);
        else if (
          shot.image.provenance.width !== inspected.width ||
          shot.image.provenance.height !== inspected.height
        )
          errors.push(`image ${shot.id} provenance dimensions mismatch`);
      } catch (error) {
        errors.push(
          `image ${shot.id} cannot be decoded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      episode.imagePolicy?.requireVisualScreening &&
      shot.image.sha256 !== null
    ) {
      const screening = shot.semanticReview.screening;
      if (
        !screening ||
        screening.imageSha256 !== shot.image.sha256 ||
        screening.collage !== 'clear' ||
        screening.text !== 'clear' ||
        !screening.checkedBy?.trim() ||
        !screening.notes?.trim()
      )
        errors.push(
          `image ${shot.id} has unresolved collage or visual-text screening`,
        );
    }
    if (
      shot.semanticReview.status === 'pass' &&
      (shot.image.sha256 === null ||
        shot.semanticReview.reviewedImageSha256 !== shot.image.sha256 ||
        shot.semanticReview.pixelsDecoded !== true ||
        !shot.semanticReview.notes.trim())
    )
      errors.push(`review hash is not bound to image for ${shot.id}`);
    if (episode.story) {
      const characters = new Set(
        episode.story.canon.characters.map((entity) => entity.id),
      );
      const props = new Set(
        episode.story.canon.props.map((entity) => entity.id),
      );
      for (const id of Array.isArray(shot.characters) ? shot.characters : [])
        if (!characters.has(id))
          errors.push(`shot ${shot.id} references unknown character ${id}`);
      for (const id of Array.isArray(shot.props) ? shot.props : [])
        if (!props.has(id))
          errors.push(`shot ${shot.id} references unknown prop ${id}`);
    }
    if (shot.referenceBinding) {
      const binding = shot.referenceBinding;
      if (
        !Array.isArray(binding.referenceIds) ||
        binding.referenceIds.length === 0 ||
        !binding.referenceHashes ||
        typeof binding.referenceHashes !== 'object'
      )
        errors.push(`shot ${shot.id} has an invalid reference binding`);
      if (
        !Array.isArray(binding.referenceIds) ||
        binding.referenceIds.length === 0 ||
        !binding.referenceHashes ||
        typeof binding.referenceHashes !== 'object'
      )
        errors.push(`shot ${shot.id} has an invalid reference binding`);
      if (
        !loadedReferenceBible ||
        loadedReferenceBible.freezeSha256 !== binding.freezeSha256
      )
        errors.push(`shot ${shot.id} has a stale reference freeze hash`);
      if (
        episode.story &&
        binding.storyRevisionId !== episode.story.scriptRevision.id
      )
        errors.push(`shot ${shot.id} has a stale reference story revision`);
      for (const id of binding.referenceIds ?? []) {
        if (!referenceIds.has(id))
          errors.push(
            `shot ${shot.id} references unknown visual reference ${id}`,
          );
        if (binding.referenceHashes?.[id] !== referenceHashes.get(id))
          errors.push(
            `shot ${shot.id} has a stale visual reference hash for ${id}`,
          );
      }
      if (
        shot.semanticReview.status === 'pass' &&
        errors.some((error) => error.includes(`shot ${shot.id} has a stale`))
      )
        errors.push(`approved visual review is stale for ${shot.id}`);
      if (loadedReferenceBible?.valid) {
        for (const required of [
          ...shot.characters,
          ...shot.props,
          shot.environment,
        ]) {
          const tracked = seriesEvolution?.entities.some(
            (entity) => entity.entityId === required,
          );
          if (!tracked && !binding.referenceIds.includes(required))
            errors.push(
              `shot ${shot.id} is missing required visual reference ${required}`,
            );
        }
      }
    } else if (episode.referenceBible?.status === 'frozen') {
      errors.push(`shot ${shot.id} is missing a frozen reference binding`);
    }
    if (seriesEvolution && episode.series?.evolution) {
      errors.push(
        ...validateShotEvolution(
          seriesEvolution,
          episode.series.evolution.episodeOrder,
          shot,
          shotIndex,
        ),
      );
    }
    if (episode.series?.applied) {
      if (!shot.seriesBinding)
        errors.push(`shot ${shot.id} is missing a series binding`);
      else if (
        shot.seriesBinding.seriesId !== episode.series.seriesId ||
        shot.seriesBinding.revisionId !== episode.series.revisionId
      )
        errors.push(`shot ${shot.id} has a stale series binding`);
    }
  }
  if (episode.alignment !== undefined) {
    try {
      if (
        !episode.alignment ||
        typeof episode.alignment !== 'object' ||
        !episode.alignment.density
      )
        throw new Error('alignment has an invalid shape');
      errors.push(...validateAlignment(episode, scriptText));
    } catch (error) {
      errors.push(
        `alignment is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (Array.isArray(episode.shots) && episode.shots.length > 0) {
    errors.push('alignment plan is required when shots exist');
  }
  if (episode.syncTimeline !== undefined) {
    try {
      errors.push(...(await validateSyncTimeline(episode, root)).errors);
    } catch (error) {
      errors.push(
        `sync timeline is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { valid: errors.length === 0, errors };
}
