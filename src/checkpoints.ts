import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Checkpoint } from './types.js';

const file = (root: string) => join(root, '.storyframe', 'checkpoints.jsonl');

export async function readCheckpoints(root: string): Promise<Checkpoint[]> {
  const text = await readFile(file(root), 'utf8').catch(
    (error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? '' : Promise.reject(error),
  );
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Checkpoint);
}

export async function appendCheckpoint(
  root: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const existing = await readCheckpoints(root);
  const sameState = (item: Checkpoint): boolean =>
    item.stage === checkpoint.stage &&
    item.attempt === checkpoint.attempt &&
    item.status === checkpoint.status &&
    JSON.stringify(item.inputHashes) ===
      JSON.stringify(checkpoint.inputHashes) &&
    JSON.stringify(item.outputHashes) ===
      JSON.stringify(checkpoint.outputHashes);
  if (existing.some(sameState)) return;
  const conflict = existing.find(
    (item) =>
      item.stage === checkpoint.stage &&
      item.attempt === checkpoint.attempt &&
      !(checkpoint.status === 'stale' && item.status === 'approved') &&
      !sameState(item),
  );
  if (conflict)
    throw new Error(
      `conflicting checkpoint for ${checkpoint.stage} attempt ${checkpoint.attempt}`,
    );
  await mkdir(join(root, '.storyframe'), { recursive: true });
  await appendFile(file(root), JSON.stringify(checkpoint) + '\n', {
    encoding: 'utf8',
  });
}

export async function resumeCheckpoints(
  root: string,
  currentInputHashes: Record<string, string>,
): Promise<Checkpoint[]> {
  const checkpoints = await readCheckpoints(root);
  const resumed: Checkpoint[] = [];
  for (const checkpoint of checkpoints) {
    const stale =
      checkpoint.status === 'approved' &&
      Object.entries(checkpoint.inputHashes).some(
        ([key, value]) => currentInputHashes[key] !== value,
      );
    const next = stale
      ? {
          ...checkpoint,
          status: 'stale' as const,
          recordedAt: new Date().toISOString(),
        }
      : checkpoint;
    if (stale) await appendCheckpoint(root, next);
    resumed.push(next);
  }
  return resumed;
}
