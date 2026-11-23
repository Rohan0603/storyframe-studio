import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEpisode } from '../src/manifest.js';
import type { Episode } from '../src/types.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(): Promise<{ root: string; episode: Episode }> {
  const root = await mkdtemp(join(tmpdir(), 'storyframe-series-'));
  await mkdir(join(root, 'references'));
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'script.md'), 'Tommy enters the bar.');
  await writeFile(join(root, 'references', 'bundle.json'), '{}\n');
  const scriptHash = sha('Tommy enters the bar.');
  const episode = {
    schemaVersion: 1,
    episodeId: 'episode-02',
    mode: 'guided',
    script: { path: 'script.md', sha256: scriptHash, approved: true },
    referenceBundle: { path: 'references/bundle.json', sha256: sha('{}\n') },
    narration: {
      provider: 'offline-fixture' as const,
      textSha256: scriptHash,
      audioPath: 'audio.wav',
      alignmentPath: 'audio/alignment.json',
      alignmentVerified: false,
    },
    story: {
      scriptRevision: {
        id: 'script-revision-02',
        text: 'Tommy enters the bar.',
        textSha256: sha('Tommy enters the bar.'),
        segments: [],
      },
      sourceClaims: [],
      canon: { characters: [], props: [], observations: [] },
      beatCandidates: [],
    },
    beats: [
      {
        id: 'beat-01',
        spokenText: 'Tommy enters the bar.',
        scriptStartChar: 0,
        scriptEndChar: 21,
        sourceClaimIds: [],
        scriptRevisionId: 'script-revision-02',
        scriptRevisionSha256: scriptHash,
      },
    ],
    alignment: {
      scriptRevisionId: 'script-revision-02',
      scriptSha256: scriptHash,
      scriptRevisionSha256: scriptHash,
      timingStatus: 'provisional',
      audioDurationMs: 1000,
      density: { style: 'cinematic', targetMin: 1, targetMax: 18 },
    },
    shots: [
      {
        id: 'shot-01',
        beatIds: ['beat-01'],
        audioStartMs: 0,
        audioEndMs: 1000,
        requiredVisualEvent: 'Tommy enters the bar',
        characters: [],
        props: [],
        environment: 'bar',
        composition: 'wide',
        forbidden: [],
        visualPurpose: 'action',
        image: {
          path: 'images/shot-01.png',
          sha256: null,
          status: 'pending' as const,
        },
        semanticReview: {
          status: 'pending' as const,
          reviewedImageSha256: null,
          notes: '',
        },
      },
    ],
    release: {
      productionQAPassed: false,
      creativeApproval: null,
      publishAuthorization: null,
    },
  } as Episode;
  return { root, episode };
}

describe('series continuity application', () => {
  it('rejects an applied series configuration when shots are not bound to it', async () => {
    const { root, episode } = await fixture();
    episode.series = {
      seriesId: 'series-mafia',
      revisionId: 'series-revision-01',
      biblePath: 'series-bible/series.json',
      bibleSha256: sha('{}\n'),
      visualFormat: '3d-still',
      applied: true,
    };
    await mkdir(join(root, 'series-bible'));
    await writeFile(join(root, 'series-bible', 'series.json'), '{}\n');
    const result = await validateEpisode(episode, root);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/series binding/i);
  });

  it('accepts an applied series configuration when every shot carries its binding', async () => {
    const { root, episode } = await fixture();
    episode.series = {
      seriesId: 'series-mafia',
      revisionId: 'series-revision-01',
      biblePath: 'series-bible/series.json',
      bibleSha256: sha('{}\n'),
      visualFormat: '3d-still',
      applied: true,
    };
    await mkdir(join(root, 'series-bible'));
    await writeFile(join(root, 'series-bible', 'series.json'), '{}\n');
    episode.shots[0]!.seriesBinding = {
      seriesId: 'series-mafia',
      revisionId: 'series-revision-01',
    };
    const result = await validateEpisode(episode, root);
    expect(
      result.errors.filter((error) => /series binding/i.test(error)),
    ).toEqual([]);
  });
});
