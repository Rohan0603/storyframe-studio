import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveContained } from './paths.js';
import { readPersistedImage } from './image-generation.js';

export type ScreeningFlag = 'clear' | 'suspected' | 'unknown';

async function capture(program: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        child.kill();
        reject(new Error('screening output exceeds limit'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 500);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else
        reject(new Error(program + ' screening failed: ' + stderr.slice(-500)));
    });
  });
}

/** Conservative low-cost detector: flags long straight high-contrast panel gutters.
 * A clean result never replaces human pixel review: non-gutter collages may be missed.
 */
export function detectPanelGutters(
  gray: Uint8Array,
  width: number,
  height: number,
): boolean {
  if (gray.length !== width * height || width < 32 || height < 32)
    throw new Error('invalid grayscale image');
  // Demand a nearly uniform dividing line across most of the image.
  const threshold = 0.74;
  for (let x = Math.floor(width * 0.2); x < Math.floor(width * 0.8); x += 1) {
    let boundary = 0;
    for (let y = 0; y < height; y += 1) {
      const index = y * width + x;
      const left = gray[index - 2]!;
      const center = gray[index]!;
      const right = gray[index + 2]!;
      // A blank light/dark gutter between two unlike image regions.
      if (
        (center < 32 || center > 223) &&
        Math.abs(center - left) > 35 &&
        Math.abs(center - right) > 35
      )
        boundary += 1;
    }
    if (boundary / height >= threshold) return true;
  }
  for (let y = Math.floor(height * 0.2); y < Math.floor(height * 0.8); y += 1) {
    let boundary = 0;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const above = gray[index - width * 2]!;
      const center = gray[index]!;
      const below = gray[index + width * 2]!;
      if (
        (center < 32 || center > 223) &&
        Math.abs(center - above) > 35 &&
        Math.abs(center - below) > 35
      )
        boundary += 1;
    }
    if (boundary / width >= threshold) return true;
  }
  // Detect a thick divider too; a narrow-edge check alone misses blank bands.
  for (const vertical of [true, false]) {
    const across = vertical ? width : height;
    const along = vertical ? height : width;
    const at = (a: number, b: number): number =>
      gray[vertical ? b * width + a : a * width + b]!;
    for (const polarity of [0, 255]) {
      let start = -1;
      for (let x = Math.floor(across * 0.2); x <= Math.floor(across * 0.8); x++) {
        let near = 0;
        for (let b = 0; b < along; b++)
          if (Math.abs(at(x, b) - polarity) < 32) near++;
        if (near / along >= threshold) {
          if (start === -1) start = x;
        } else if (start !== -1) {
          const band = x - start;
          if (band >= 3 && band <= across * 0.15) {
            let contrast = 0;
            for (let b = 0; b < along; b++)
              if (Math.abs(at(start - 1, b) - polarity) > 35 &&
                  Math.abs(at(x, b) - polarity) > 35) contrast++;
            if (contrast / along >= threshold) return true;
          }
          start = -1;
        }
      }
    }
  }
  return false;
}

export interface ScreeningResult {
  version: 1;
  imagePath: string;
  imageSha256: string;
  collage: ScreeningFlag;
  text: 'clear' | 'detected' | 'unknown';
  checkedBy: string;
  notes: string;
  detectedText: string[];
}

export async function screenGeneratedStill(
  root: string,
  path: string,
  tools: { ffmpeg?: string; tesseract?: string } = {},
): Promise<ScreeningResult> {
  const image = await readPersistedImage(root, path);
  const absolute = await resolveContained(root, path);
  let collage: ScreeningFlag = 'unknown';
  let text: ScreeningResult['text'] = 'unknown';
  const notes: string[] = [];
  let detectedText: string[] = [];
  try {
    const pixels = await capture(tools.ffmpeg ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      absolute,
      '-vf',
      'scale=320:180,format=gray',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    collage = detectPanelGutters(pixels, 320, 180) ? 'suspected' : 'clear';
    notes.push(
      collage === 'suspected'
        ? 'possible multi-panel divider found'
        : 'no obvious straight panel gutters found',
    );
  } catch {
    notes.push('pixel gutter scan unavailable');
  }
  try {
    const output = await capture(tools.tesseract ?? 'tesseract', [
      absolute,
      'stdout',
      '--psm',
      '11',
    ]);
    detectedText = output
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /[\p{L}\p{N}]{3,}/u.test(line))
      .slice(0, 25);
    text = detectedText.length ? 'detected' : 'clear';
    notes.push(
      text === 'detected'
        ? 'OCR found readable text; inspect for signage, logos or title cards'
        : 'OCR found no readable text; inspect pixels anyway',
    );
  } catch {
    notes.push('local OCR unavailable; visual text remains unverified');
  }
  return {
    version: 1,
    imagePath: path,
    imageSha256: image.sha256,
    collage,
    text,
    checkedBy: 'ffmpeg-gutter-heuristic+local-tesseract',
    notes: notes.join('; '),
    detectedText,
  };
}

export async function persistStillScreening(
  root: string,
  path: string,
): Promise<ScreeningResult & { evidencePath: string; evidenceSha256: string }> {
  const result = await screenGeneratedStill(root, path);
  const evidencePath = `receipts/screen-${randomUUID()}.json`;
  const target = await resolveContained(root, evidencePath);
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
  return { ...result, evidencePath, evidenceSha256: createHash('sha256').update(bytes).digest('hex') };
}
