import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeGeneratedStill } from '../src/image-normalization.js';
import {
  detectPanelGutters,
  screenGeneratedStill,
} from '../src/visual-screening.js';
import { verifyPublicationStatus } from '../src/youtube-state.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('image production hardening', () => {
  it('normalizes actual native stills without overwriting the original', async () => {
    const root = await mkdtemp(join(tmpdir(), 'still-normalize-'));
    await mkdir(join(root, 'native'));
    await writeFile(join(root, 'native/source.png'), png);
    const evidence = await normalizeGeneratedStill(
      root,
      'native/source.png',
      'images/shot-hd.png',
    );
    expect(evidence.native.width).toBe(1);
    expect(evidence.output.width).toBe(1920);
    expect(evidence.output.height).toBe(1080);
    expect((await readFile(join(root, 'native/source.png'))).equals(png)).toBe(
      true,
    );
    await expect(
      normalizeGeneratedStill(root, 'native/source.png', 'images/shot-hd.png'),
    ).rejects.toThrow(/failed|overwrite|exists/i);
  });

  it('flags an obvious multi-panel gutter and keeps ordinary gradients clear', () => {
    const width = 100;
    const height = 60;
    const gray = new Uint8Array(width * height).fill(65);
    for (let y = 0; y < height; y += 1) gray[y * width + 50] = 255;
    expect(detectPanelGutters(gray, width, height)).toBe(true);
    const thick = new Uint8Array(width * height).fill(65);
    for (let y = 0; y < height; y++)
      for (let x = 46; x < 54; x++) thick[y * width + x] = 255;
    expect(detectPanelGutters(thick, width, height)).toBe(true);
    expect(
      detectPanelGutters(
        new Uint8Array(width * height).fill(75),
        width,
        height,
      ),
    ).toBe(false);
  });

  it('returns unknown rather than inventing OCR success when tool is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'still-screen-'));
    await writeFile(join(root, 'native.png'), png);
    const result = await screenGeneratedStill(root, 'native.png', {
      tesseract: 'does-not-exist-storyframe-ocr',
    });
    expect(result.text).toBe('unknown');
    expect(result.imageSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('YouTube state evidence', () => {
  const videoId = 'hlQVQ_jdwvI';
  const future = '2030-02-03T04:05:00.000Z';
  const at = new Date('2026-11-24T00:00:00.000Z');

  it('accepts an owner-visible private video scheduled for the exact time', () => {
    const result = verifyPublicationStatus(
      videoId,
      {
        privacyStatus: 'private',
        publishAt: future,
        uploadStatus: 'processed',
      },
      { state: 'scheduled', publishAt: future },
      at,
    );
    expect(result.state).toBe('scheduled');
  });

  it('rejects a pending form, wrong schedule or non-public video', () => {
    expect(() =>
      verifyPublicationStatus(
        videoId,
        { privacyStatus: 'private' },
        { state: 'scheduled', publishAt: future },
        at,
      ),
    ).toThrow(/not scheduled/);
    expect(() =>
      verifyPublicationStatus(
        videoId,
        { privacyStatus: 'private' },
        { state: 'public' },
        at,
      ),
    ).toThrow(/not public/);
    expect(() =>
      verifyPublicationStatus(
        videoId,
        { privacyStatus: 'private', publishAt: '2030-02-03T04:06:00Z' },
        { state: 'scheduled', publishAt: future },
        at,
      ),
    ).toThrow(/not scheduled/);
  });

  it('accepts a genuinely public API status', () => {
    expect(
      verifyPublicationStatus(
        videoId,
        { privacyStatus: 'public', uploadStatus: 'processed' },
        { state: 'public' },
        at,
      ).state,
    ).toBe('public');
  });
});
