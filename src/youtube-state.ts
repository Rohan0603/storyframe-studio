import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveContained } from './paths.js';

export interface PublicationVerification {
  videoId: string;
  state: 'scheduled' | 'public';
  privacyStatus: string;
  publishAt?: string;
  verifiedAt: string;
  source: 'youtube-data-api-v3';
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
    if (!expected.publishAt || !Number.isFinite(Date.parse(expected.publishAt)))
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
): Promise<PublicationVerification> {
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
  const result = verifyPublicationStatus(videoId, resource.status, expected);
  const path = await resolveContained(
    root,
    'receipts/youtube-verification-' +
      videoId +
      '-' +
      Date.now().toString(36) +
      '.json',
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
