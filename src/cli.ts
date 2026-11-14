#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendCheckpoint,
  readCheckpoints,
  resumeCheckpoints,
} from './checkpoints.js';
import { validateEpisode, sha256 } from './manifest.js';
import { createEpisode } from './scaffold.js';
import { resolveContained } from './paths.js';
import type { Episode } from './types.js';
import { densityNote, storyboardMarkdown } from './alignment.js';
import { recordImagePreflight } from './image-generation.js';

async function load(root: string): Promise<Episode> {
  return JSON.parse(
    await readFile(join(root, 'episode.json'), 'utf8'),
  ) as Episode;
}

async function inputHashes(
  root: string,
  episode: Episode,
): Promise<Record<string, string>> {
  const script = await readFile(
    await resolveContained(root, episode.script.path),
  );
  const refs = await readFile(
    await resolveContained(root, episode.referenceBundle.path),
  );
  const referenceBible = episode.referenceBible
    ? await readFile(await resolveContained(root, episode.referenceBible.path))
    : '';
  const dependencies = JSON.stringify({
    narration: episode.narration,
    alignment: episode.alignment,
    story: episode.story,
    beats: episode.beats,
    shots: episode.shots,
  });
  return {
    script: sha256(script),
    referenceBundle: sha256(refs),
    referenceBible: sha256(referenceBible),
    episodeDependencies: sha256(dependencies),
  };
}

export async function runCli(args: string[]): Promise<number> {
  const [command, root = '.', episodeId = 'episode-01'] = args;
  if (!command)
    throw new Error(
      'usage: storyframe <new|plan|align|references|validate|resume|image-preflight|render> <episode-root> [episode-id]',
    );
  if (command === 'new') {
    await createEpisode(root, episodeId);
    return 0;
  }
  if (command === 'render')
    throw new Error(
      'render is not implemented in the offline foundation; no provider or media call was made',
    );
  if (command === 'image-preflight') {
    const result = await recordImagePreflight(root, {
      nativeToolAvailable: false,
      referenceImagesSupported: false,
      outputBytesPersistable: false,
      quota: 'unknown',
      chargeState: 'unknown',
    });
    throw new Error(`image-preflight ${result.status.toUpperCase()}: ${result.reason}`);
  }
  const episode = await load(root);
  const validation = await validateEpisode(episode, root);
  if (!validation.valid)
    throw new Error(
      `episode validation failed:\n${validation.errors.join('\n')}`,
    );
  const hashes = await inputHashes(root, episode);
  if (command === 'validate') return 0;
  if (command === 'plan' || command === 'align') {
    await writeFile(
      join(root, 'storyboard.md'),
      `${storyboardMarkdown(episode)}\n${densityNote(episode)}\n`,
    );
    const existing = await readCheckpoints(root);
    const stage = command === 'align' ? 'alignment' : 'plan';
    const attempt =
      Math.max(
        0,
        ...existing
          .filter((checkpoint) => checkpoint.stage === stage)
          .map((checkpoint) => checkpoint.attempt),
      ) + 1;
    await appendCheckpoint(root, {
      stage,
      attempt,
      status: 'approved',
      inputHashes: hashes,
      outputHashes: {},
      recordedAt: new Date().toISOString(),
    });
    return 0;
  }
  if (command === 'references') {
    if (!episode.referenceBible)
      throw new Error('reference bible is required for references validation');
    if (episode.referenceBible.status !== 'frozen')
      throw new Error('reference bible must be frozen before approval');
    const existing = await readCheckpoints(root);
    const attempt =
      Math.max(
        0,
        ...existing
          .filter((checkpoint) => checkpoint.stage === 'references')
          .map((checkpoint) => checkpoint.attempt),
      ) + 1;
    await appendCheckpoint(root, {
      stage: 'references',
      attempt,
      status: 'approved',
      inputHashes: hashes,
      outputHashes: { freezeSha256: episode.referenceBible.freezeSha256 },
      recordedAt: new Date().toISOString(),
    });
    return 0;
  }
  if (command === 'resume') {
    await resumeCheckpoints(root, hashes);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
