import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveContained } from './paths.js';
import { isStableId } from './ids.js';
import type {
  ReferenceBible,
  ReferenceEntry,
  ReferenceImage,
  ReferenceKind,
} from './types.js';
import type { StoryCanon } from './story-layer.js';

const HASH = /^[a-f0-9]{64}$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF = [Buffer.from('GIF87a'), Buffer.from('GIF89a')];
const WEBP_PREFIX = Buffer.from('RIFF');
const WEBP_SUFFIX = Buffer.from('WEBP');

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const referenceSha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function signatureMatches(
  bytes: Buffer,
  mimeType: ReferenceImage['mimeType'],
): boolean {
  if (mimeType === 'image/png')
    return (
      bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(PNG) &&
      bytes.subarray(12, 16).toString('ascii') === 'IHDR'
    );
  if (mimeType === 'image/jpeg')
    return (
      bytes.length >= 5 &&
      bytes.subarray(0, 3).equals(JPEG) &&
      bytes.subarray(bytes.length - 2).equals(Buffer.from([0xff, 0xd9]))
    );
  if (mimeType === 'image/gif')
    return (
      bytes.length >= 10 &&
      GIF.some((header) => bytes.subarray(0, 6).equals(header))
    );
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(WEBP_PREFIX) &&
    bytes.subarray(8, 12).equals(WEBP_SUFFIX)
  );
}

export function freezeReferenceBible(bible: ReferenceBible): string {
  const canonical = {
    bundleId: bible.bundleId,
    storyRevisionId: bible.storyRevisionId,
    storyRevisionSha256: bible.storyRevisionSha256,
    canonSha256: bible.canonSha256,
    entries: [...(Array.isArray(bible?.entries) ? bible.entries : [])]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        visualCanon: entry.visualCanon,
        canonEntityId: entry.canonEntityId ?? null,
        image: entry.image
          ? {
              path: entry.image.path,
              sha256: entry.image.sha256,
              mimeType: entry.image.mimeType,
              approved: entry.image.approved,
            }
          : null,
      })),
  };
  return referenceSha256(stableJson(canonical));
}

function validateEntryShape(
  entry: ReferenceEntry,
  seen: Set<string>,
  errors: string[],
): void {
  if (!isStableId(entry.id))
    errors.push(`reference ID is not stable: ${entry.id}`);
  if (seen.has(entry.id)) errors.push(`duplicate reference ID: ${entry.id}`);
  seen.add(entry.id);
  if (
    !(
      ['character', 'prop', 'environment', 'style'] as ReferenceKind[]
    ).includes(entry.kind)
  )
    errors.push(`reference ${entry.id} has an invalid kind`);
  if (typeof entry.name !== 'string' || typeof entry.visualCanon !== 'string')
    errors.push(`reference ${entry.id} requires textual canon strings`);
  else if (!entry.name.trim() || !entry.visualCanon.trim())
    errors.push(`reference ${entry.id} requires textual canon`);
  if (!entry.image || !HASH.test(entry.image.sha256) || !entry.image.approved)
    errors.push(`reference ${entry.id} requires an approved byte-hashed image`);
  if (
    !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
      entry.image?.mimeType,
    )
  )
    errors.push(`reference ${entry.id} has an unsupported image type`);
  if (entry.canonEntityId !== undefined && !isStableId(entry.canonEntityId))
    errors.push(`reference ${entry.id} has an invalid canon entity binding`);
}

export function validateReferenceBibleShape(
  bible: ReferenceBible,
  storyRevisionId?: string,
  storyRevisionSha256?: string,
  canonSha256?: string,
): string[] {
  const errors: string[] = [];
  if (!bible || typeof bible !== 'object')
    return ['reference bible must be an object'];
  if (!isStableId(bible.bundleId))
    errors.push('reference bundle ID is not stable');
  if (!isStableId(bible.storyRevisionId))
    errors.push('reference story revision ID is invalid');
  if (!HASH.test(bible.storyRevisionSha256) || !HASH.test(bible.canonSha256))
    errors.push('reference revision/canon hash is invalid');
  if (storyRevisionId && bible.storyRevisionId !== storyRevisionId)
    errors.push('reference bible is stale for the approved story revision');
  if (storyRevisionSha256 && bible.storyRevisionSha256 !== storyRevisionSha256)
    errors.push(
      'reference bible is stale for the approved script revision hash',
    );
  if (canonSha256 && bible.canonSha256 !== canonSha256)
    errors.push('reference bible is stale for the approved textual canon');
  if (!Array.isArray(bible.entries) || bible.entries.length === 0)
    errors.push('reference bible requires entries');
  const seen = new Set<string>();
  for (const entry of Array.isArray(bible.entries) ? bible.entries : []) {
    if (!entry || typeof entry !== 'object')
      errors.push('reference entry must be an object');
    else validateEntryShape(entry, seen, errors);
  }
  return errors;
}

export async function verifyReferenceImage(
  root: string,
  image: ReferenceImage,
): Promise<string[]> {
  const errors: string[] = [];
  try {
    const file = await resolveContained(root, image.path);
    const bytes = await readFile(file);
    if (referenceSha256(bytes) !== image.sha256)
      errors.push(`reference image hash mismatch: ${image.path}`);
    if (!signatureMatches(bytes, image.mimeType))
      errors.push(`reference image signature mismatch: ${image.path}`);
  } catch (error) {
    errors.push(
      `reference image unavailable or unsafe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return errors;
}

export async function validateReferenceBible(
  root: string,
  bible: ReferenceBible,
  expected?: {
    storyRevisionId?: string;
    storyRevisionSha256?: string;
    canonSha256?: string;
    canon?: StoryCanon;
  },
): Promise<{ valid: boolean; errors: string[]; freezeSha256: string }> {
  const errors = validateReferenceBibleShape(
    bible,
    expected?.storyRevisionId,
    expected?.storyRevisionSha256,
    expected?.canonSha256,
  );
  for (const entry of Array.isArray(bible?.entries) ? bible.entries : []) {
    if (
      entry?.canonEntityId &&
      expected?.canon &&
      ['character', 'prop'].includes(entry.kind)
    ) {
      const character = expected.canon.characters.find(
        (entity) => entity.id === entry.canonEntityId,
      );
      const prop = expected.canon.props.find(
        (entity) => entity.id === entry.canonEntityId,
      );
      if (!character && !prop)
        errors.push(`reference ${entry.id} binds to an unknown canon entity`);
      else if (
        (entry.kind === 'character' && !character) ||
        (entry.kind === 'prop' && !prop)
      )
        errors.push(
          `reference ${entry.id} has an incompatible canon entity kind`,
        );
    }
    if (entry?.image)
      errors.push(...(await verifyReferenceImage(root, entry.image)));
  }
  let freezeSha256 = '';
  try {
    freezeSha256 = freezeReferenceBible(bible);
  } catch {
    errors.push(
      'reference bible cannot be frozen because its shape is invalid',
    );
  }
  return {
    valid: errors.length === 0,
    errors,
    freezeSha256,
  };
}

export function canonHash(canon: StoryCanon): string {
  return referenceSha256(stableJson(canon));
}

export function resolveReferenceImage(
  bible: ReferenceBible,
  id: string,
): ReferenceEntry | undefined {
  return bible.entries.find((entry) => entry.id === id);
}
