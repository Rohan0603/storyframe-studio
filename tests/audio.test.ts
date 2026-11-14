import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSrt,
  retimeShotsFromAlignment,
  synthesizeGeminiTts,
  type AudioAlignment,
} from '../src/audio.js';
import type { Shot } from '../src/types.js';

const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

describe('Gemini TTS and verified captions', () => {
  it('rejects a transcript that differs from the approved words', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-audio-'));
    await expect(
      synthesizeGeminiTts(root, {
        approvedText: 'The traveler opens the chest.',
        transcript: 'The traveler opens a chest.',
        voiceName: 'Kore',
        model: 'gemini-2.5-flash-preview-tts',
        apiKey: 'test-only',
        chargeAuthorization: 'free',
        preflight: {
          modelAvailable: true,
          quotaState: 'available' as const,
          chargeState: 'free' as const,
        },
        fetchImpl: async () => {
          throw new Error('provider must not be called');
        },
      }),
    ).rejects.toThrow(/exactly/i);
  });

  it('does not repeat an ambiguous provider request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-audio-'));
    const options = {
      approvedText: 'The traveler opens the chest.',
      transcript: 'The traveler opens the chest.',
      voiceName: 'Kore',
      model: 'gemini-2.5-flash-preview-tts',
      apiKey: 'test-only',
      chargeAuthorization: 'free' as const,
      preflight: {
        modelAvailable: true,
        quotaState: 'available' as const,
        chargeState: 'free' as const,
      },
      requestId: 'request-1',
      fetchImpl: async () => {
        throw new Error('network timeout');
      },
    };
    await expect(synthesizeGeminiTts(root, options)).rejects.toThrow(
      /unknown/i,
    );
    await expect(synthesizeGeminiTts(root, options)).rejects.toThrow(
      /unknown|reconcile/i,
    );
  });

  it('retimes shots and emits captions only from verified word timings', async () => {
    const alignment: AudioAlignment = {
      version: 1,
      transcriptSha256: hash(
        'The traveler opens the chest. Then blue light blooms.',
      ),
      audioSha256: 'a'.repeat(64),
      durationMs: 2_400,
      source: 'manual',
      verified: true,
      words: [
        { word: 'The', startMs: 0, endMs: 200 },
        { word: 'traveler', startMs: 200, endMs: 700 },
        { word: 'opens', startMs: 700, endMs: 1_000 },
        { word: 'the', startMs: 1_000, endMs: 1_100 },
        { word: 'chest.', startMs: 1_100, endMs: 1_400 },
        { word: 'Then', startMs: 1_500, endMs: 1_700 },
        { word: 'blue', startMs: 1_700, endMs: 1_900 },
        { word: 'light', startMs: 1_900, endMs: 2_100 },
        { word: 'blooms.', startMs: 2_100, endMs: 2_400 },
      ],
    };
    const shots: Shot[] = [
      {
        id: 'shot-open',
        beatIds: ['beat-open'],
        audioStartMs: 10,
        audioEndMs: 20,
        requiredVisualEvent: 'open chest',
        characters: [],
        props: [],
        environment: 'room',
        composition: 'wide',
        forbidden: [],
        image: { path: 'open.png', sha256: null, status: 'pending' },
        semanticReview: {
          status: 'pending',
          reviewedImageSha256: null,
          notes: '',
        },
      },
      {
        id: 'shot-light',
        beatIds: ['beat-light'],
        audioStartMs: 20,
        audioEndMs: 30,
        requiredVisualEvent: 'blue light blooms',
        characters: [],
        props: [],
        environment: 'room',
        composition: 'wide',
        forbidden: [],
        image: { path: 'light.png', sha256: null, status: 'pending' },
        semanticReview: {
          status: 'pending',
          reviewedImageSha256: null,
          notes: '',
        },
      },
    ];
    const beats = [
      {
        id: 'beat-open',
        spokenText: 'The traveler opens the chest.',
        scriptStartChar: 0,
        scriptEndChar: 30,
        sourceClaimIds: [],
      },
      {
        id: 'beat-light',
        spokenText: 'Then blue light blooms.',
        scriptStartChar: 31,
        scriptEndChar: 53,
        sourceClaimIds: [],
      },
    ];
    retimeShotsFromAlignment(shots, beats, alignment);
    expect(shots.map((shot) => [shot.audioStartMs, shot.audioEndMs])).toEqual([
      [0, 1_400],
      [1_500, 2_400],
    ]);
    expect(createSrt(alignment, 5)).toContain('00:00:00,000 --> 00:00:01,400');
    expect(createSrt(alignment, 5)).toContain('blue light blooms.');
  });

  it('refuses provisional timings as production verification', () => {
    expect(() =>
      retimeShotsFromAlignment([], [], {
        version: 1,
        transcriptSha256: 'a'.repeat(64),
        audioSha256: 'b'.repeat(64),
        durationMs: 100,
        source: 'estimated',
        verified: false,
        words: [],
      }),
    ).toThrow(/verified/i);
  });

  it('persists real audio bytes and a hash from a successful provider response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-audio-'));
    const wav = Buffer.alloc(16_044);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(16_036, 4);
    wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(16_000, 40);
    const result = await synthesizeGeminiTts(root, {
      approvedText: 'The traveler opens the chest.',
      transcript: 'The traveler opens the chest.',
      voiceName: 'Kore',
      model: 'gemini-2.5-flash-preview-tts',
      apiKey: 'test-only',
      chargeAuthorization: 'free',
      preflight: {
        modelAvailable: true,
        quotaState: 'available' as const,
        chargeState: 'free' as const,
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/wav',
                        data: wav.toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    expect(result.audioSha256).toBe(hash(wav));
    await expect(readFile(join(root, result.audioPath))).resolves.toEqual(wav);
  });

  it('normalizes Gemini PCM l16 output into a persisted WAV', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-audio-l16-'));
    const pcm = Buffer.alloc(4800);
    pcm[0] = 0x12;
    pcm[1] = 0x34;
    pcm[2] = 0xab;
    pcm[3] = 0xcd;
    const result = await synthesizeGeminiTts(root, {
      approvedText: 'The traveler opens the chest.',
      transcript: 'The traveler opens the chest.',
      voiceName: 'Kore',
      model: 'gemini-3.1-flash-tts-preview',
      apiKey: 'test-only',
      chargeAuthorization: 'free',
      preflight: {
        modelAvailable: true,
        quotaState: 'available' as const,
        chargeState: 'free' as const,
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/l16; rate=24000; channels=1',
                        data: pcm.toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    const persisted = await readFile(join(root, result.audioPath));
    expect(persisted.subarray(0, 4).toString()).toBe('RIFF');
    expect(persisted.readUInt32LE(24)).toBe(24000);
    expect([...persisted.subarray(44, 48)]).toEqual([0x34, 0x12, 0xcd, 0xab]);
    expect(result.mimeType).toBe('audio/wav');
    expect(result.durationMs).toBe(100);
  });
});
