import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderStillEpisode } from '../src/render.js';
import type { Episode } from '../src/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const hash = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');

describe('FFmpeg still renderer', () => {
  it('renders an HD MP4 and verifies its streams without overwriting output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-render-'));
    const imagePath = join(root, 'shot.png');
    const audioPath = join(root, 'narration.wav');
    await writeFile(imagePath, png);
    const audio = Buffer.alloc(16_044);
    audio.write('RIFF', 0, 'ascii');
    audio.writeUInt32LE(16_036, 4);
    audio.write('WAVEfmt ', 8, 'ascii');
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24);
    audio.writeUInt32LE(16000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write('data', 36, 'ascii');
    audio.writeUInt32LE(16_000, 40);
    await writeFile(audioPath, audio);
    await writeFile(
      join(root, 'alignment.json'),
      JSON.stringify({
        verified: true,
        source: 'provider',
        audioSha256: hash(audio),
        durationMs: 1000,
        transcriptSha256: hash('A.'),
      }),
    );
    const episode: Episode = {
      schemaVersion: 1,
      episodeId: 'episode-01',
      mode: 'guided',
      script: { path: 'script.md', sha256: hash('A.'), approved: true },
      referenceBundle: { path: 'bundle.json', sha256: hash('{}') },
      narration: {
        provider: 'gemini-tts',
        textSha256: hash('A.'),
        audioPath: 'narration.wav',
        alignmentPath: 'alignment.json',
        alignmentVerified: true,
        audioSha256: hash(audio),
        audioDurationMs: 1000,
      },
      alignment: {
        scriptRevisionId: 'script-revision-01',
        scriptSha256: hash('A.'),
        timingStatus: 'verified',
        audioDurationMs: 1000,
        density: { style: 'cinematic', targetMin: 1, targetMax: 2 },
      },
      beats: [
        {
          id: 'beat-01',
          spokenText: 'A.',
          scriptStartChar: 0,
          scriptEndChar: 2,
          sourceClaimIds: [],
          scriptRevisionId: 'script-revision-01',
          scriptRevisionSha256: hash('A.'),
        },
      ],
      shots: [
        {
          id: 'shot-01',
          beatIds: ['beat-01'],
          audioStartMs: 0,
          audioEndMs: 1000,
          requiredVisualEvent: 'A.',
          imagePrompt: 'A.',
          characters: [],
          props: [],
          environment: 'room',
          composition: 'wide',
          forbidden: [],
          image: {
            path: 'shot.png',
            sha256: hash(png),
            status: 'approved',
            provenance: {
              tool: 'codex-desktop.image_gen',
              packetSha256: hash('packet'),
              attemptId: 'attempt-01',
              receiptStatus: 'persisted',
              width: 1,
              height: 1,
            },
          },
          semanticReview: {
            status: 'pass',
            reviewedImageSha256: hash(png),
            notes: 'inspected pixels',
            pixelsDecoded: true,
          },
        },
      ],
      syncTimeline: {
        version: 1,
        status: 'verified',
        audioSha256: hash(audio),
        audioDurationMs: 1000,
        scriptSha256: hash('A.'),
        alignmentPath: 'alignment.json',
        records: [
          {
            shotId: 'shot-01',
            sceneId: 'scene-01',
            startMs: 0,
            endMs: 1000,
            narration: {
              beatIds: ['beat-01'],
              text: 'A.',
              scriptStartChar: 0,
              scriptEndChar: 2,
              timingSource: 'audio-verified',
            },
            image: {
              prompt: 'A.',
              promptSha256: hash('A.'),
              requiredVisualEvent: 'A.',
              path: 'shot.png',
              sha256: hash(png),
              sourceShotId: 'shot-01',
              pixelReview: 'pass',
            },
            subtitles: [
              {
                cueId: 'cue-01',
                startMs: 0,
                endMs: 1000,
                text: 'A.',
                alignmentStatus: 'verified',
              },
            ],
          },
        ],
      },
      release: {
        productionQAPassed: false,
        creativeApproval: null,
        publishAuthorization: null,
      },
    };
    await writeFile(join(root, 'script.md'), 'A.');
    await writeFile(join(root, 'bundle.json'), '{}');
    const strict = structuredClone(episode);
    strict.imagePolicy = { width: 1920, height: 1080, requireNativeReceipt: true, requireVisualScreening: true };
    await expect(renderStillEpisode(root, strict, { outputPath: 'strict.mp4' })).rejects.toThrow(/strict manifest validation/);
    const result = await renderStillEpisode(root, episode, {
      outputPath: 'video.mp4',
    });
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.videoCodec).toBe('h264');
    await expect(
      renderStillEpisode(root, episode, { outputPath: 'video.mp4' }),
    ).rejects.toThrow(/exists|overwrite/i);
  });
});
