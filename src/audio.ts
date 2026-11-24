import { randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
  mkdtemp,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolveContained } from './paths.js';
import { sha256 } from './manifest.js';
import type { Beat, NarrationProvider, Shot } from './types.js';

export type AlignmentSource = 'provider' | 'manual' | 'estimated';

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface AudioAlignment {
  version: 1;
  transcriptSha256: string;
  audioSha256: string;
  durationMs: number;
  source: AlignmentSource;
  verified: boolean;
  /** Group-count-only timings are legacy estimates, not verified lexical mapping. */
  granularity?: 'word' | 'phrase';
  wordEvidence?: 'token-aligned' | 'manual-reviewed' | 'group-count-only';
  evidenceNotes?: string;
  phrases?: Array<{ text: string; startMs: number; endMs: number }>;
  words: WordTiming[];
}

export interface GeminiTtsOptions {
  approvedText: string;
  transcript: string;
  voiceName: string;
  model: string;
  apiKey?: string;
  chargeAuthorization: 'free' | 'authorized';
  preflight: TtsPreflight;
  requestId?: string;
  outputPath?: string;
  style?: string;
  fetchImpl?: typeof fetch;
}

export interface TtsPreflight {
  modelAvailable: boolean;
  quotaState: 'available' | 'exhausted' | 'unknown';
  chargeState: 'free' | 'authorized' | 'unauthorized' | 'unknown';
}

export interface TtsResult {
  requestId: string;
  audioPath: string;
  audioSha256: string;
  durationMs: number;
  mimeType: string;
  alignment?: AudioAlignment;
  alignmentPath?: string;
  alignmentSha256?: string;
  receiptPath?: string;
}

export interface KokoroTtsOptions {
  approvedText: string;
  transcript: string;
  pythonExecutable: string;
  modelPath: string;
  voicesPath: string;
  voice: string;
  outputPath?: string;
  requestId?: string;
  language?: string;
  speed?: number;
  alignmentPath?: string;
  environment?: NodeJS.ProcessEnv;
  /** Exact approved transcript spans; when provided, use measured phrase WAVs. */
  phraseSpans?: Array<{ startChar: number; endChar: number }>;
}

interface KokoroPhonemeTiming {
  phoneme: string;
  start: number;
  end: number;
}

interface KokoroRunResult {
  sampleRate: number;
  timings: KokoroPhonemeTiming[];
}

interface TtsReceipt {
  version: 1;
  requestId: string;
  provider: NarrationProvider;
  model: string;
  voiceName: string;
  transcriptSha256: string;
  status: 'dispatched' | 'unknown' | 'persisted';
  audioPath: string;
  audioSha256?: string;
  durationMs?: number;
  recordedAt: string;
  alignmentPath?: string;
  phonemeTimings?: KokoroPhonemeTiming[];
}

const tokenise = (value: string): string[] =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

function assertExactTranscript(approvedText: string, transcript: string): void {
  if (approvedText !== transcript)
    throw new Error('TTS transcript must match approved words exactly');
}

function parseWavDuration(bytes: Uint8Array): number {
  if (
    bytes.length < 12 ||
    Buffer.from(bytes.subarray(0, 4)).toString() !== 'RIFF' ||
    Buffer.from(bytes.subarray(8, 12)).toString() !== 'WAVE'
  )
    throw new Error('Gemini TTS response is not a RIFF WAV file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  let fmtSeen = false;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length)
      throw new Error('Gemini TTS WAV chunk is truncated');
    const chunk = Buffer.from(bytes.subarray(offset, offset + 4)).toString(
      'ascii',
    );
    if (chunk === 'fmt ') {
      if (size < 16) throw new Error('Gemini TTS WAV fmt chunk is truncated');
      if (
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) < 1
      )
        throw new Error('Gemini TTS WAV must contain PCM audio');
      byteRate = view.getUint32(start + 8, true);
      fmtSeen = true;
    }
    if (chunk === 'data') dataSize = size;
    offset = end + (size % 2);
  }
  if (!fmtSeen || !byteRate || !dataSize)
    throw new Error('Gemini TTS WAV has no measurable audio duration');
  return Math.round((dataSize / byteRate) * 1000);
}

function pcmL16ToWav(
  bytes: Uint8Array,
  sampleRate: number,
  channels: number,
): Buffer {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isInteger(channels) ||
    channels <= 0 ||
    bytes.length % 2 !== 0
  )
    throw new Error('Gemini TTS returned invalid audio/l16 parameters');
  const wav = Buffer.alloc(44 + bytes.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + bytes.length, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(bytes.length, 40);
  Buffer.from(bytes).copy(wav, 44);
  return wav;
}

function normalizeGeminiAudio(
  bytes: Uint8Array,
  mimeType: string,
): { bytes: Buffer; mimeType: 'audio/wav' } {
  if (mimeType === 'audio/wav') return { bytes: Buffer.from(bytes), mimeType };
  const match = /^audio\/l16;\s*rate=(\d+);\s*channels=(\d+)$/iu.exec(mimeType);
  if (!match)
    throw new Error(
      `Gemini TTS returned unsupported audio format: ${mimeType}`,
    );
  return {
    bytes: pcmL16ToWav(bytes, Number(match[1]), Number(match[2])),
    mimeType: 'audio/wav',
  };
}

async function writeNewFile(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = await resolveContained(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await link(temporary, target);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new Error(
      `refusing to overwrite audio output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeReceipt(
  root: string,
  requestId: string,
  receipt: TtsReceipt,
): Promise<void> {
  const path = await resolveContained(root, `receipts/tts-${requestId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(receipt, null, 2), 'utf8');
}

async function readReceipt(
  root: string,
  requestId: string,
): Promise<TtsReceipt | null> {
  try {
    return JSON.parse(
      await readFile(
        await resolveContained(root, `receipts/tts-${requestId}.json`),
        'utf8',
      ),
    ) as TtsReceipt;
  } catch {
    return null;
  }
}

function runKokoro(
  pythonExecutable: string,
  modelPath: string,
  voicesPath: string,
  voice: string,
  text: string,
  outputPath: string,
  language: string,
  speed: number,
  environment?: NodeJS.ProcessEnv,
): Promise<KokoroRunResult> {
  const script = `
import json
import sys
import soundfile as sf
from kokoro_onnx import Kokoro
model, voices, voice, text, output, language, speed = sys.argv[1:]
kokoro = Kokoro(model, voices)
if not kokoro.has_timings:
    raise RuntimeError('Kokoro model does not expose duration timings')
samples, sample_rate, timings = kokoro.create_timed(
    text, voice=voice, speed=float(speed), lang=language
)
sf.write(output, samples, sample_rate, subtype='PCM_16')
print(json.dumps({
    'sampleRate': sample_rate,
    'timings': [
        {'phoneme': item.phoneme, 'start': item.start, 'end': item.end}
        for item in timings
    ],
}))
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonExecutable,
      [
        '-c',
        script,
        modelPath,
        voicesPath,
        voice,
        text,
        outputPath,
        language,
        String(speed),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: environment ? { ...process.env, ...environment } : undefined,
      },
    );
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout) as KokoroRunResult);
        } catch (error) {
          reject(
            new Error(
              `Kokoro process returned invalid timing evidence: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      } else
        reject(new Error(`Kokoro process failed (${code}): ${stderr.trim()}`));
    });
  });
}

function groupKokoroTimings(
  transcript: string,
  timings: KokoroPhonemeTiming[],
): WordTiming[] {
  const words = tokenise(transcript);
  const groups: Array<{ startMs: number; endMs: number }> = [];
  let start: number | null = null;
  let end = 0;
  for (const timing of timings) {
    if (
      typeof timing.phoneme !== 'string' ||
      !Number.isFinite(timing.start) ||
      !Number.isFinite(timing.end) ||
      timing.start < 0 ||
      timing.end < timing.start
    )
      throw new Error('Kokoro returned invalid phoneme timing evidence');
    if (!timing.phoneme.trim()) {
      if (timing.end !== timing.start)
        throw new Error('Kokoro whitespace timing must be zero-width');
      if (start !== null) {
        groups.push({ startMs: Math.round(start), endMs: Math.round(end) });
        start = null;
      }
      continue;
    }
    if (timing.end <= timing.start)
      throw new Error('Kokoro returned zero-width phoneme timing');
    start ??= timing.start * 1000;
    end = timing.end * 1000;
  }
  if (start !== null)
    groups.push({ startMs: Math.round(start), endMs: Math.round(end) });
  if (groups.length !== words.length)
    throw new Error(
      `Kokoro timing evidence covers ${groups.length} phoneme groups but transcript has ${words.length} words`,
    );
  return words.map((word, index) => ({ ...groups[index]!, word }));
}

function validateKokoroAlignment(alignment: AudioAlignment): void {
  if (alignment.source !== 'provider' ||
      (alignment.wordEvidence === 'group-count-only' ? alignment.verified : !alignment.verified))
    throw new Error('Kokoro timing evidence has an inconsistent verification status');
  validateWordTimings(alignment);
}

export async function synthesizeKokoroTts(
  root: string,
  options: KokoroTtsOptions,
): Promise<TtsResult> {
  assertExactTranscript(options.approvedText, options.transcript);
  if (options.phraseSpans) return synthesizeKokoroPhrases(root, options);
  if (!options.voice.trim()) throw new Error('Kokoro voice is required');
  const requestId =
    options.requestId ??
    sha256(
      `kokoro-onnx\n${options.modelPath}\n${options.voicesPath}\n${options.voice}\n${options.language ?? 'en-us'}\n${options.speed ?? 1}\n${options.transcript}`,
    ).slice(0, 24);
  const audioPath = options.outputPath ?? 'audio/narration.wav';
  const alignmentPath = options.alignmentPath ?? 'audio/alignment.json';
  const receiptPath = `receipts/tts-${requestId}.json`;
  const previous = await readReceipt(root, requestId);
  if (
    previous?.status === 'persisted' &&
    previous.audioSha256 &&
    previous.durationMs !== undefined
  ) {
    const alignment = JSON.parse(
      await readFile(
        await resolveContained(root, previous.alignmentPath ?? alignmentPath),
        'utf8',
      ),
    ) as AudioAlignment;
    validateKokoroAlignment(alignment);
    return {
      requestId,
      audioPath: previous.audioPath,
      audioSha256: previous.audioSha256,
      durationMs: previous.durationMs,
      mimeType: 'audio/wav',
      alignment,
      alignmentPath: previous.alignmentPath ?? alignmentPath,
      receiptPath,
    };
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'storyframe-kokoro-'));
  const tempAudio = join(tempRoot, 'narration.wav');
  try {
    const run = await runKokoro(
      options.pythonExecutable,
      options.modelPath,
      options.voicesPath,
      options.voice,
      options.transcript,
      tempAudio,
      options.language ?? 'en-us',
      options.speed ?? 1,
      options.environment,
    );
    if (run.sampleRate !== 24_000)
      throw new Error(
        `Kokoro sample rate must be 24000 Hz, got ${run.sampleRate}`,
      );
    const bytes = await readFile(tempAudio);
    const durationMs = parseWavDuration(bytes);
    const audioSha256 = sha256(bytes);
    const alignment: AudioAlignment = {
      version: 1,
      transcriptSha256: sha256(options.transcript),
      audioSha256,
      durationMs,
      source: 'provider',
      verified: false,
      granularity: 'word',
      wordEvidence: 'group-count-only',
      evidenceNotes:
        'Kokoro phoneme group count matches transcript token count; lexical mapping is unverified. Strict timelines require reviewed word or measured phrase evidence.',
      words: groupKokoroTimings(options.transcript, run.timings),
    };
    validateKokoroAlignment(alignment);
    await writeNewFile(root, audioPath, bytes);
    await writeNewFile(
      root,
      alignmentPath,
      Buffer.from(
        JSON.stringify(
          {
            ...alignment,
            provider: 'kokoro-onnx',
            modelPath: options.modelPath,
            voice: options.voice,
            sampleRate: run.sampleRate,
            phonemeTimings: run.timings,
            normalization:
              'Kokoro phoneme runs are grouped at whitespace boundaries and labeled with the exact transcript tokens; no timing interpolation is used.',
          },
          null,
          2,
        ) + '\n',
      ),
    );
    await writeReceipt(root, requestId, {
      version: 1,
      requestId,
      provider: 'kokoro-onnx',
      model: 'kokoro-onnx',
      voiceName: options.voice,
      transcriptSha256: sha256(options.transcript),
      status: 'persisted',
      audioPath,
      audioSha256,
      durationMs,
      alignmentPath,
      phonemeTimings: run.timings,
      recordedAt: new Date().toISOString(),
    });
    return {
      requestId,
      audioPath,
      audioSha256,
      durationMs,
      mimeType: 'audio/wav',
      alignment,
      alignmentPath,
      receiptPath,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function synthesizeGeminiTts(
  root: string,
  options: GeminiTtsOptions,
): Promise<TtsResult> {
  assertExactTranscript(options.approvedText, options.transcript);
  if (
    options.chargeAuthorization !== 'free' &&
    options.chargeAuthorization !== 'authorized'
  )
    throw new Error('Gemini TTS charge authorization is required');
  if (!options.preflight.modelAvailable)
    throw new Error('Gemini TTS is blocked: selected model is unavailable');
  if (options.preflight.quotaState !== 'available')
    throw new Error(
      `Gemini TTS is blocked: quota is ${options.preflight.quotaState}`,
    );
  if (
    options.preflight.chargeState !== 'free' &&
    options.preflight.chargeState !== 'authorized'
  )
    throw new Error(
      `Gemini TTS is blocked: charge state is ${options.preflight.chargeState}`,
    );
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error('Gemini TTS is blocked: GEMINI_API_KEY is unavailable');
  const requestId =
    options.requestId ??
    sha256(
      `${options.model}\n${options.voiceName}\n${options.transcript}`,
    ).slice(0, 24);
  const previous = await readReceipt(root, requestId);
  if (previous?.status === 'unknown' || previous?.status === 'dispatched')
    throw new Error(
      `Gemini TTS request ${requestId} has an ${previous.status} receipt; reconcile before retry`,
    );
  if (
    previous?.status === 'persisted' &&
    previous.audioSha256 &&
    previous.durationMs !== undefined
  )
    return {
      requestId,
      audioPath: previous.audioPath,
      audioSha256: previous.audioSha256,
      durationMs: previous.durationMs,
      mimeType: 'audio/wav',
    };
  const audioPath = options.outputPath ?? 'audio/narration.wav';
  const receipt: TtsReceipt = {
    version: 1,
    requestId,
    provider: 'gemini-tts',
    model: options.model,
    voiceName: options.voiceName,
    transcriptSha256: sha256(options.transcript),
    status: 'dispatched',
    audioPath,
    recordedAt: new Date().toISOString(),
  };
  await writeReceipt(root, requestId, receipt);
  const body = {
    contents: [{ parts: [{ text: options.transcript }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } },
      },
    },
    ...(options.style
      ? { systemInstruction: { parts: [{ text: options.style }] } }
      : {}),
  };
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(`Gemini TTS request failed with HTTP ${response.status}`);
    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
        };
      }>;
    };
    const inline = payload.candidates?.[0]?.content?.parts?.find(
      (part) => part.inlineData,
    )?.inlineData;
    if (!inline?.data || !inline.mimeType)
      throw new Error(
        `Gemini TTS returned unsupported audio format: ${inline?.mimeType ?? 'missing'}`,
      );
    const normalized = normalizeGeminiAudio(
      Buffer.from(inline.data, 'base64'),
      inline.mimeType,
    );
    const bytes = normalized.bytes;
    const durationMs = parseWavDuration(bytes);
    await writeNewFile(root, audioPath, bytes);
    const audioSha256 = sha256(bytes);
    await writeReceipt(root, requestId, {
      ...receipt,
      status: 'persisted',
      audioSha256,
      durationMs,
      recordedAt: new Date().toISOString(),
    });
    return {
      requestId,
      audioPath,
      audioSha256,
      durationMs,
      mimeType: normalized.mimeType,
    };
  } catch (error) {
    await writeReceipt(root, requestId, {
      ...receipt,
      status: 'unknown',
      recordedAt: new Date().toISOString(),
    });
    throw new Error(
      `Gemini TTS request ${requestId} is unknown after dispatch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function matchingWordRange(
  text: string,
  words: WordTiming[],
): { startMs: number; endMs: number } {
  const wanted = tokenise(text);
  for (let start = 0; start <= words.length - wanted.length; start += 1) {
    const actual = words
      .slice(start, start + wanted.length)
      .map((word) => tokenise(word.word)[0]);
    if (actual.every((word, index) => word === wanted[index]))
      return {
        startMs: words[start]!.startMs,
        endMs: words[start + wanted.length - 1]!.endMs,
      };
  }
  throw new Error(`verified alignment cannot locate beat text: ${text}`);
}

export function retimeShotsFromAlignment(
  shots: Shot[],
  beats: Beat[],
  alignment: AudioAlignment,
): void {
  if (!alignment.verified || alignment.source === 'estimated')
    throw new Error(
      'verified word alignment is required before retiming shots',
    );
  if (alignment.granularity === 'phrase')
    throw new Error(
      'phrase alignment cannot be used for word-level shot retiming',
    );
  validateWordTimings(alignment);
  const byId = new Map(beats.map((beat) => [beat.id, beat]));
  let previousEnd = 0;
  for (const shot of shots) {
    const ranges = shot.beatIds.map((id) => {
      const beat = byId.get(id);
      if (!beat)
        throw new Error(`shot ${shot.id} references missing beat ${id}`);
      return matchingWordRange(beat.spokenText, alignment.words);
    });
    if (!ranges.length) continue;
    shot.audioStartMs = Math.min(...ranges.map((range) => range.startMs));
    shot.audioEndMs = Math.max(...ranges.map((range) => range.endMs));
    if (shot.audioStartMs < previousEnd)
      throw new Error(`shot ${shot.id} overlaps an earlier retimed shot`);
    previousEnd = shot.audioEndMs;
  }
}

function validateWordTimings(alignment: AudioAlignment): void {
  if (!Number.isFinite(alignment.durationMs) || alignment.durationMs <= 0)
    throw new Error('alignment duration must be positive');
  if (!alignment.words.length) throw new Error('alignment has no words');
  let previousEnd = 0;
  for (const timing of alignment.words) {
    if (
      !timing.word.trim() ||
      !Number.isFinite(timing.startMs) ||
      !Number.isFinite(timing.endMs) ||
      timing.startMs < previousEnd ||
      timing.endMs <= timing.startMs ||
      timing.endMs > alignment.durationMs
    )
      throw new Error(
        'alignment contains invalid or non-monotonic word timings',
      );
    previousEnd = timing.endMs;
  }
}

const srtTime = (milliseconds: number): string => {
  const ms = milliseconds % 1000;
  const totalSeconds = Math.floor(milliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

export function createSrt(alignment: AudioAlignment, maxWords = 8): string {
  if (alignment.granularity === 'phrase')
    throw new Error(
      'phrase-aligned audio must use verified syncTimeline subtitle cues',
    );
  if (!alignment.verified || alignment.source === 'estimated')
    throw new Error(
      'verified word alignment is required before creating captions',
    );
  if (!alignment.words.length)
    throw new Error('verified alignment has no words');
  if (!Number.isInteger(maxWords) || maxWords < 1)
    throw new Error('caption maxWords must be positive');
  validateWordTimings(alignment);
  const entries: string[] = [];
  for (let index = 0; index < alignment.words.length; index += maxWords) {
    const group = alignment.words.slice(index, index + maxWords);
    entries.push(
      `${entries.length + 1}\n${srtTime(group[0]!.startMs)} --> ${srtTime(group[group.length - 1]!.endMs)}\n${group.map((word) => word.word).join(' ')}\n`,
    );
  }
  return `${entries.join('\n')}\n`;
}

export async function writeSrt(
  root: string,
  relativePath: string,
  alignment: AudioAlignment,
): Promise<void> {
  const target = await resolveContained(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, createSrt(alignment), {
    encoding: 'utf8',
    flag: 'wx',
  });
}


/**
 * Synthesize exact ordered phrases in one local Kokoro process. The measured
 * PCM frame counts, not word-count estimates, establish the cue boundaries.
 * This does not claim phoneme-to-word alignment or replace listening QA.
 */
export async function synthesizeKokoroPhrases(
  root: string,
  options: KokoroTtsOptions,
): Promise<TtsResult> {
  assertExactTranscript(options.approvedText, options.transcript);
  if (!options.voice.trim()) throw new Error('Kokoro voice is required');
  const spans = options.phraseSpans;
  if (!spans?.length) throw new Error('exact phrase spans are required');
  const phrases: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (!Number.isInteger(span.startChar) || !Number.isInteger(span.endChar) ||
        span.startChar < cursor || span.endChar <= span.startChar ||
        span.endChar > options.transcript.length ||
        options.transcript.slice(cursor, span.startChar).trim())
      throw new Error('phrase spans must cover the exact transcript in order');
    const text = options.transcript.slice(span.startChar, span.endChar);
    if (!text.trim()) throw new Error('empty phrase span');
    phrases.push(text);
    cursor = span.endChar;
  }
  if (options.transcript.slice(cursor).trim())
    throw new Error('phrase spans omit trailing narration');
  const requestId = options.requestId ?? sha256(JSON.stringify({
    provider: 'kokoro-onnx-phrase', model: options.modelPath, voices: options.voicesPath,
    voice: options.voice, language: options.language ?? 'en-us', speed: options.speed ?? 1,
    transcript: options.transcript, spans,
  })).slice(0, 24);
  if (await readReceipt(root, requestId))
    throw new Error('phrase request already has a receipt; inspect existing outputs before retry');
  const audioPath = options.outputPath ?? 'audio/narration.wav';
  const alignmentPath = options.alignmentPath ?? 'audio/alignment.json';
  const receiptPath = `receipts/tts-${requestId}.json`;
  const temp = await mkdtemp(join(tmpdir(), 'storyframe-kokoro-phrases-'));
  const input = join(temp, 'phrases.json');
  const output = join(temp, 'narration.wav');
  const script = `
import json, os, sys, wave
import soundfile as sf
from kokoro_onnx import Kokoro
model, voices, voice, input_path, output, language, speed = sys.argv[1:]
with open(input_path, encoding='utf-8') as f:
    texts = json.load(f)
kokoro = Kokoro(model, voices)
counts = []
with wave.open(output, 'wb') as combined:
    combined.setnchannels(1)
    combined.setsampwidth(2)
    combined.setframerate(24000)
    for index, text in enumerate(texts):
        if getattr(kokoro, 'has_timings', False):
            samples, rate, _ = kokoro.create_timed(text, voice=voice, speed=float(speed), lang=language)
        else:
            samples, rate = kokoro.create(text, voice=voice, speed=float(speed), lang=language)
        if rate != 24000:
            raise RuntimeError('Unexpected Kokoro sample rate')
        path = os.path.join(os.path.dirname(output), 'part-%d.wav' % index)
        sf.write(path, samples, rate, subtype='PCM_16')
        with wave.open(path, 'rb') as part:
            if part.getnchannels() != 1 or part.getsampwidth() != 2 or part.getframerate() != 24000:
                raise RuntimeError('Expected mono PCM16 24 kHz phrase')
            frames = part.getnframes()
            data = part.readframes(frames)
            if frames < 1 or len(data) != frames * 2:
                raise RuntimeError('Incomplete phrase audio')
            combined.writeframesraw(data)
            counts.append(frames)
print(json.dumps({'sampleRate': 24000, 'frameCounts': counts}))
`;
  try {
    await writeFile(input, JSON.stringify(phrases), 'utf8');
    const measured = await new Promise<{ sampleRate: number; frameCounts: number[] }>((resolve, reject) => {
      const child = spawn(options.pythonExecutable, [
        '-c', script, options.modelPath, options.voicesPath, options.voice, input, output,
        options.language ?? 'en-us', String(options.speed ?? 1),
      ], { windowsHide: true, env: options.environment ? { ...process.env, ...options.environment } : undefined });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) { reject(new Error('Kokoro phrase synthesis failed: ' + stderr.slice(-600))); return; }
        try { resolve(JSON.parse(stdout) as { sampleRate: number; frameCounts: number[] }); }
        catch { reject(new Error('Kokoro phrase synthesis returned invalid frame evidence')); }
      });
    });
    if (measured.sampleRate !== 24000 || !Array.isArray(measured.frameCounts) ||
        measured.frameCounts.length !== phrases.length ||
        measured.frameCounts.some((count) => !Number.isSafeInteger(count) || count <= 0))
      throw new Error('Kokoro phrase frame evidence is incomplete');
    const bytes = await readFile(output);
    const durationMs = parseWavDuration(bytes);
    let frames = 0;
    const phraseTimings = measured.frameCounts.map((count, index) => {
      const startMs = Math.round(frames * 1000 / measured.sampleRate);
      frames += count;
      const endMs = Math.round(frames * 1000 / measured.sampleRate);
      if (endMs <= startMs) throw new Error('phrase interval is too short');
      return { text: phrases[index]!, startMs, endMs };
    });
    if (phraseTimings.at(-1)!.endMs !== durationMs ||
        bytes.length !== 44 + frames * 2)
      throw new Error('measured phrase samples disagree with final PCM WAV');
    const audioSha256 = sha256(bytes);
    const alignment: AudioAlignment = {
      version: 1,
      transcriptSha256: sha256(options.transcript),
      audioSha256, durationMs,
      source: 'provider', verified: true, granularity: 'phrase',
      evidenceNotes: 'Exact ordered transcript spans synthesized separately; boundaries measured from concatenated PCM frame counts. Listening QA is still required.',
      phrases: phraseTimings, words: [],
    };
    const alignmentBytes = Buffer.from(JSON.stringify({
      ...alignment, provider: 'kokoro-onnx', sampleRate: measured.sampleRate,
      frameCounts: measured.frameCounts, phraseSpans: spans,
    }, null, 2) + '\n');
    await writeNewFile(root, audioPath, bytes);
    await writeNewFile(root, alignmentPath, alignmentBytes);
    await writeReceipt(root, requestId, {
      version: 1, requestId, provider: 'kokoro-onnx', model: 'kokoro-onnx',
      voiceName: options.voice, transcriptSha256: alignment.transcriptSha256,
      status: 'persisted', audioPath, audioSha256, durationMs, alignmentPath,
      recordedAt: new Date().toISOString(),
    });
    return { requestId, audioPath, audioSha256, durationMs, mimeType: 'audio/wav',
      alignment, alignmentPath, alignmentSha256: sha256(alignmentBytes), receiptPath };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
