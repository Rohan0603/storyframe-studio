import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEpisode } from '../src/manifest.js';
import type { Episode } from '../src/types.js';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function fixture(): Promise<{ root: string; episode: Episode }> {
  const root = await mkdtemp(join(tmpdir(), 'storyframe-'));
  await mkdir(join(root, 'references'));
  await writeFile(join(root, 'script.md'), '# Empty\n');
  await writeFile(join(root, 'references', 'bundle.json'), '{}\n');
  const episode: Episode = {
    schemaVersion: 1,
    episodeId: 'episode-01',
    mode: 'guided',
    script: { path: 'script.md', sha256: sha256('# Empty\n'), approved: false },
    referenceBundle: { path: 'references/bundle.json', sha256: sha256('{}\n') },
    narration: {
      provider: 'offline-fixture',
      textSha256: sha256(''),
      audioPath: 'audio/narration.wav',
      alignmentPath: 'audio/alignment.json',
      alignmentVerified: false,
    },
    beats: [],
    shots: [],
    release: {
      productionQAPassed: false,
      creativeApproval: null,
      publishAuthorization: null,
    },
  };
  return { root, episode };
}

describe('episode validation', () => {
  it('accepts a blank offline episode with real hashes', async () => {
    const { root, episode } = await fixture();
    const result = await validateEpisode(episode, root);
    expect(result.valid).toBe(true);
  });

  it('rejects malformed and duplicate IDs', async () => {
    const { root, episode } = await fixture();
    episode.episodeId = 'Episode 01';
    episode.beats = [
      {
        id: 'beat-01',
        spokenText: '',
        scriptStartChar: 0,
        scriptEndChar: 0,
        sourceClaimIds: [],
      },
      {
        id: 'beat-01',
        spokenText: '',
        scriptStartChar: 0,
        scriptEndChar: 0,
        sourceClaimIds: [],
      },
    ];
    const result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/stable ID|duplicate/i);
  });

  it('rejects traversal and absolute paths', async () => {
    const { root, episode } = await fixture();
    episode.script.path = '../outside.md';
    const result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/safe path/i);
  });

  it('rejects unsafe narration and shot image paths', async () => {
    const { root, episode } = await fixture();
    episode.narration.audioPath = '../outside.wav';
    episode.shots = [
      {
        id: 'shot-01',
        beatIds: [],
        audioStartMs: 0,
        audioEndMs: 1000,
        requiredVisualEvent: 'hold',
        characters: [],
        props: [],
        environment: 'room',
        composition: 'wide',
        forbidden: [],
        image: { path: 'C:/outside.png', sha256: null, status: 'pending' },
        semanticReview: {
          status: 'pending',
          reviewedImageSha256: null,
          notes: '',
        },
      },
    ];
    const result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/narration audio|image path/i);
  });

  it('rejects manifests missing required arrays and release state', async () => {
    const { root, episode } = await fixture();
    const incomplete = {
      ...episode,
      beats: undefined,
      shots: undefined,
      release: undefined,
    };
    const result = await validateEpisode(
      incomplete as unknown as Episode,
      root,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/beats|shots|release/i);
  });

  it('rejects a symlink that escapes the project root', async () => {
    const { root, episode } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'storyframe-outside-'));
    await writeFile(join(outside, 'script.md'), '# outside\n');
    await readFile(join(root, 'script.md'));
    await symlink(join(outside, 'script.md'), join(root, 'linked-script.md'));
    episode.script.path = 'linked-script.md';
    episode.script.sha256 = sha256('# outside\n');
    const result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/escapes|outside/i);
  });
});
