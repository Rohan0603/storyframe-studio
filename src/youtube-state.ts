import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Episode } from './types.js';
import { dirname } from 'node:path';
import { resolveContained } from './paths.js';

export interface PublicationVerification {
  videoId: string;
  state: 'scheduled' | 'public';
  privacyStatus: string;
  publishAt?: string;
  verifiedAt: string;
  source: 'youtube-data-api-v3';
  episodeId?: string;
  videoSha256?: string;
}

interface VideoStatus {
  privacyStatus?: string;
  publishAt?: string;
  uploadStatus?: string;
}

export function verifyPublicationStatus(
  videoId: string,
  status: VideoStatus,
  expected: { state: 'scheduled' | 'public'; publishAt?: string },
  at = new Date(),
): PublicationVerification {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId))
    throw new Error('invalid YouTube video ID');
  if (
    status.uploadStatus &&
    status.uploadStatus !== 'processed' &&
    status.uploadStatus !== 'uploaded'
  )
    throw new Error('YouTube has not accepted/processed the video upload');
  if (expected.state === 'scheduled') {
    if (!expected.publishAt || !/(?:Z|[+-]\d{2}:\d{2})$/.test(expected.publishAt) || !Number.isFinite(Date.parse(expected.publishAt)))
      throw new Error('expected schedule must specify an ISO publication time');
    if (
      status.privacyStatus !== 'private' ||
      !status.publishAt ||
      Date.parse(status.publishAt) !== Date.parse(expected.publishAt) ||
      Date.parse(status.publishAt) <= at.getTime()
    )
      throw new Error(
        'YouTube video is not scheduled for the expected future time',
      );
  } else if (status.privacyStatus !== 'public') {
    throw new Error('YouTube video is not public');
  }
  if (expected.state === 'public' && status.uploadStatus !== 'processed')
    throw new Error('public video upload processing is unconfirmed');
  if (expected.state === 'scheduled' && !['uploaded', 'processed'].includes(status.uploadStatus ?? ''))
    throw new Error('scheduled video upload status is unconfirmed');
  return {
    videoId,
    state: expected.state,
    privacyStatus: status.privacyStatus ?? 'unknown',
    ...(status.publishAt ? { publishAt: status.publishAt } : {}),
    verifiedAt: at.toISOString(),
    source: 'youtube-data-api-v3',
  };
}

/** Read-only OAuth request. This never schedules, uploads or publishes.
 * The OAuth token comes from the caller environment and is never persisted.
 */
export async function fetchAndVerifyYouTubeState(
  root: string,
  videoId: string,
  expected: { state: 'scheduled' | 'public'; publishAt?: string },
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  binding?: { episodeId: string; videoSha256: string },
): Promise<PublicationVerification & { receiptPath: string; receiptSha256: string }> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId))
    throw new Error('invalid YouTube video ID');
  if (!accessToken.trim())
    throw new Error('read-only YouTube OAuth token required');
  const url =
    'https://www.googleapis.com/youtube/v3/videos?part=status&id=' +
    encodeURIComponent(videoId);
  const response = await fetchImpl(url, {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json',
    },
  });
  if (!response.ok)
    throw new Error('YouTube status verification request failed');
  const json = (await response.json()) as {
    items?: Array<{ id?: string; status?: VideoStatus }>;
  };
  const resource = json.items?.find((item) => item.id === videoId);
  if (!resource?.status)
    throw new Error('YouTube status unavailable for this video');
  const result = { ...verifyPublicationStatus(videoId, resource.status, expected), ...binding };
  const receiptPath = `receipts/youtube-verification-${videoId}-${randomUUID()}.json`;
  const path = await resolveContained(root, receiptPath);
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return { ...result, receiptPath, receiptSha256: createHash('sha256').update(bytes).digest('hex') };
}


export async function verifyEpisodeYouTubeState(
  root: string,
  episode: Episode,
  videoId: string,
  expected: { state: 'scheduled' | 'public'; publishAt?: string },
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicationVerification & { receiptPath: string; receiptSha256: string }> {
  const target = episode.release.youtubeTarget;
  if (!target || !episode.release.publishAuthorization?.trim() ||
      target.videoId !== videoId || target.state !== expected.state ||
      (expected.state === 'scheduled' && Date.parse(target.publishAt ?? '') !== Date.parse(expected.publishAt ?? '')))
    throw new Error('verify-youtube requires the explicitly authorized episode publication target');
  const bytes = await readFile(await resolveContained(root, target.videoPath));
  if (createHash('sha256').update(bytes).digest('hex') !== target.videoSha256)
    throw new Error('publication target video bytes are stale');
  if (episode.production?.render && (episode.production.render.sha256 !== target.videoSha256 ||
      episode.production.render.path !== target.videoPath))
    throw new Error('publication target is not the approved render');
  const result = await fetchAndVerifyYouTubeState(root, videoId, expected, accessToken, fetchImpl,
    { episodeId: episode.episodeId, videoSha256: target.videoSha256 });
  episode.release.youtubeVerification = { path: result.receiptPath, sha256: result.receiptSha256 };
  return result;
}

export async function validatePublicationReceipt(root: string, episode: Episode): Promise<string[]> {
  const evidence = episode.release?.youtubeVerification;
  if (!evidence) return [];
  try {
    const target = episode.release.youtubeTarget;
    if (!target || !episode.release.publishAuthorization?.trim())
      throw new Error('missing authorized publication target');
    const bytes = await readFile(await resolveContained(root, evidence.path));
    if (createHash('sha256').update(bytes).digest('hex') !== evidence.sha256)
      throw new Error('publication receipt hash mismatch');
    const receipt = JSON.parse(bytes.toString('utf8')) as PublicationVerification;
    if (receipt.source !== 'youtube-data-api-v3' || receipt.episodeId !== episode.episodeId ||
        receipt.videoId !== target.videoId || receipt.videoSha256 !== target.videoSha256 ||
        receipt.state !== target.state || !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
        (target.state === 'public' && receipt.privacyStatus !== 'public') ||
        (target.state === 'scheduled' && (receipt.privacyStatus !== 'private' ||
          Date.parse(receipt.publishAt ?? '') !== Date.parse(target.publishAt ?? '') ||
          Date.parse(receipt.verifiedAt) >= Date.parse(receipt.publishAt ?? ''))))
      throw new Error('publication receipt does not match episode target');
    const video = await readFile(await resolveContained(root, target.videoPath));
    if (createHash('sha256').update(video).digest('hex') !== target.videoSha256)
      throw new Error('published video target is stale');
    return [];
  } catch (error) {
    return ['publication verification: ' + (error instanceof Error ? error.message : String(error))];
  }
}
