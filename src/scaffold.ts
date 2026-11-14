import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './manifest.js';
import { assertStableId } from './ids.js';
import type { Episode } from './types.js';

const emptyEpisode = (
  episodeId: string,
  scriptHash: string,
  bundleHash: string,
): Episode => ({
  schemaVersion: 1,
  episodeId,
  mode: 'guided',
  script: { path: 'script.md', sha256: scriptHash, approved: false },
  referenceBundle: { path: 'references/bundle.json', sha256: bundleHash },
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
});

export async function createEpisode(
  root: string,
  episodeId: string,
): Promise<Episode> {
  assertStableId(episodeId, 'episodeId');
  await mkdir(join(root, 'references'), { recursive: true });
  await mkdir(join(root, 'audio'), { recursive: true });
  const script = '# New StoryFrame episode\n';
  const bundle = '{}\n';
  const episode = emptyEpisode(episodeId, sha256(script), sha256(bundle));
  const files: Array<[string, string]> = [
    ['script.md', script],
    ['references/bundle.json', bundle],
    ['episode.json', JSON.stringify(episode, null, 2) + '\n'],
  ];
  for (const [path, contents] of files) {
    try {
      await writeFile(join(root, path), contents, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`refusing to overwrite existing file: ${path}`);
      throw error;
    }
  }
  return episode;
}
