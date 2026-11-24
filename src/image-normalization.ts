import { spawn } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveContained } from './paths.js';
import { readPersistedImage } from './image-generation.js';

export interface NormalizationEvidence {
  native: { path: string; sha256: string; width: number; height: number };
  output: { path: string; sha256: string; width: 1920; height: 1080 };
  tool: 'ffmpeg';
}

function execute(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error('FFmpeg image normalization failed: ' + stderr.slice(-600)),
        );
    });
  });
}

/**
 * Preserve the native generator image and separately create an exact 1080p PNG.
 * This does not overwrite either input or existing output; callers must
 * review the normalized bytes and bind their actual hash in episode.json.
 */
export async function normalizeGeneratedStill(
  root: string,
  nativePath: string,
  normalizedPath: string,
  ffmpegPath = 'ffmpeg',
): Promise<NormalizationEvidence> {
  if (nativePath === normalizedPath)
    throw new Error('normalization output must not overwrite the native still');
  const native = await readPersistedImage(root, nativePath);
  const input = await resolveContained(root, nativePath);
  const output = await resolveContained(root, normalizedPath);
  try {
    await lstat(output);
    throw new Error('normalization output already exists; refusing overwrite');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  await execute(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-n',
    '-i',
    input,
    '-vf',
    'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=rgb24',
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-vcodec',
    'png',
    output,
  ]);
  const image = await readPersistedImage(root, normalizedPath);
  if (image.width !== 1920 || image.height !== 1080)
    throw new Error('normalized image is not exactly 1920x1080');
  return {
    native: { path: nativePath, ...native },
    output: {
      path: normalizedPath,
      sha256: image.sha256,
      width: 1920,
      height: 1080,
    },
    tool: 'ffmpeg',
  };
}
