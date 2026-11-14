import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveContained } from './paths.js';
import { sha256 } from './manifest.js';
import type { Episode } from './types.js';

export interface RenderResult {
  outputPath: string;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  durationMs: number;
}

interface ProbeResult {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
  format?: { duration?: string };
}

function run(
  program: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${program} failed with exit code ${code}: ${stderr.trim()}`,
          ),
        );
    });
  });
}

function concatQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function verifyImage(
  root: string,
  path: string,
  expectedHash: string,
): Promise<void> {
  const image = await resolveContained(root, path);
  const bytes = await readFile(image);
  if (sha256(bytes) !== expectedHash)
    throw new Error(`image hash mismatch for ${path}`);
  if (!bytes.length) throw new Error(`image is empty: ${path}`);
}

export async function renderStillEpisode(
  root: string,
  episode: Episode,
  options: {
    outputPath?: string;
    ffmpegPath?: string;
    ffprobePath?: string;
  } = {},
): Promise<RenderResult> {
  if (!episode.alignment || episode.alignment.timingStatus !== 'verified')
    throw new Error('render requires verified audio alignment');
  if (!episode.shots.length)
    throw new Error('render requires at least one shot');
  const audioPath = await resolveContained(root, episode.narration.audioPath);
  await access(audioPath);
  if (!episode.narration.audioSha256 || !episode.narration.audioDurationMs)
    throw new Error('render requires hash-bound narration audio and duration');
  if (sha256(await readFile(audioPath)) !== episode.narration.audioSha256)
    throw new Error('narration audio hash mismatch');
  if (episode.narration.audioDurationMs !== episode.alignment.audioDurationMs)
    throw new Error('narration duration is not bound to verified alignment');
  for (const shot of episode.shots) {
    if (
      shot.image.sha256 === null ||
      shot.semanticReview.status !== 'pass' ||
      shot.semanticReview.reviewedImageSha256 !== shot.image.sha256
    )
      throw new Error(
        `render requires an approved, hash-bound image for ${shot.id}`,
      );
    if (
      !Number.isInteger(shot.audioStartMs) ||
      !Number.isInteger(shot.audioEndMs) ||
      shot.audioStartMs < 0 ||
      shot.audioEndMs <= shot.audioStartMs ||
      shot.audioEndMs > episode.alignment.audioDurationMs
    )
      throw new Error(`render requires valid shot timing for ${shot.id}`);
    await verifyImage(root, shot.image.path, shot.image.sha256);
  }
  const outputPath = options.outputPath ?? 'output/video.mp4';
  const output = await resolveContained(root, outputPath);
  try {
    await access(output);
    throw new Error(`refusing to overwrite existing render: ${outputPath}`);
  } catch (error) {
    if (error instanceof Error && !/ENOENT/i.test(error.message)) throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const concatPath = await resolveContained(
    root,
    `.tmp/render-${randomUUID()}.txt`,
  );
  await mkdir(dirname(concatPath), { recursive: true });
  const concat = (
    await Promise.all(
      episode.shots.map(async (shot, index) => {
        const seconds = (shot.audioEndMs - shot.audioStartMs) / 1000;
        const imagePath = await resolveContained(root, shot.image.path);
        const line = `file ${concatQuote(imagePath)}\nduration ${seconds.toFixed(3)}`;
        return index === episode.shots.length - 1
          ? `${line}\nfile ${concatQuote(imagePath)}`
          : line;
      }),
    )
  ).join('\n');
  await writeFile(concatPath, concat, 'utf8');
  const temporaryOutput = `${output}.${randomUUID()}.tmp.mp4`;
  try {
    await run(options.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatPath,
      '-i',
      audioPath,
      '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      temporaryOutput,
    ]);
    const probe = JSON.parse(
      (
        await run(options.ffprobePath ?? 'ffprobe', [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          temporaryOutput,
        ])
      ).stdout,
    ) as ProbeResult;
    const video = probe.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    const audio = probe.streams?.find(
      (stream) => stream.codec_type === 'audio',
    );
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
    if (
      video?.codec_name !== 'h264' ||
      video.width !== 1920 ||
      video.height !== 1080
    )
      throw new Error('FFprobe rejected video codec or dimensions');
    if (audio?.codec_name !== 'aac' || durationMs <= 0)
      throw new Error('FFprobe rejected missing audio or duration');
    await rename(temporaryOutput, output);
    return {
      outputPath,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      audioCodec: audio.codec_name,
      durationMs,
    };
  } finally {
    await unlink(concatPath).catch(() => undefined);
    await unlink(temporaryOutput).catch(() => undefined);
  }
}
