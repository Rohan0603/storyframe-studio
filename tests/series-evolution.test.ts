import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeEvolutionState,
  loadSeriesEvolution,
  validateEvolutionShape,
  validateShotEvolution,
  type SeriesEvolution,
} from '../src/series-evolution.js';
import type { Shot } from '../src/types.js';

const ragged = 'a'.repeat(64);
const wealthy = 'b'.repeat(64);
const empty = 'c'.repeat(64);
const gold = 'd'.repeat(64);

const evolution: SeriesEvolution = {
  version: 1,
  seriesId: 'series-journey',
  entities: [
    {
      entityId: 'hero', kind: 'character',
      states: [
        { id: 'ragged', fromEpisode: 1, fromShot: 0,
          referenceId: 'hero-ragged', referenceSha256: ragged,
          visualCanon: 'Threadbare coat and torn shoes', changeReason: 'Story opening' },
        { id: 'wealthy', fromEpisode: 3, fromShot: 2,
          referenceId: 'hero-wealthy', referenceSha256: wealthy,
          visualCanon: 'New suit and polished shoes', changeReason: 'Found gold' },
      ],
    },
    {
      entityId: 'satchel', kind: 'prop',
      states: [
        { id: 'empty', fromEpisode: 1, fromShot: 0,
          referenceId: 'satchel-empty', referenceSha256: empty,
          visualCanon: 'Empty worn leather bag', changeReason: 'Starts without gold' },
        { id: 'gold-filled', fromEpisode: 3, fromShot: 1,
          referenceId: 'satchel-gold', referenceSha256: gold,
          visualCanon: 'Leather bag bulging with gold', changeReason: 'Finds treasure' },
      ],
    },
  ],
};

function shot(
  states: Record<string, string>,
  refs: Record<string, string>,
): Shot {
  return {
    id: 'shot-test',
    beatIds: ['beat-test'],
    audioStartMs: 0, audioEndMs: 1000,
    requiredVisualEvent: 'Hero holds a leather bag',
    characters: ['hero'], props: ['satchel'], environment: 'forest',
    composition: 'medium', forbidden: [],
    image: { path: 'images/shot-test.png', sha256: null, status: 'pending' },
    semanticReview: { status: 'pending', reviewedImageSha256: null, notes: '' },
    seriesBinding: {
      seriesId: 'series-journey', revisionId: 'series-v1', entityStates: states,
    },
    referenceBinding: {
      freezeSha256: 'e'.repeat(64), storyRevisionId: 'rev-one',
      referenceIds: Object.keys(refs),
      referenceHashes: refs,
    },
  };
}

describe('time-versioned series references', () => {
  it('keeps the hero ragged until the exact transition shot', () => {
    expect(validateEvolutionShape(evolution)).toEqual([]);
    const hero = evolution.entities[0]!;
    expect(activeEvolutionState(hero, 1, 0)?.id).toBe('ragged');
    expect(activeEvolutionState(hero, 3, 1)?.id).toBe('ragged');
    expect(activeEvolutionState(hero, 3, 2)?.id).toBe('wealthy');
    expect(activeEvolutionState(hero, 4, 0)?.id).toBe('wealthy');
  });

  it('accepts ragged early and wealthy later, with the correct prop state', () => {
    const early = shot(
      { hero: 'ragged', satchel: 'empty' },
      { 'hero-ragged': ragged, 'satchel-empty': empty },
    );
    expect(validateShotEvolution(evolution, 1, early, 0)).toEqual([]);

    const later = shot(
      { hero: 'wealthy', satchel: 'gold-filled' },
      { 'hero-wealthy': wealthy, 'satchel-gold': gold },
    );
    expect(validateShotEvolution(evolution, 3, later, 2)).toEqual([]);
  });

  it('rejects obsolete character imagery and premature changes within an episode', () => {
    const old = shot(
      { hero: 'ragged', satchel: 'gold-filled' },
      { 'hero-ragged': ragged, 'satchel-gold': gold },
    );
    expect(validateShotEvolution(evolution, 3, old, 2).join(' ')).toMatch(/stale|premature/);

    const future = shot(
      { hero: 'wealthy', satchel: 'empty' },
      { 'hero-wealthy': wealthy, 'satchel-empty': empty },
    );
    expect(validateShotEvolution(evolution, 3, future, 0).join(' ')).toMatch(/stale|premature/);
  });

  it('rejects binding both old and new visual references, even when state ID is correct', () => {
    const mixed = shot(
      { hero: 'wealthy', satchel: 'gold-filled' },
      { 'hero-ragged': ragged, 'hero-wealthy': wealthy, 'satchel-gold': gold },
    );
    expect(validateShotEvolution(evolution, 3, mixed, 3).join(' ')).toMatch(/retired/);
  });

  it('rejects a new state that reuses an old image or reference ID', () => {
    const modified = structuredClone(evolution);
    modified.entities[0]!.states[1]!.referenceSha256 = ragged;
    expect(validateEvolutionShape(modified).join(' ')).toMatch(/reuses/);
  });

  it('requires hash-bound, immutable per-episode snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'series-evolution-'));
    await mkdir(join(root, 'series-bible'));
    const content = JSON.stringify(evolution) + '\n';
    await writeFile(join(root, 'series-bible/evolution.json'), content);
    const config = {
      seriesId: 'series-journey', revisionId: 'series-v1',
      biblePath: 'series-bible/series.json', bibleSha256: 'f'.repeat(64),
      visualFormat: '2d-still' as const, applied: true,
      evolution: {
        path: 'series-bible/evolution.json',
        sha256: createHash('sha256').update(content).digest('hex'),
        episodeOrder: 3,
      },
    };
    const loaded = await loadSeriesEvolution(root, config);
    expect(loaded.errors).toEqual([]);
    expect(loaded.evolution?.entities).toHaveLength(2);
    await writeFile(join(root, 'series-bible/evolution.json'), content + ' ');
    expect((await loadSeriesEvolution(root, config)).errors.join(' ')).toMatch(/hash mismatch/);
  });
});
