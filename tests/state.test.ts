import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEpisode } from '../src/scaffold.js';
import {
  appendCheckpoint,
  readCheckpoints,
  resumeCheckpoints,
} from '../src/checkpoints.js';

describe('offline state', () => {
  it('scaffolds without overwriting existing user files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-scaffold-'));
    await createEpisode(root, 'episode-01');
    await writeFile(join(root, 'script.md'), 'user content\n');
    await expect(createEpisode(root, 'episode-01')).rejects.toThrow(
      /refusing to overwrite/i,
    );
    await expect(readFile(join(root, 'script.md'), 'utf8')).resolves.toBe(
      'user content\n',
    );
  });

  it('durably records attempts and marks hash-bound state stale on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-checkpoint-'));
    await appendCheckpoint(root, {
      stage: 'plan',
      attempt: 1,
      status: 'approved',
      inputHashes: { script: 'old' },
      outputHashes: {},
      recordedAt: new Date().toISOString(),
    });
    await expect(readCheckpoints(root)).resolves.toHaveLength(1);
    const result = await resumeCheckpoints(root, { script: 'new' });
    expect(result[0]?.status).toBe('stale');
  });

  it('rejects conflicting attempt state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-conflict-'));
    await appendCheckpoint(root, {
      stage: 'plan',
      attempt: 1,
      status: 'approved',
      inputHashes: {},
      outputHashes: {},
      recordedAt: new Date().toISOString(),
    });
    await expect(
      appendCheckpoint(root, {
        stage: 'plan',
        attempt: 1,
        status: 'failed',
        inputHashes: {},
        outputHashes: {},
        recordedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/conflicting/i);
  });

  it('does not append duplicate stale transitions on repeated resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-idempotent-'));
    await appendCheckpoint(root, {
      stage: 'plan',
      attempt: 1,
      status: 'approved',
      inputHashes: { script: 'old' },
      outputHashes: {},
      recordedAt: new Date().toISOString(),
    });
    await resumeCheckpoints(root, { script: 'new' });
    await resumeCheckpoints(root, { script: 'new' });
    await expect(readCheckpoints(root)).resolves.toHaveLength(2);
  });
});
