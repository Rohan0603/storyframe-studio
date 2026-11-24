import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveContained } from './paths.js';
import { isStableId } from './ids.js';
import type { SeriesConfiguration, Shot } from './types.js';

const HASH = /^[a-f0-9]{64}$/;

export interface EvolutionState {
  id: string;
  fromEpisode: number;
  fromShot: number;
  referenceId: string;
  referenceSha256: string;
  visualCanon: string;
  changeReason: string;
}

export interface EvolutionEntity {
  entityId: string;
  kind: 'character' | 'prop' | 'environment';
  states: EvolutionState[];
}

export interface SeriesEvolution {
  version: 1;
  seriesId: string;
  entities: EvolutionEntity[];
}

export function validateEvolutionShape(value: SeriesEvolution): string[] {
  const errors: string[] = [];
  if (
    !value ||
    value.version !== 1 ||
    !isStableId(value.seriesId) ||
    !Array.isArray(value.entities)
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
