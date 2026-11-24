import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createSrt, writeSrt, type AudioAlignment } from './audio.js';
import { renderStillEpisode } from './render.js';
import { sha256, validateEpisode } from './manifest.js';
import { resolveContained } from './paths.js';
import { validateNarrativePlan } from './story-layer.js';
import type { Episode } from './types.js';
import { timelineSrt, validateSyncTimeline } from './sync.js';

export const PRODUCER_STAGES = [
  'research',
  'script',
  'beat-map',
  'references',
  'images',
  'narration',
  'captions',
  'render',
  'final-qa',
] as const;

export type ProducerStage = (typeof PRODUCER_STAGES)[number];
export type ProducerStageStatus =
  | 'approved'
  | 'needs-review'
  | 'blocked'
  | 'stale';

export interface ProducerPolicy {
  maxShots: number;
  maxDurationMs: number;
  maxImageAttemptsPerShot: number;
  maxCloudTtsRequests: number;
  imageCallsAuthorized: boolean;
  cloudTtsCallsAuthorized: boolean;
  budgetUsd: number;
  publishingAuthorized: false;
}

export interface ProducerApproval {
  stage: ProducerStage;
  fingerprint: string;
  reviewer: string;
  notes: string;
  recordedAt: string;
}

export type QaCheck =
  | 'audiovisual'
  | 'captionSync'
  | 'storyImageMatch'
  | 'rights'
  | 'originality'
  | 'claims'
  | 'aiDisclosure';

export const QA_CHECKS: readonly QaCheck[] = [
  'audiovisual',
  'captionSync',
  'storyImageMatch',
  'rights',
  'originality',
  'claims',
  'aiDisclosure',
];

export interface ProducerReview {
  reviewer: string;
  notes: string;
  renderSha256: string;
  checks: Record<
    QaCheck,
    { status: 'pass' | 'fail' | 'unknown'; notes: string }
  >;
}

export interface ProducerRender {
  path: string;
  sha256: string;
  durationMs: number;
  width: 1920;
  height: 1080;
  videoCodec: 'h264';
  audioCodec: 'aac';
}

export interface ProducerSession {
  version: 1;
  runId: string;
  policy: ProducerPolicy;
  approvals: ProducerApproval[];
  render?: ProducerRender;
  review?: ProducerReview;
  youtube?: {
    title: string;
    description: string;
    disclosure: string;
    tags: string[];
    chapters: Array<{ startMs: number; title: string }>;
  };
}

export interface ProducerAssessment {
  stage: ProducerStage;
  status: ProducerStageStatus;
  reasons: string[];
  fingerprint: string;
}

export interface ProducerReport {
  mode: Episode['mode'];
  stages: ProducerAssessment[];
  nextStage: ProducerStage | null;
  readyToPackage: boolean;
  publishAuthorized: false;
}

const HASH = /^[a-f0-9]{64}$/;

export function boundedPolicy(
  maxShots: number,
  maxDurationMs: number,
): ProducerPolicy {
  if (
    !Number.isInteger(maxShots) ||
    maxShots < 1 ||
    maxShots > 500 ||
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < 1000 ||
    maxDurationMs > 3_600_000
  )
    throw new Error('producer limits must be bounded positive integers');
  return {
    maxShots,
    maxDurationMs,
    maxImageAttemptsPerShot: 2,
    maxCloudTtsRequests: 0,
    imageCallsAuthorized: false,
    cloudTtsCallsAuthorized: false,
    budgetUsd: 0,
    publishingAuthorized: false,
  };
}

export function startProducer(
  episode: Episode,
  policy: ProducerPolicy,
): Episode {
  if (episode.production)
    throw new Error('producer session already exists; use status/resume');
  if (
    policy.publishingAuthorized !== false ||
    policy.imageCallsAuthorized ||
    policy.cloudTtsCallsAuthorized ||
    policy.budgetUsd !== 0 ||
    policy.maxCloudTtsRequests !== 0 ||
    policy.maxImageAttemptsPerShot < 1 ||
    policy.maxImageAttemptsPerShot > 10
  )
    throw new Error(
      'producer start cannot authorize generation charges or publishing',
    );
  boundedPolicy(policy.maxShots, policy.maxDurationMs);
  episode.production = {
    version: 1,
    runId: randomUUID(),
    policy,
    approvals: [],
  };
  return episode;
}

export function stageFingerprint(
  episode: Episode,
  stage: ProducerStage,
): string {
  const rank = PRODUCER_STAGES.indexOf(stage);
  if (rank < 0) throw new Error('unknown producer stage');
  const inputs: unknown[] = [
    episode.mode,
    episode.production?.policy,
    episode.script.sha256,
    episode.story,
  ];
  if (rank >= 1)
    inputs.push(episode.script.approved, episode.narration.textSha256);
  if (rank >= 2)
    inputs.push(
      episode.beats,
      episode.syncTimeline,
      episode.shots.map((shot) => ({
        id: shot.id,
        beatIds: shot.beatIds,
        requiredVisualEvent: shot.requiredVisualEvent,
        characters: shot.characters,
        props: shot.props,
        environment: shot.environment,
        composition: shot.composition,
        forbidden: shot.forbidden,
        visualPurpose: shot.visualPurpose,
        intentionalHold: shot.intentionalHold,
      })),
    );
  if (rank >= 3) inputs.push(episode.referenceBundle, episode.referenceBible);
  if (rank >= 4)
    inputs.push(
      episode.shots.map((shot) => ({
        image: shot.image,
        semanticReview: shot.semanticReview,
        referenceBinding: shot.referenceBinding,
      })),
    );
  if (rank >= 5)
    inputs.push(
      episode.narration.provider,
      episode.narration.audioSha256,
      episode.narration.audioDurationMs,
      episode.narration.alignmentVerified,
      episode.alignment,
    );
  if (rank >= 6) inputs.push(episode.narration.captionsPath);
  if (rank >= 7) inputs.push(episode.production?.render);
  if (rank >= 8)
    inputs.push(episode.production?.review, episode.release.creativeApproval);
  return sha256(JSON.stringify(inputs));
}

function assertProducer(episode: Episode): ProducerSession {
  const session = episode.production;
  if (
    !session ||
    session.version !== 1 ||
    !Array.isArray(session.approvals) ||
    !session.runId ||
    !session.policy ||
    session.policy.publishingAuthorized !== false
  )
    throw new Error('valid producer session is required');
  const policy = session.policy;
  if (
    policy.imageCallsAuthorized ||
    policy.cloudTtsCallsAuthorized ||
    policy.budgetUsd !== 0 ||
    policy.maxCloudTtsRequests !== 0
  )
    throw new Error(
      'unverified external generation authorization is not supported',
    );
  boundedPolicy(policy.maxShots, policy.maxDurationMs);
  return session;
}

async function approvedAlignment(
  root: string,
  episode: Episode,
): Promise<{ alignment: AudioAlignment | null; reasons: string[] }> {
  const reasons: string[] = [];
  if (
    !episode.narration.alignmentVerified ||
    episode.alignment?.timingStatus !== 'verified' ||
    !episode.narration.audioSha256 ||
    !episode.narration.audioDurationMs
  )
    return {
      alignment: null,
      reasons: ['narration needs verified audio and timing'],
    };
  try {
    const source = await readFile(
      await resolveContained(root, episode.narration.alignmentPath),
      'utf8',
    );
    const alignment = JSON.parse(source) as AudioAlignment;
    if (
      !alignment.verified ||
      alignment.source === 'estimated' ||
      alignment.audioSha256 !== episode.narration.audioSha256 ||
      alignment.durationMs !== episode.narration.audioDurationMs ||
      alignment.transcriptSha256 !== episode.narration.textSha256
    )
      throw new Error('alignment is not bound to current transcript/audio');
    if (alignment.granularity === 'phrase') {
      if (!episode.syncTimeline)
        throw new Error(
          'phrase alignment requires an audio-locked subtitle timeline',
        );
      const checked = await validateSyncTimeline(episode, root);
      if (!checked.valid)
        throw new Error(
          'phrase sync timeline is invalid: ' + checked.errors.join('; '),
        );
      if (!alignment.evidenceNotes?.trim() || !alignment.phrases?.length)
        throw new Error(
          'phrase alignment requires explicit measured phrase evidence',
        );
      let previousEnd = 0;
      for (const phrase of alignment.phrases) {
        if (
          !phrase.text?.trim() ||
          !Number.isInteger(phrase.startMs) ||
          !Number.isInteger(phrase.endMs) ||
          phrase.startMs < previousEnd ||
          phrase.endMs <= phrase.startMs ||
          phrase.endMs > alignment.durationMs
        )
          throw new Error(
            'phrase alignment has invalid or overlapping measured intervals',
          );
        previousEnd = phrase.endMs;
      }
      const phrasesText = alignment.phrases
        .map((p) => p.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const timelineText = episode.syncTimeline.records
        .map((r) => r.narration.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (phrasesText !== timelineText)
        throw new Error(
          'phrase evidence does not match the synchronized narration',
        );
    } else createSrt(alignment);
    return { alignment, reasons };
  } catch (error) {
    reasons.push(
      'verified alignment is unavailable or invalid: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return { alignment: null, reasons };
  }
}

async function stageEvidence(
  root: string,
  episode: Episode,
  stage: ProducerStage,
): Promise<string[]> {
  const session = assertProducer(episode);
  const policy = session.policy;
  const reasons: string[] = [];
  if (episode.shots.length > policy.maxShots)
    reasons.push('shot count exceeds the explicit producer limit');
  if (
    episode.alignment?.audioDurationMs !== null &&
    episode.alignment?.audioDurationMs !== undefined &&
    episode.alignment.audioDurationMs > policy.maxDurationMs
  )
    reasons.push('episode duration exceeds the explicit producer limit');
  if (reasons.length) return reasons;
  switch (stage) {
    case 'research':
      if (!episode.story) reasons.push('source-backed story is missing');
      else if (
        episode.story.sourceClaims.some((claim) => claim.status !== 'verified')
      )
        reasons.push('unresolved or disputed factual claim');
      break;
    case 'script':
      if (!episode.script.approved || !episode.story)
        reasons.push(
          'approved original script and story revision are required',
        );
      else
        reasons.push(
          ...validateNarrativePlan(episode.story.narrativePlan).map(
            (error) => `narrative plan: ${error}`,
          ),
        );
      break;
    case 'beat-map':
      if (!episode.beats.length || !episode.shots.length || !episode.alignment)
        reasons.push('script-bound visual beats and shot map are required');
      break;
    case 'references':
      if (episode.referenceBible?.status !== 'frozen')
        reasons.push('frozen, byte-hashed reference bible is required');
      break;
    case 'images':
      for (const shot of episode.shots) {
        if (
          shot.image.status !== 'approved' ||
          !shot.image.sha256 ||
          shot.semanticReview.status !== 'pass' ||
          shot.semanticReview.pixelsDecoded !== true ||
          shot.semanticReview.reviewedImageSha256 !== shot.image.sha256 ||
          !shot.semanticReview.notes.trim() ||
          !shot.referenceBinding
        )
          reasons.push(
            'shot ' + shot.id + ' lacks approved actual-pixel story QA',
          );
      }
      break;
    case 'narration':
      reasons.push(...(await approvedAlignment(root, episode)).reasons);
      break;
    case 'captions': {
      const verified = await approvedAlignment(root, episode);
      if (!verified.alignment) {
        reasons.push(...verified.reasons);
        break;
      }
      if (!episode.narration.captionsPath) {
        reasons.push('synchronized caption file is missing');
        break;
      }
      try {
        const currentSrt = await readFile(
          await resolveContained(root, episode.narration.captionsPath),
          'utf8',
        );
        const expectedSrt = episode.syncTimeline
          ? timelineSrt(episode.syncTimeline)
          : createSrt(verified.alignment);
        if (currentSrt.trim() !== expectedSrt.trim())
          reasons.push('caption file does not match verified word alignment');
      } catch {
        reasons.push('caption file is unavailable or unsafe');
      }
      break;
    }
    case 'render':
      if (!session.render || !HASH.test(session.render.sha256))
        reasons.push('verified render evidence is missing');
      else {
        try {
          const bytes = await readFile(
            await resolveContained(root, session.render.path),
          );
          if (sha256(bytes) !== session.render.sha256)
            reasons.push('render bytes are stale or modified');
          if (
            session.render.videoCodec !== 'h264' ||
            session.render.audioCodec !== 'aac' ||
            session.render.width !== 1920 ||
            session.render.height !== 1080
          )
            reasons.push('render verification has unsupported stream settings');
          if (
            episode.narration.audioDurationMs &&
            Math.abs(
              session.render.durationMs - episode.narration.audioDurationMs,
            ) > 500
          )
            reasons.push('render duration does not match narration');
        } catch {
          reasons.push('render file is missing or unsafe');
        }
      }
      break;
    case 'final-qa': {
      if (
        !session.review ||
        session.review.renderSha256 !== session.render?.sha256
      )
        reasons.push('independent QA is missing or stale for render');
      else {
        if (!session.review.reviewer.trim() || !session.review.notes.trim())
          reasons.push('independent QA needs reviewer and notes');
        for (const check of QA_CHECKS) {
          const evidence = session.review.checks?.[check];
          if (evidence?.status !== 'pass' || !evidence.notes.trim())
            reasons.push('QA gate incomplete: ' + check);
        }
      }
      if (!episode.release.creativeApproval?.trim())
        reasons.push('explicit owner creative approval is required');
      break;
    }
  }
  return reasons;
}

export async function assessProducer(
  root: string,
  episode: Episode,
): Promise<ProducerReport> {
  const session = assertProducer(episode);
  const validation = await validateEpisode(episode, root);
  const stages: ProducerAssessment[] = [];
  let stopped = false;
  for (const stage of PRODUCER_STAGES) {
    const fingerprint = stageFingerprint(episode, stage);
    const recent = [...session.approvals]
      .reverse()
      .find((item) => item.stage === stage);
    const reasons = stopped
      ? ['preceding production stage has not been accepted']
      : validation.valid
        ? await stageEvidence(root, episode, stage)
        : validation.errors;
    let status: ProducerStageStatus;
    if (recent && recent.fingerprint !== fingerprint) {
      status = 'stale';
      reasons.unshift('approval is stale for changed upstream dependencies');
    } else if (reasons.length) status = 'blocked';
    else if (recent?.fingerprint === fingerprint) status = 'approved';
    else if (
      episode.mode === 'auto' &&
      stage !== 'script' &&
      stage !== 'final-qa'
    )
      status = 'approved';
    else status = 'needs-review';
    stages.push({ stage, status, reasons, fingerprint });
    if (status !== 'approved') stopped = true;
  }
  const next = stages.find((step) => step.status !== 'approved');
  return {
    mode: episode.mode,
    stages,
    nextStage: next?.stage ?? null,
    readyToPackage: !next,
    publishAuthorized: false,
  };
}

export async function approveProducerStage(
  root: string,
  episode: Episode,
  stage: ProducerStage,
  reviewer: string,
  notes: string,
): Promise<void> {
  const session = assertProducer(episode);
  if (!PRODUCER_STAGES.includes(stage))
    throw new Error('invalid producer stage');
  if (!reviewer.trim() || !notes.trim())
    throw new Error('reviewer and specific review notes are required');
  const report = await assessProducer(root, episode);
  const step = report.stages.find((item) => item.stage === stage);
  const blockers = step?.reasons.filter(
    (reason) =>
      reason !== 'approval is stale for changed upstream dependencies',
  );
  if (
    !step ||
    blockers?.length ||
    (step.status !== 'needs-review' && step.status !== 'stale')
  )
    throw new Error(
      'producer stage cannot be approved without current evidence',
    );
  session.approvals.push({
    stage,
    fingerprint: step.fingerprint,
    reviewer: reviewer.trim(),
    notes: notes.trim(),
    recordedAt: new Date().toISOString(),
  });
  if (stage === 'final-qa') episode.release.productionQAPassed = true;
}

export async function recordProducerReview(
  episode: Episode,
  review: ProducerReview,
): Promise<void> {
  const session = assertProducer(episode);
  if (!session.render || review.renderSha256 !== session.render.sha256)
    throw new Error('QA report must bind the current render hash');
  if (
    typeof review.reviewer !== 'string' ||
    typeof review.notes !== 'string' ||
    !review.reviewer.trim() ||
    !review.notes.trim()
  )
    throw new Error('QA reviewer and review notes are required');
  for (const check of QA_CHECKS) {
    const item = review.checks?.[check];
    if (!item || item.status !== 'pass' || !item.notes?.trim())
      throw new Error(
        'QA gate must include independently recorded evidence: ' + check,
      );
  }
  session.review = review;
  episode.release.productionQAPassed = false;
}

function probeRender(path: string): Promise<{
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
  format?: { duration?: string };
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
      { windowsHide: true },
    );
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
      if (code !== 0)
        reject(new Error('FFprobe failed: ' + stderr.slice(0, 300)));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('FFprobe did not return JSON'));
        }
      }
    });
  });
}

export async function recordProducerRender(
  root: string,
  episode: Episode,
  path: string,
): Promise<void> {
  const session = assertProducer(episode);
  if (!episode.narration.alignmentVerified)
    throw new Error('verified narration alignment is required');
  const file = await resolveContained(root, path);
  const bytes = await readFile(file);
  const probe = await probeRender(file);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(probe.format?.duration) * 1000);
  if (
    video?.codec_name !== 'h264' ||
    video.width !== 1920 ||
    video.height !== 1080 ||
    audio?.codec_name !== 'aac' ||
    !Number.isInteger(durationMs) ||
    durationMs < 1 ||
    !episode.narration.audioDurationMs ||
    Math.abs(durationMs - episode.narration.audioDurationMs) > 500
  )
    throw new Error('render does not match verified HD H.264/AAC output');
  session.render = {
    path,
    sha256: sha256(bytes),
    durationMs,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
  };
  delete session.review;
  episode.release.productionQAPassed = false;
}

export async function generateProducerCaptions(
  root: string,
  episode: Episode,
  path = 'audio/producer.srt',
): Promise<string> {
  const report = await assessProducer(root, episode);
  if (
    report.stages.find((step) => step.stage === 'narration')?.status !==
    'approved'
  )
    throw new Error(
      'captions require accepted, verified narration and prior stages',
    );
  if (episode.narration.captionsPath)
    throw new Error(
      'caption path is already recorded; do not overwrite accepted captions',
    );
  const verified = await approvedAlignment(root, episode);
  if (episode.syncTimeline) {
    const sync = await validateSyncTimeline(episode, root);
    if (!sync.valid)
      throw new Error(
        `verified sync timeline is required before captions: ${sync.errors.join('; ')}`,
      );
    const target = await resolveContained(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, timelineSrt(episode.syncTimeline), {
      encoding: 'utf8',
      flag: 'wx',
    });
    episode.narration.captionsPath = path;
    return path;
  }
  if (!verified.alignment)
    throw new Error('verified audio alignment is required before captions');
  await writeSrt(root, path, verified.alignment);
  episode.narration.captionsPath = path;
  return path;
}

export async function generateProducerRender(
  root: string,
  episode: Episode,
  path = 'output/producer-video.mp4',
): Promise<ProducerRender> {
  const report = await assessProducer(root, episode);
  if (
    report.stages.find((step) => step.stage === 'captions')?.status !==
    'approved'
  )
    throw new Error(
      'render requires accepted, synchronized captions and prior stages',
    );
  if (episode.production?.render)
    throw new Error(
      'producer render already exists; no silent overwrite or retry',
    );
  const result = await renderStillEpisode(root, episode, { outputPath: path });
  await recordProducerRender(root, episode, result.outputPath);
  const render = episode.production?.render;
  if (!render) throw new Error('render evidence could not be persisted');
  return render;
}

export async function runAutoProducer(
  root: string,
  episode: Episode,
): Promise<ProducerReport> {
  if (episode.mode !== 'auto')
    throw new Error(
      'auto run is available only after explicitly starting Auto mode',
    );
  let report = await assessProducer(root, episode);
  if (
    report.nextStage === 'captions' &&
    !episode.narration.captionsPath &&
    report.stages.find((step) => step.stage === 'narration')?.status ===
      'approved'
  ) {
    await generateProducerCaptions(root, episode);
    await saveProducerEpisode(root, episode);
    report = await assessProducer(root, episode);
  }
  if (
    report.nextStage === 'render' &&
    report.stages.find((step) => step.stage === 'captions')?.status ===
      'approved'
  ) {
    await generateProducerRender(root, episode);
    await saveProducerEpisode(root, episode);
    report = await assessProducer(root, episode);
  }
  return report;
}

export async function writeProducerPackage(
  root: string,
  episode: Episode,
): Promise<string> {
  const session = assertProducer(episode);
  const report = await assessProducer(root, episode);
  if (!report.readyToPackage || !session.render)
    throw new Error('producer package requires all accepted QA stages');
  if (
    !session.youtube ||
    !session.youtube.title?.trim() ||
    !session.youtube.description?.trim() ||
    !session.youtube.disclosure?.trim() ||
    !Array.isArray(session.youtube.tags) ||
    !Array.isArray(session.youtube.chapters)
  )
    throw new Error('YouTube metadata and disclosure decision are required');
  const path = 'output/youtube-package.json';
  const target = await resolveContained(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    JSON.stringify(
      {
        version: 1,
        episodeId: episode.episodeId,
        video: session.render,
        captions: episode.narration.captionsPath,
        ...session.youtube,
        productionQAPassed: episode.release.productionQAPassed,
        creativeApproval: episode.release.creativeApproval,
        uploadAuthorized: false,
        monetizationGuaranteed: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  return path;
}

export async function saveProducerEpisode(
  root: string,
  episode: Episode,
): Promise<void> {
  const target = await resolveContained(root, 'episode.json');
  const temporary = await resolveContained(
    root,
    '.storyframe/episode-' + randomUUID() + '.tmp',
  );
  await mkdir(dirname(temporary), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(episode, null, 2) + '\n', {
      flag: 'wx',
    });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
