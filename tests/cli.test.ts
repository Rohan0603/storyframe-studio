import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

describe('CLI', () => {
  it('creates, plans, validates, and resumes an offline episode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-cli-'));
    await expect(runCli(['new', root, 'episode-01'])).resolves.toBe(0);
    await expect(runCli(['plan', root])).resolves.toBe(0);
    await expect(runCli(['validate', root])).resolves.toBe(0);
    await expect(runCli(['resume', root])).resolves.toBe(0);
    await expect(
      readFile(join(root, 'episode.json'), 'utf8'),
    ).resolves.toContain('episode-01');
  });

  it('fails explicitly for render', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-cli-render-'));
    await expect(runCli(['render', root])).rejects.toThrow(
      /episode.json|ENOENT/i,
    );
  });

  it('fails closed for image-preflight without calling a provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-cli-image-'));
    await expect(runCli(['image-preflight', root])).rejects.toThrow(
      /image-preflight BLOCKED.*unavailable/i,
    );
  });

  it('invalidates downstream narration metadata when selecting a provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-cli-provider-'));
    await runCli(['new', root, 'episode-01']);
    const episode = JSON.parse(
      await readFile(join(root, 'episode.json'), 'utf8'),
    );
    episode.narration.alignmentVerified = true;
    episode.narration.audioDurationMs = 10_628;
    episode.narration.receiptPath = 'receipts/old.json';
    episode.narration.captionsPath = 'audio/old.srt';
    episode.alignment.timingStatus = 'verified';
    episode.alignment.audioDurationMs = 10_628;
    episode.release.productionQAPassed = true;
    await writeFile(
      join(root, 'episode.json'),
      JSON.stringify(episode, null, 2),
    );

    await expect(
      runCli(['select-provider', root, 'episode-01', 'kokoro-onnx']),
    ).resolves.toBe(0);
    const updated = JSON.parse(
      await readFile(join(root, 'episode.json'), 'utf8'),
    );
    expect(updated.narration.provider).toBe('kokoro-onnx');
    expect(updated.narration.alignmentVerified).toBe(false);
    expect(updated.narration.audioDurationMs).toBeUndefined();
    expect(updated.narration.receiptPath).toBeUndefined();
    expect(updated.narration.captionsPath).toBeUndefined();
    expect(updated.release.productionQAPassed).toBe(false);
  });
});
