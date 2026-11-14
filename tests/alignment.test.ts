import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEpisode } from '../src/manifest.js';
import type { Episode, Shot } from '../src/types.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function fixture(): Promise<{ root: string; episode: Episode }> {
  const root = await mkdtemp(join(tmpdir(), 'storyframe-alignment-'));
  await mkdir(join(root, 'references'));
  await writeFile(
    join(root, 'script.md'),
    'A opens the chest. A sees the crystal. A touches it.',
  );
  await writeFile(join(root, 'references', 'bundle.json'), '{}');
  const scriptHash = hash(
    'A opens the chest. A sees the crystal. A touches it.',
  );
  const episode: Episode = {
    schemaVersion: 1,
    episodeId: 'episode-01',
    mode: 'guided',
    script: { path: 'script.md', sha256: scriptHash, approved: true },
    referenceBundle: { path: 'references/bundle.json', sha256: hash('{}') },
    narration: {
      provider: 'offline-fixture',
      textSha256: hash(''),
      audioPath: 'audio.wav',
      alignmentPath: 'alignment.json',
      alignmentVerified: false,
    },
    alignment: {
      scriptRevisionId: 'script-revision-01',
      scriptSha256: scriptHash,
      timingStatus: 'provisional',
      audioDurationMs: null,
      density: { style: 'cinematic', targetMin: 14, targetMax: 18 },
    },
    beats: [
      {
        id: 'beat-open',
        spokenText: 'A opens the chest.',
        scriptStartChar: 0,
        scriptEndChar: 18,
        sourceClaimIds: [],
        scriptRevisionId: 'script-revision-01',
        scriptRevisionSha256: scriptHash,
      },
      {
        id: 'beat-see',
        spokenText: 'A sees the crystal.',
        scriptStartChar: 19,
        scriptEndChar: 38,
        sourceClaimIds: [],
        scriptRevisionId: 'script-revision-01',
        scriptRevisionSha256: scriptHash,
      },
      {
        id: 'beat-touch',
        spokenText: 'A touches it.',
        scriptStartChar: 39,
        scriptEndChar: 52,
        sourceClaimIds: [],
        scriptRevisionId: 'script-revision-01',
        scriptRevisionSha256: scriptHash,
      },
    ],
    shots: [],
    release: {
      productionQAPassed: false,
      creativeApproval: null,
      publishAuthorization: null,
    },
  };
  return { root, episode };
}

function shot(
  id: string,
  start: number,
  end: number,
  beatIds: string[],
  purpose: Shot['visualPurpose'] = 'action',
): Shot {
  return {
    id,
    beatIds,
    audioStartMs: start,
    audioEndMs: end,
    requiredVisualEvent: `${id} meaningful action`,
    characters: [],
    props: [],
    environment: 'stone-room',
    composition: 'medium',
    forbidden: [],
    visualPurpose: purpose,
    ...(purpose === 'hold'
      ? {
          intentionalHold: {
            reason: 'let the reveal land',
            relatedBeatIds: beatIds,
          },
        }
      : {}),
    image: { path: 'missing.png', sha256: null, status: 'pending' },
    semanticReview: { status: 'pending', reviewedImageSha256: null, notes: '' },
  };
}

describe('narration-to-visual alignment', () => {
  it('accepts ordered coverage and one beat split across multiple meaningful shots', async () => {
    const { root, episode } = await fixture();
    episode.shots = [
      shot('shot-open', 0, 1000, ['beat-open']),
      shot('shot-reveal-a', 1000, 1800, ['beat-see']),
      shot('shot-reveal-b', 1800, 2500, ['beat-see']),
      shot('shot-touch', 2500, 3200, ['beat-touch']),
    ];
    const result = await validateEpisode(episode, root);
    expect(result.valid).toBe(true);
  });

  it('requires explicit intentional holds and rejects gaps, stale hashes, and orphan beats', async () => {
    const { root, episode } = await fixture();
    episode.shots = [
      shot('shot-open', 0, 1000, ['beat-open']),
      shot('shot-hold', 1000, 2000, ['beat-see'], 'hold'),
    ];
    let result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/beat-touch|hold/);
    episode.shots.push(shot('shot-touch', 2200, 3000, ['beat-touch']));
    episode.alignment!.scriptSha256 = 'f'.repeat(64);
    result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/stale|gap/);
  });

  it('rejects shuffled or overlapping timing rather than treating it as sync', async () => {
    const { root, episode } = await fixture();
    episode.shots = [
      shot('shot-see', 1000, 2000, ['beat-see']),
      shot('shot-open', 500, 1500, ['beat-open']),
      shot('shot-touch', 2000, 2500, ['beat-touch']),
    ];
    const result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/gap|overlap|order/);
  });
});
