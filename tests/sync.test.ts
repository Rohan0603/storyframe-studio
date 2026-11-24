import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSyncTimeline, timelineSrt } from '../src/sync.js';
import type { Episode, SyncTimeline } from '../src/types.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const script =
  'A opens the chest. A reveals the blue crystal. A touches it. The room shakes.';

async function fixture(): Promise<{ episode: Episode; root: string }> {
  const scriptSha = sha(script);
  const audioSha = sha('verified-audio');
  const root = await mkdtemp(join(tmpdir(), 'storyframe-sync-'));
  await mkdir(join(root, 'audio'));
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'script.md'), script);
  await writeFile(join(root, 'audio.wav'), 'verified-audio');
  await writeFile(
    join(root, 'audio', 'alignment.json'),
    JSON.stringify({
      verified: true,
      source: 'provider',
      audioSha256: audioSha,
      durationMs: 4200,
      transcriptSha256: scriptSha,
    }),
  );
  const beats = [
    ['beat-open', 'A opens the chest.'],
    ['beat-reveal', 'A reveals the blue crystal.'],
    ['beat-touch', 'A touches it.'],
    ['beat-shake', 'The room shakes.'],
  ].map(([id, spokenText]) => ({
    id: id as string,
    spokenText: spokenText as string,
    scriptStartChar: script.indexOf(spokenText as string),
    scriptEndChar:
      script.indexOf(spokenText as string) + (spokenText as string).length,
    sourceClaimIds: [],
    scriptRevisionId: 'script-revision-01',
    scriptRevisionSha256: scriptSha,
  }));
  const ranges = [
    [0, 1000],
    [1000, 2200],
    [2200, 3000],
    [3000, 4200],
  ];
  const names = ['open', 'reveal', 'touch', 'shake'];
  const shots = names.map((name, index) => ({
    id: `shot-${name}`,
    beatIds: [beats[index]!.id],
    audioStartMs: ranges[index]![0]!,
    audioEndMs: ranges[index]![1]!,
    requiredVisualEvent: name,
    characters: [],
    props: [],
    environment: 'room',
    composition: 'wide',
    forbidden: [],
    visualPurpose: 'action' as const,
    imagePrompt: `prompt-${name}`,
    image: {
      path: `images/${name}.png`,
      sha256: sha(`image-${name}`),
      status: 'approved' as const,
      provenance: {
        tool: 'codex-desktop.image_gen' as const,
        packetSha256: sha(`packet-${name}`),
        attemptId: `attempt-${name}`,
        receiptStatus: 'persisted' as const,
        width: 1920,
        height: 1080,
      },
    },
    semanticReview: {
      status: 'pass' as const,
      reviewedImageSha256: sha(`image-${name}`),
      notes: 'inspected pixels',
      pixelsDecoded: true,
    },
  }));
  await Promise.all(
    names.map((name) =>
      writeFile(join(root, 'images', `${name}.png`), `image-${name}`),
    ),
  );
  const records = names.map((name, index) => ({
    shotId: shots[index]!.id,
    sceneId: `scene-${index + 1}`,
    startMs: ranges[index]![0]!,
    endMs: ranges[index]![1]!,
    narration: {
      beatIds: [beats[index]!.id],
      text: beats[index]!.spokenText,
      scriptStartChar: beats[index]!.scriptStartChar,
      scriptEndChar: beats[index]!.scriptEndChar,
      timingSource: 'audio-verified' as const,
    },
    image: {
      prompt: `prompt-${name}`,
      promptSha256: sha(`prompt-${name}`),
      requiredVisualEvent: name,
      path: `images/${name}.png`,
      sha256: sha(`image-${name}`),
      sourceShotId: shots[index]!.id,
      pixelReview: 'pass' as const,
    },
    subtitles: [
      {
        cueId: `cue-${name}`,
        startMs: ranges[index]![0]!,
        endMs: ranges[index]![1]!,
        text: beats[index]!.spokenText,
        alignmentStatus: 'verified' as const,
      },
    ],
  }));
  const timeline: SyncTimeline = {
    version: 1,
    status: 'verified',
    audioSha256: audioSha,
    audioDurationMs: 4200,
    scriptSha256: scriptSha,
    alignmentPath: 'audio/alignment.json',
    records,
  };
  return {
    root,
    episode: {
      schemaVersion: 1,
      episodeId: 'episode-01',
      mode: 'guided',
      script: { path: 'script.md', sha256: scriptSha, approved: true },
      referenceBundle: { path: 'refs.json', sha256: sha('{}') },
      narration: {
        provider: 'offline-fixture',
        textSha256: scriptSha,
        audioPath: 'audio.wav',
        alignmentPath: 'audio/alignment.json',
        alignmentVerified: true,
        audioSha256: audioSha,
        audioDurationMs: 4200,
      },
      alignment: {
        scriptRevisionId: 'script-revision-01',
        scriptSha256: scriptSha,
        timingStatus: 'verified',
        audioDurationMs: 4200,
        density: { style: 'cinematic', targetMin: 1, targetMax: 18 },
      },
      beats,
      shots,
      syncTimeline: timeline,
      release: {
        productionQAPassed: false,
        creativeApproval: null,
        publishAuthorization: null,
      },
    },
  };
}

describe('canonical synchronized timeline', () => {
  it('accepts the ordered chest, crystal, touch, shake progression', async () => {
    const { episode, root } = await fixture();
    await expect(validateSyncTimeline(episode, root)).resolves.toEqual({
      valid: true,
      errors: [],
    });
    expect(timelineSrt(episode.syncTimeline!).match(/^\d+$/gm)).toHaveLength(4);
  });

  it('rejects shuffled images even when timestamps remain valid', async () => {
    const { episode, root } = await fixture();
    episode.syncTimeline!.records[1]!.image.sourceShotId = 'shot-open';
    await expect(validateSyncTimeline(episode, root)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/sourceShotId/)]),
    });
  });

  it('rejects an early reveal, wrong caption, stale audio, and timeline drift', async () => {
    const { episode, root } = await fixture();
    episode.syncTimeline!.records[1]!.startMs = 0;
    await expect(validateSyncTimeline(episode, root)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/gap|overlap|timing/),
      ]),
    });
    const { episode: wrong, root: wrongRoot } = await fixture();
    wrong.syncTimeline!.records[1]!.subtitles[0]!.text = 'The room shakes.';
    await expect(validateSyncTimeline(wrong, wrongRoot)).resolves.toMatchObject(
      {
        valid: false,
        errors: expect.arrayContaining([
          expect.stringMatching(/subtitle text/),
        ]),
      },
    );
    const { episode: stale, root: staleRoot } = await fixture();
    stale.syncTimeline!.audioSha256 = 'f'.repeat(64);
    await expect(validateSyncTimeline(stale, staleRoot)).resolves.toMatchObject(
      {
        valid: false,
        errors: expect.arrayContaining([expect.stringMatching(/audio hash/)]),
      },
    );
  });

  it('rejects missing synchronization evidence and non-passing pixel QA', async () => {
    const { episode, root } = await fixture();
    episode.syncTimeline!.records[0]!.image.pixelReview = 'unknown';
    episode.syncTimeline!.records[0]!.subtitles = [];
    await expect(validateSyncTimeline(episode, root)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/pixel QA|subtitle text/),
      ]),
    });
  });
});

describe('measured audio boundaries', () => {
  it('rejects a shifted shot and caption cut even with otherwise consistent timestamps', async () => {
    const { episode, root } = await fixture();
    const alignment = {
      verified: true,
      source: 'manual',
      granularity: 'phrase',
      evidenceNotes: 'Measured fixture phrase boundaries',
      audioSha256: episode.narration.audioSha256,
      durationMs: 4200,
      transcriptSha256: episode.narration.textSha256,
      phrases: episode.syncTimeline!.records.map((record) => ({
        text: record.narration.text,
        startMs: record.startMs,
        endMs: record.endMs,
      })),
    };
    await writeFile(
      join(root, 'audio/alignment.json'),
      JSON.stringify(alignment),
    );
    expect((await validateSyncTimeline(episode, root)).valid).toBe(true);
    const first = episode.syncTimeline!.records[0]!;
    const second = episode.syncTimeline!.records[1]!;
    first.endMs =
      first.subtitles[0]!.endMs =
      episode.shots[0]!.audioEndMs =
        1800;
    second.startMs =
      second.subtitles[0]!.startMs =
      episode.shots[1]!.audioStartMs =
        1800;
    expect(
      (await validateSyncTimeline(episode, root)).errors.join(' '),
    ).toMatch(/measured speech boundaries/);
  });
});
