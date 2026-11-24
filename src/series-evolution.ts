import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveContained } from './paths.js';
import { isStableId } from './ids.js';
import { canonHash, validateReferenceBible } from './reference-bible.js';
import type {
  Episode,
  ReferenceBible,
  SeriesConfiguration,
  Shot,
} from './types.js';

const HASH = /^[a-f0-9]{64}$/;

export interface EvolutionState {
  id: string;
  fromEpisode: number;
  fromShot: number;
  fromBeatId?: string;
  scriptRevisionSha256?: string;
  referenceId: string;
  referenceSha256: string;
  visualCanon: string;
  changeReason: string;
  /** Explicit state transition; the first canonical state has no predecessor. */
  supersedesStateId?: string;
}

export interface EvolutionEntity {
  entityId: string;
  kind: 'character' | 'prop' | 'environment';
  states: EvolutionState[];
}

export interface SeriesEvolution {
  version: 1;
  seriesId: string;
  throughEpisode?: number;
  episodeId?: string;
  entities: EvolutionEntity[];
}

export function validateEvolutionShape(value: SeriesEvolution): string[] {
  const errors: string[] = [];
  if (
    !value ||
    value.version !== 1 ||
    !isStableId(value.seriesId) ||
    !Array.isArray(value.entities) ||
    value.entities.length === 0
  ) {
    return [
      'series evolution has an invalid version, series ID or entity list',
    ];
  }
  const entityIds = new Set<string>();
  for (const entity of value.entities) {
    if (
      !entity ||
      !isStableId(entity.entityId) ||
      !['character', 'prop', 'environment'].includes(entity.kind) ||
      !Array.isArray(entity.states) ||
      !entity.states.length
    ) {
      errors.push(
        'series evolution has an invalid entity or empty state history',
      );
      continue;
    }
    if (entityIds.has(entity.entityId))
      errors.push('duplicate series evolution entity ' + entity.entityId);
    entityIds.add(entity.entityId);
    const states = new Set<string>();
    const images = new Set<string>();
    const referenceIds = new Set<string>();
    let previousPosition = -1;
    for (const state of entity.states) {
      if (
        !state ||
        !isStableId(state.id) ||
        !isStableId(state.referenceId) ||
        !HASH.test(state.referenceSha256) ||
        typeof state.visualCanon !== 'string' ||
        !state.visualCanon.trim() ||
        typeof state.changeReason !== 'string' ||
        !state.changeReason.trim() ||
        !Number.isSafeInteger(state.fromEpisode) ||
        state.fromEpisode < 1 ||
        !Number.isSafeInteger(state.fromShot) ||
        state.fromShot < 0 ||
        state.fromShot > 100000
      ) {
        errors.push('invalid series visual state for ' + entity.entityId);
        continue;
      }
      if (states.size > 0 && !isStableId(state.supersedesStateId))
        errors.push(
          'non-initial visual state must identify the state it supersedes',
        );
      if (state.supersedesStateId && !states.has(state.supersedesStateId))
        errors.push(
          'visual state supersession must reference an earlier state',
        );
      // The pair forms a sortable absolute position, and an episode cannot exceed 100000 shots.
      const position = state.fromEpisode * 100001 + state.fromShot;
      if (position <= previousPosition)
        errors.push(
          'series visual states must be strictly chronological for ' +
            entity.entityId,
        );
      previousPosition = position;
      if (states.has(state.id))
        errors.push('duplicate visual state ' + state.id);
      states.add(state.id);
      if (
        referenceIds.has(state.referenceId) ||
        images.has(state.referenceSha256)
      )
        errors.push(
          'visual state change reuses a retired reference for ' +
            entity.entityId,
        );
      referenceIds.add(state.referenceId);
      images.add(state.referenceSha256);
    }
  }
  return errors;
}

export async function loadSeriesEvolution(
  root: string,
  config: SeriesConfiguration,
): Promise<{ evolution: SeriesEvolution | null; errors: string[] }> {
  if (!config.evolution) return { evolution: null, errors: [] };
  const errors: string[] = [];
  const binding = config.evolution;
  if (
    !HASH.test(binding.sha256) ||
    !Number.isSafeInteger(binding.episodeOrder) ||
    binding.episodeOrder < 1
  )
    errors.push('series evolution has invalid episode order or hash');
  let evolution: SeriesEvolution;
  try {
    const bytes = await readFile(await resolveContained(root, binding.path));
    if (createHash('sha256').update(bytes).digest('hex') !== binding.sha256)
      errors.push('series evolution snapshot hash mismatch');
    evolution = JSON.parse(bytes.toString('utf8')) as SeriesEvolution;
  } catch {
    return {
      evolution: null,
      errors: [...errors, 'series evolution snapshot is missing or unsafe'],
    };
  }
  errors.push(...validateEvolutionShape(evolution));
  if (evolution?.seriesId !== config.seriesId)
    errors.push('series evolution belongs to another series');
  if (!config.applied)
    errors.push(
      'series evolution cannot be used while series.applied is false',
    );
  return { evolution, errors };
}

export function activeEvolutionState(
  entity: EvolutionEntity,
  episodeOrder: number,
  shotIndex: number,
): EvolutionState | undefined {
  // An earlier episode keeps its frozen state even after a future transition.
  return entity.states
    .filter(
      (state) =>
        state.fromEpisode < episodeOrder ||
        (state.fromEpisode === episodeOrder && state.fromShot <= shotIndex),
    )
    .at(-1);
}

export function validateShotEvolution(
  evolution: SeriesEvolution,
  episodeOrder: number,
  shot: Shot,
  shotIndex: number,
): string[] {
  const errors: string[] = [];
  const required = new Map<string, EvolutionEntity>();
  for (const entity of evolution.entities) {
    if (
      shot.characters.includes(entity.entityId) ||
      shot.props.includes(entity.entityId) ||
      shot.environment === entity.entityId
    )
      required.set(entity.entityId, entity);
  }
  const bindings = shot.seriesBinding?.entityStates ?? {};
  for (const [entityId, entity] of required) {
    const state = activeEvolutionState(entity, episodeOrder, shotIndex);
    if (!state) {
      errors.push(`shot ${shot.id} has no active visual state for ${entityId}`);
      continue;
    }
    if (bindings[entityId] !== state.id)
      errors.push(
        `shot ${shot.id} uses stale or premature visual state for ${entityId}: expected ${state.id}`,
      );
    const reference = shot.referenceBinding;
    if (
      !reference?.referenceIds.includes(state.referenceId) ||
      reference.referenceHashes[state.referenceId] !== state.referenceSha256
    )
      errors.push(
        `shot ${shot.id} does not bind the active ${entityId} reference ${state.referenceId}`,
      );
    for (const obsolete of entity.states) {
      if (
        obsolete.id !== state.id &&
        reference?.referenceIds.includes(obsolete.referenceId)
      )
        errors.push(
          `shot ${shot.id} reuses retired or future ${entityId} reference ${obsolete.referenceId}`,
        );
    }
  }
  for (const entityId of Object.keys(bindings)) {
    if (!required.has(entityId))
      errors.push(
        `shot ${shot.id} has an unneeded/unknown visual state binding for ${entityId}`,
      );
  }
  return errors;
}

/** Complete, versioned episode history. A predecessor is an archived,
 * hash-bound prior episode manifest, not just an arbitrary current state.
 * A legacy migration is explicit and requires reviewed baseline notes.
 */
export interface ValidatedEpisodeEvolution {
  evolution: SeriesEvolution;
  snapshotSha256: string;
  episodeOrder: number;
}

export async function loadEpisodeEvolution(
  root: string,
  episode: Episode,
): Promise<ValidatedEpisodeEvolution> {
  const series = episode.series;
  const config = series?.evolution;
  if (!series || !config) throw new Error('series evolution is required');
  const loaded = await loadSeriesEvolution(root, series);
  if (!loaded.evolution || loaded.errors.length)
    throw new Error(loaded.errors.join('; '));
  const evolution = loaded.evolution;
  if (
    evolution.throughEpisode !== config.episodeOrder ||
    evolution.episodeId !== episode.episodeId
  )
    throw new Error('series evolution must identify its current episode order');
  const prior = config.predecessor;
  if (config.episodeOrder > 1 && !prior)
    throw new Error(
      'series evolution requires its approved predecessor snapshot',
    );
  if (prior) {
    const readBound = async (path: string, sha: string): Promise<Buffer> => {
      const bytes = await readFile(await resolveContained(root, path));
      if (createHash('sha256').update(bytes).digest('hex') !== sha)
        throw new Error('series predecessor evidence hash mismatch');
      return bytes;
    };
    const previous = JSON.parse(
      (await readBound(prior.path, prior.sha256)).toString('utf8'),
    ) as SeriesEvolution;
    const manifest = JSON.parse(
      (await readBound(prior.manifestPath, prior.manifestSha256)).toString(
        'utf8',
      ),
    ) as Episode;
    if (
      manifest.schemaVersion !== 1 ||
      !manifest.script ||
      !manifest.referenceBundle
    )
      throw new Error(
        'series predecessor manifest is missing canonical inputs',
      );
    for (const [label, file] of [
      ['script', manifest.script],
      ['reference bundle', manifest.referenceBundle],
    ] as const) {
      const bytes = await readFile(await resolveContained(root, file.path));
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        throw new Error(`series predecessor ${label} hash mismatch`);
    }
    if (!Array.isArray(manifest.shots) || manifest.shots.length === 0)
      throw new Error('series predecessor has no canonical shots');
    if (
      manifest.series?.evolution &&
      manifest.referenceBible?.status !== 'frozen'
    )
      throw new Error('series predecessor has no frozen reference bible');
    let bible: ReferenceBible | null = null;
    if (manifest.referenceBible) {
      const bibleBytes = await readFile(
        await resolveContained(root, manifest.referenceBible.path),
      );
      if (
        createHash('sha256').update(bibleBytes).digest('hex') !==
        manifest.referenceBible.sha256
      )
        throw new Error('series predecessor reference bible hash mismatch');
      bible = JSON.parse(bibleBytes.toString('utf8')) as ReferenceBible;
      const expected = manifest.story
        ? {
            storyRevisionId: manifest.story.scriptRevision.id,
            storyRevisionSha256: manifest.story.scriptRevision.textSha256,
            canonSha256: canonHash(manifest.story.canon),
            canon: manifest.story.canon,
          }
        : undefined;
      const bibleValidation = await validateReferenceBible(
        root,
        bible,
        expected,
      );
      if (!bibleValidation.valid)
        throw new Error(
          'series predecessor reference bible is invalid: ' +
            bibleValidation.errors.join('; '),
        );
    }
    const bibleEntries = new Map(
      bible?.entries.map((entry) => [entry.id, entry]) ?? [],
    );
    for (const [shotIndex, shot] of manifest.shots.entries()) {
      if (shot.image.status !== 'approved')
        throw new Error(`series predecessor shot ${shot.id} is not approved`);
      if (
        shot.semanticReview.status !== 'pass' ||
        shot.semanticReview.reviewedImageSha256 !== shot.image.sha256 ||
        !shot.semanticReview.notes.trim() ||
        !shot.referenceBinding
      )
        throw new Error(
          `series predecessor shot ${shot.id} lacks bound visual review evidence`,
        );
      if (manifest.series?.evolution && !shot.referenceBinding)
        throw new Error(`series predecessor shot ${shot.id} lacks references`);
      for (const referenceId of shot.referenceBinding?.referenceIds ?? []) {
        const entry = bibleEntries.get(referenceId);
        if (
          !entry ||
          shot.referenceBinding!.referenceHashes[referenceId] !==
            entry.image.sha256
        )
          throw new Error(
            `series predecessor shot ${shot.id} has a stale reference binding`,
          );
      }
      if (manifest.series?.evolution) {
        const stateErrors = validateShotEvolution(
          previous,
          previous.throughEpisode!,
          shot,
          shotIndex,
        );
        if (stateErrors.length)
          throw new Error(
            `series predecessor shot ${shot.id} has invalid state bindings: ${stateErrors.join('; ')}`,
          );
      }
      if (manifest.imagePolicy?.requireVisualScreening) {
        const evidence = shot.semanticReview.pixelEvidence;
        if (!evidence)
          throw new Error(
            `series predecessor shot ${shot.id} lacks pixel evidence`,
          );
        const evidenceBytes = await readFile(
          await resolveContained(root, evidence.path),
        );
        if (
          createHash('sha256').update(evidenceBytes).digest('hex') !==
          evidence.sha256
        )
          throw new Error(
            `series predecessor shot ${shot.id} pixel evidence hash mismatch`,
          );
        const pixel = JSON.parse(evidenceBytes.toString('utf8')) as {
          shotId?: string;
          imageSha256?: string;
          requiredVisualEvent?: string;
          characters?: string[];
          props?: string[];
          environment?: string;
          packetSha256?: string;
          pixelsDecoded?: boolean;
          requiredActionPresent?: boolean;
          requiredCharactersPresent?: boolean;
          requiredPropsPresent?: boolean;
          continuityMatches?: boolean;
          forbiddenTextPresent?: boolean;
          staleReferences?: boolean;
          notes?: string;
          referenceFreezeSha256?: string;
          reviewedBy?: string;
        };
        if (
          pixel.shotId !== shot.id ||
          pixel.imageSha256 !== shot.image.sha256 ||
          pixel.requiredVisualEvent !== shot.requiredVisualEvent ||
          JSON.stringify(pixel.characters) !==
            JSON.stringify(shot.characters) ||
          JSON.stringify(pixel.props) !== JSON.stringify(shot.props) ||
          pixel.environment !== shot.environment ||
          pixel.packetSha256 !== shot.image.provenance?.packetSha256 ||
          pixel.pixelsDecoded !== true ||
          pixel.requiredActionPresent !== true ||
          pixel.requiredCharactersPresent !== true ||
          pixel.requiredPropsPresent !== true ||
          pixel.continuityMatches !== true ||
          pixel.forbiddenTextPresent === true ||
          pixel.staleReferences === true ||
          !pixel.notes?.trim() ||
          (manifest.referenceBible &&
            pixel.referenceFreezeSha256 !==
              manifest.referenceBible.freezeSha256) ||
          !pixel.reviewedBy?.trim()
        )
          throw new Error(
            `series predecessor shot ${shot.id} pixel evidence is not bound to its contract`,
          );
      }
      const bytes = await readFile(
        await resolveContained(root, shot.image.path),
      );
      if (
        createHash('sha256').update(bytes).digest('hex') !== shot.image.sha256
      )
        throw new Error(
          `series predecessor shot ${shot.id} image hash mismatch`,
        );
    }
    if (
      validateEvolutionShape(previous).length ||
      previous.seriesId !== series.seriesId ||
      previous.throughEpisode !== config.episodeOrder - 1 ||
      previous.episodeId !== manifest.episodeId ||
      !manifest.release?.productionQAPassed
    )
      throw new Error('series predecessor is not an approved prior episode');
    if (manifest.series?.evolution) {
      if (
        manifest.series.seriesId !== series.seriesId ||
        manifest.series.evolution.episodeOrder !== previous.throughEpisode ||
        manifest.series.evolution.sha256 !== prior.sha256
      )
        throw new Error(
          'series predecessor snapshot is not anchored to prior manifest',
        );
    } else if (!prior.legacyMigrationNotes?.trim()) {
      throw new Error(
        'legacy series predecessor requires reviewed migration baseline',
      );
    }
    for (const old of previous.entities) {
      const current = evolution.entities.find(
        (entity) => entity.entityId === old.entityId,
      );
      if (
        !current ||
        current.kind !== old.kind ||
        JSON.stringify(current.states.slice(0, old.states.length)) !==
          JSON.stringify(old.states)
      )
        throw new Error(
          'series predecessor history was removed or rewritten: ' +
            old.entityId,
        );
      if (
        current.states
          .slice(old.states.length)
          .some((state) => state.fromEpisode !== config.episodeOrder)
      )
        throw new Error('series evolution cannot backdate a new state');
    }
    for (const entity of evolution.entities) {
      if (
        !previous.entities.some((old) => old.entityId === entity.entityId) &&
        entity.states.some((state) => state.fromEpisode !== config.episodeOrder)
      )
        throw new Error(
          'new series entity cannot be backdated: ' + entity.entityId,
        );
    }
  }
  for (const [kind, roster] of [
    ['character', episode.story?.canon.characters ?? []],
    ['prop', episode.story?.canon.props ?? []],
  ] as const) {
    for (const item of roster)
      if (
        !evolution.entities.some(
          (entity) => entity.entityId === item.id && entity.kind === kind,
        )
      )
        throw new Error('series snapshot omits a canonical entity: ' + item.id);
  }
  for (const entity of evolution.entities) {
    for (const state of entity.states) {
      if (state.fromEpisode > config.episodeOrder)
        throw new Error('series snapshot contains a future episode state');
      if (state.fromEpisode !== config.episodeOrder) continue;
      const transitionShot = episode.shots[state.fromShot];
      if (
        !transitionShot ||
        !state.fromBeatId ||
        !transitionShot.beatIds.includes(state.fromBeatId) ||
        episode.shots.findIndex((shot) =>
          shot.beatIds.includes(state.fromBeatId!),
        ) !== state.fromShot ||
        state.scriptRevisionSha256 !== episode.story?.scriptRevision.textSha256
      )
        throw new Error(
          'series state has a stale or missing story-beat transition: ' +
            state.id,
        );
    }
  }
  return {
    evolution,
    snapshotSha256: config.sha256,
    episodeOrder: config.episodeOrder,
  };
}

/** The generation and manifest gates use the same state resolver. */
export function validateResolvedShotEvolution(
  episode: Episode,
  shot: Shot,
  validated: ValidatedEpisodeEvolution,
  bible: ReferenceBible,
): string[] {
  const errors: string[] = [];
  const config = episode.series?.evolution;
  if (
    !config ||
    validated.snapshotSha256 !== config.sha256 ||
    validated.episodeOrder !== config.episodeOrder ||
    validated.evolution.seriesId !== episode.series?.seriesId
  )
    return ['shot requires the current validated series evolution snapshot'];
  const index = episode.shots.findIndex((item) => item.id === shot.id);
  if (index < 0) return ['shot is not in the authoritative episode'];
  const required = [
    ...shot.characters.map((id) => ({ id, kind: 'character' })),
    ...shot.props.map((id) => ({ id, kind: 'prop' })),
    { id: shot.environment, kind: 'environment' },
  ];
  const allowed = new Set<string>();
  for (const { id, kind } of required) {
    const entity = validated.evolution.entities.find(
      (item) => item.entityId === id,
    );
    if (!entity || entity.kind !== kind) {
      errors.push(
        `shot ${shot.id} is missing tracked ${kind} history for ${id}`,
      );
      continue;
    }
    const state = activeEvolutionState(entity, validated.episodeOrder, index);
    if (!state) continue;
    allowed.add(state.referenceId);
    const entry = bible.entries.find((item) => item.id === state.referenceId);
    if (
      !entry ||
      entry.kind !== entity.kind ||
      entry.canonEntityId !== id ||
      entry.visualCanon !== state.visualCanon ||
      entry.image.sha256 !== state.referenceSha256 ||
      !entry.image.approved
    )
      errors.push(
        `shot ${shot.id} active reference does not match entity, kind, canon and hash for ${id}`,
      );
  }
  for (const id of shot.referenceBinding?.referenceIds ?? []) {
    const entry = bible.entries.find((item) => item.id === id);
    if (entry?.kind !== 'style' && !allowed.has(id))
      errors.push(
        `shot ${shot.id} binds an obsolete or unrelated visual reference ${id}`,
      );
  }
  return [
    ...errors,
    ...validateShotEvolution(
      validated.evolution,
      validated.episodeOrder,
      shot,
      index,
    ),
  ];
}
