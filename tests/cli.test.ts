import { mkdtemp, readFile } from 'node:fs/promises';
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
      /not implemented|provider/i,
    );
  });
});
