import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEpisode } from '../src/manifest.js';
import {
  freezeReferenceBible,
  referenceSha256,
} from '../src/reference-bible.js';
import { createScriptRevision } from '../src/story-layer.js';
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

  it('rejects malformed entries and canonical beat text drift', async () => {
    const { root, episode } = await fixture();
    const scriptRevision = createScriptRevision({
      id: 'script-rev-01',
      text: 'Good script',
      segments: [],
    });
    episode.story = {
      scriptRevision,
      sourceClaims: [],
      canon: { characters: [], props: [], observations: [] },
      beatCandidates: [],
    };
    episode.beats = [
      {
        id: 'beat-01',
        spokenText: 'EVIL',
        scriptStartChar: 0,
        scriptEndChar: 4,
        sourceClaimIds: [],
      },
      null as never,
    ];
    const result = await validateEpisode(episode, root);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(
      /spoken text mismatch|beat must be an object/,
    );
  });

  it('rejects a malformed narrative plan while allowing legacy stories without one', async () => {
    const { root, episode } = await fixture();
    const scriptRevision = createScriptRevision({
      id: 'script-rev-01',
      text: 'Good script',
      segments: [],
    });
    episode.story = {
      scriptRevision,
      sourceClaims: [],
      canon: { characters: [], props: [], observations: [] },
      beatCandidates: [],
      narrativePlan: {
        hook: '',
        contradiction: 'A contradiction',
        protagonistGoal: 'A goal',
        stakes: 'Stakes',
        escalationBeats: ['one'],
        reversal: 'A turn',
        endingPayoff: 'An ending',
        voiceDirection: 'Alert',
        factualGuardrails: ['No invention'],
      },
    };
    const result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(
      /narrative plan: hook|required|escalation/,
    );
  });

  it('rejects out-of-bounds beats and malformed release state', async () => {
    const { root, episode } = await fixture();
    episode.beats = [
      {
        id: 'beat-01',
        spokenText: '',
        scriptStartChar: 999,
        scriptEndChar: 999,
        sourceClaimIds: [],
      },
    ];
    episode.release = {} as never;
    const result = await validateEpisode(episode, root);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/script span|release/);
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

  it('binds the reference manifest fields to the loaded frozen bundle', async () => {
    const { root, episode } = await fixture();
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(join(root, 'references', 'traveler.png'), bytes);
    const bible = {
      bundleId: 'bible-01',
      storyRevisionId: 'script-revision-01',
      storyRevisionSha256: 'a'.repeat(64),
      canonSha256: 'b'.repeat(64),
      entries: [
        {
          id: 'traveler',
          kind: 'character' as const,
          name: 'Traveler',
          visualCanon: 'Amber coat and short dark hair.',
          image: {
            path: 'references/traveler.png',
            sha256: referenceSha256(bytes),
            mimeType: 'image/png' as const,
            approved: true,
          },
        },
      ],
    };
    const bibleText = JSON.stringify(bible);
    await writeFile(join(root, 'references', 'bible.json'), bibleText);
    episode.referenceBible = {
      path: 'references/bible.json',
      sha256: referenceSha256(bibleText),
      freezeSha256: freezeReferenceBible(bible),
      storyRevisionId: bible.storyRevisionId,
      storyRevisionSha256: bible.storyRevisionSha256,
      canonSha256: bible.canonSha256,
      status: 'frozen',
    };
    let result = await validateEpisode(episode, root);
    expect(result.valid).toBe(true);
    episode.referenceBible.storyRevisionId = 'script-revision-02';
    result = await validateEpisode(episode, root);
    expect(result.errors.join('\n')).toMatch(/manifest binding/);
  });
});
