import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { assertSafeRelativePath, resolveContained } from './paths.js';
import {
  freezeReferenceBible,
  canonHash,
  validateReferenceBible,
} from './reference-bible.js';
import { hashNormalizedSpokenText } from './story-layer.js';
import type { Episode, ReferenceBible, Shot } from './types.js';
import {
  loadEpisodeEvolution,
  validateResolvedShotEvolution,
  type ValidatedEpisodeEvolution,
} from './series-evolution.js';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const HASH = /^[a-f0-9]{64}$/;

export type CapabilityState = 'available' | 'unknown' | 'unavailable';
export type QuotaState = 'available' | 'exhausted' | 'unknown';
export type ChargeState = 'free' | 'authorized' | 'unauthorized' | 'unknown';

export interface ImageGenerationCapability {
  nativeToolAvailable: boolean;
  referenceImagesSupported: boolean;
  outputBytesPersistable: boolean;
  quota: QuotaState;
  chargeState: ChargeState;
}

export interface CapabilityPreflight {
  status: 'ready' | 'blocked';
  reason?: string;
}

export interface ShotPromptPacket {
  shotId: string;
  beatIds: string[];
  narrationText: string;
  requiredVisualEvent: string;
  characters: string[];
  props: string[];
  environment: string;
  crop: string;
  forbidden: string[];
  referenceBinding: NonNullable<Shot['referenceBinding']>;
  /** Explicit current appearance/prop variant IDs included in the prompt hash. */
  activeSeriesStates?: Record<string, string>;
  imagePrompt?: string;
  seriesSnapshotSha256?: string;
  seriesBinding?: {
    seriesId: string;
    revisionId: string;
    bibleSha256: string;
  };
  /** Only references bound to the current state; never silently fall back. */
  activeStateVisualCanon?: Array<{
    entityId: string;
    stateId: string;
    references: Array<{ id: string; sha256: string; visualCanon: string }>;
  }>;
  storyRevisionId: string;
  scriptRevisionSha256: string;
  packetSha256: string;
}

export interface ValidatedReferenceBible {
  bible: ReferenceBible;
  freezeSha256: string;
  valid: true;
}

export interface BatchPolicy {
  maxShots: number;
  maxAttemptsPerShot: number;
  authorizedChargeState: ChargeState;
}

export interface BatchPlan {
  status: 'ready' | 'blocked';
  shotIds: string[];
  reason?: string;
}

export interface ImageReceipt {
  batchId?: string;
  attemptId: string;
  dispatchToken: string;
  /** Real provider receipt, if the native client exposed one. */
  nativeReceiptId?: string;
  providerEvidence?: { path: string; sha256: string };
  shotId?: string;
  packetSha256: string;
  tool: 'codex-desktop.image_gen';
  status: 'dispatched' | 'persisted' | 'rejected' | 'unknown' | 'reconciled';
  outputPath?: string;
  sha256?: string;
  width?: number;
  height?: number;
  failure?: string;
  recordedAt: string;
}

export type ReceiptTransition =
  | { status: 'dispatched' }
  | {
      status: 'persisted';
      dispatchToken?: string;
      nativeReceiptId?: string;
      providerEvidence?: { path: string; sha256: string };
      outputPath: string;
      sha256: string;
      width: number;
      height: number;
    }
  | { status: 'rejected' | 'unknown'; failure: string };

export function createBatchPlan(
  shotIds: string[],
  policy: BatchPolicy,
): BatchPlan {
  if (!Number.isInteger(policy.maxShots) || policy.maxShots < 1)
    return {
      status: 'blocked',
      shotIds,
      reason: 'batch maxShots must be positive',
    };
  if (
    !Number.isInteger(policy.maxAttemptsPerShot) ||
    policy.maxAttemptsPerShot < 1
  )
    return {
      status: 'blocked',
      shotIds,
      reason: 'batch maxAttemptsPerShot must be positive',
    };
  if (!['free', 'authorized'].includes(policy.authorizedChargeState))
    return {
      status: 'blocked',
      shotIds,
      reason: 'batch charge authorization is not explicit',
    };
  if (shotIds.length > policy.maxShots)
    return {
      status: 'blocked',
      shotIds,
      reason: 'batch exceeds configured shot limit',
    };
  return { status: 'ready', shotIds };
}

export function createDispatchReceipt(
  attemptId: string,
  shotId: string,
  packetSha256: string,
): ImageReceipt {
  if (!attemptId || !shotId || !HASH.test(packetSha256))
    throw new Error(
      'dispatch receipt requires stable identifiers and packet hash',
    );
  return {
    attemptId,
    dispatchToken: randomUUID(),
    shotId,
    packetSha256,
    tool: 'codex-desktop.image_gen',
    status: 'dispatched',
    recordedAt: new Date().toISOString(),
  };
}

export async function loadValidatedReferenceBible(
  root: string,
  bible: ReferenceBible,
  expected?: Parameters<typeof validateReferenceBible>[2],
): Promise<ValidatedReferenceBible> {
  const result = await validateReferenceBible(root, bible, expected);
  if (!result.valid)
    throw new Error(
      `reference bible is not validated: ${result.errors.join('; ')}`,
    );
  return { bible, freezeSha256: result.freezeSha256, valid: true };
}

export function transitionReceipt(
  receipt: ImageReceipt,
  transition: ReceiptTransition,
): ImageReceipt {
  if (receipt.status === 'unknown')
    throw new Error(
      'unknown receipt requires reconcile before retry or replacement',
    );
  if (receipt.status !== 'dispatched')
    throw new Error(`receipt cannot transition from ${receipt.status}`);
  if (transition.status === 'dispatched')
    throw new Error('receipt cannot retry without an explicit new attempt');
  const dispatchToken =
    transition.status === 'persisted'
      ? transition.dispatchToken
      : receipt.dispatchToken;
  return {
    ...receipt,
    ...transition,
    dispatchToken: dispatchToken ?? receipt.dispatchToken,
    recordedAt: new Date().toISOString(),
  };
}

export function reconcileReceipt(
  receipt: ImageReceipt,
  transition: Extract<ReceiptTransition, { status: 'persisted' | 'rejected' }>,
): ImageReceipt {
  if (receipt.status !== 'unknown')
    throw new Error('only unknown receipts can be reconciled');
  return {
    ...receipt,
    ...transition,
    status: 'reconciled',
    recordedAt: new Date().toISOString(),
  };
}

export interface PixelInspection {
  imageSha256: string;
  pixelsDecoded: boolean;
  requiredActionPresent: boolean;
  requiredCharactersPresent: boolean;
  requiredPropsPresent: boolean;
  continuityMatches: boolean;
  forbiddenTextPresent: boolean;
  staleReferences: boolean;
  collageSuspected?: boolean;
  unwantedLogoPresent?: boolean;
  notes: string;
}

export interface PixelReviewResult {
  status: 'approved' | 'rejected' | 'unknown';
  reasons: string[];
  imageSha256: string;
}

export interface ImageOutputMetadata {
  attemptId: string;
  packetSha256: string;
  tool: 'codex-desktop.image_gen';
  nativeReceiptId?: string;
  providerEvidence?: {
    path: string;
    sha256: string;
    source: 'codex-desktop.image_gen';
    responseSha256: string;
    dispatchToken: string;
  };
}

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

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

export function createShotPromptPacket(
  episode: Episode,
  shot: Shot,
  scriptText: string,
  validatedReferences?: ValidatedReferenceBible,
  validatedEvolution?: ValidatedEpisodeEvolution,
): ShotPromptPacket {
  if (!shot.referenceBinding)
    throw new Error(`shot ${shot.id} requires a frozen reference binding`);
  const revision = episode.story?.scriptRevision;
  if (!revision || revision.text !== scriptText)
    throw new Error(
      'exact narration span must use the authoritative script revision',
    );
  if (revision.textSha256 !== hashNormalizedSpokenText(revision.text))
    throw new Error('script revision text hash is invalid');
  if (hashNormalizedSpokenText(scriptText) !== revision.textSha256)
    throw new Error('script revision text hash does not match loaded script');
  if (!validatedReferences?.valid)
    throw new Error(
      'prompt packet requires an actually validated reference bible',
    );
  if (
    validatedReferences.freezeSha256 !==
    freezeReferenceBible(validatedReferences.bible)
  )
    throw new Error('validated reference bible freeze hash is invalid');
  const beats = shot.beatIds.map((id) =>
    episode.beats.find((beat) => beat.id === id),
  );
  if (beats.some((beat) => !beat))
    throw new Error(`shot ${shot.id} references a missing beat`);
  const spans = beats.map((beat) => {
    if (!beat) throw new Error(`shot ${shot.id} references a missing beat`);
    if (
      beat.scriptRevisionId !== revision.id ||
      beat.scriptRevisionSha256 !== revision.textSha256 ||
      !Number.isInteger(beat.scriptStartChar) ||
      !Number.isInteger(beat.scriptEndChar) ||
      beat.scriptStartChar < 0 ||
      beat.scriptEndChar <= beat.scriptStartChar ||
      beat.scriptEndChar > revision.text.length
    )
      throw new Error(`beat revision binding is invalid for shot ${shot.id}`);
    return beat;
  });
  for (let index = 0; index < spans.length; index += 1) {
    const beat = spans[index]!;
    if (index > 0) {
      const previous = spans[index - 1]!;
      if (beat.scriptStartChar < previous.scriptEndChar)
        throw new Error(`beat spans overlap for shot ${shot.id}`);
      if (beat.scriptStartChar !== previous.scriptEndChar)
        throw new Error(`beat spans are not contiguous for shot ${shot.id}`);
    }
  }
  for (const beat of spans)
    if (
      revision.text.slice(beat.scriptStartChar, beat.scriptEndChar) !==
      beat.spokenText
    )
      throw new Error(`beat span is not exact narration for shot ${shot.id}`);
  const narrationText = revision.text.slice(
    spans[0]!.scriptStartChar,
    spans[spans.length - 1]!.scriptEndChar,
  );
  if (
    shot.referenceBinding.storyRevisionId !== revision.id ||
    shot.referenceBinding.freezeSha256 !==
      episode.referenceBible?.freezeSha256 ||
    shot.referenceBinding.freezeSha256 !== validatedReferences.freezeSha256 ||
    validatedReferences.bible.storyRevisionId !== revision.id ||
    validatedReferences.bible.storyRevisionSha256 !== revision.textSha256
  )
    throw new Error(`shot ${shot.id} has stale frozen references`);
  const entries = new Map(
    validatedReferences.bible.entries.map((entry) => [entry.id, entry]),
  );
  for (const id of shot.referenceBinding.referenceIds) {
    const entry = entries.get(id);
    if (
      !entry?.image.approved ||
      shot.referenceBinding.referenceHashes[id] !== entry.image.sha256
    )
      throw new Error(
        `shot ${shot.id} reference binding does not match loaded reference bible`,
      );
  }
  if (episode.series?.evolution) {
    if (!validatedEvolution)
      throw new Error('generation requires validated series evolution');
    const errors = validateResolvedShotEvolution(
      episode,
      shot,
      validatedEvolution,
      validatedReferences.bible,
    );
    if (errors.length) throw new Error(errors.join('; '));
  }
  if (episode.imagePolicy && !shot.imagePrompt?.trim())
    throw new Error('strict image generation requires an exact image prompt');
  const activeStateVisualCanon = Object.entries(
    shot.seriesBinding?.entityStates ?? {},
  ).map(([entityId, stateId]) => ({
    entityId,
    stateId,
    references: validatedReferences.bible.entries
      .filter(
        (entry) =>
          entry.canonEntityId === entityId &&
          shot.referenceBinding!.referenceIds.includes(entry.id),
      )
      .map((entry) => ({
        id: entry.id,
        sha256: entry.image.sha256,
        visualCanon: entry.visualCanon,
      })),
  }));
  const packetWithoutHash = {
    shotId: shot.id,
    beatIds: shot.beatIds,
    narrationText,
    requiredVisualEvent: shot.requiredVisualEvent,
    characters: shot.characters,
    props: shot.props,
    environment: shot.environment,
    crop: shot.composition,
    forbidden: shot.forbidden,
    referenceBinding: shot.referenceBinding,
    ...(episode.imagePolicy || episode.series?.evolution
      ? { imagePrompt: shot.imagePrompt ?? '' }
      : {}),
    ...(validatedEvolution
      ? { seriesSnapshotSha256: validatedEvolution.snapshotSha256 }
      : {}),
    ...(shot.seriesBinding?.entityStates
      ? {
          activeSeriesStates: shot.seriesBinding.entityStates,
          activeStateVisualCanon,
        }
      : {}),
    storyRevisionId: revision.id,
    scriptRevisionSha256: revision.textSha256,
    ...(episode.series
      ? {
          seriesBinding: {
            seriesId: episode.series.seriesId,
            revisionId: episode.series.revisionId,
            bibleSha256: episode.series.bibleSha256,
          },
        }
      : {}),
  };
  return {
    ...packetWithoutHash,
    packetSha256: sha256(stableJson(packetWithoutHash)),
  };
}

export function preflightImageGeneration(
  capability: ImageGenerationCapability,
): CapabilityPreflight {
  if (!capability.nativeToolAvailable)
    return {
      status: 'blocked',
      reason: 'native Codex Desktop image_gen is unavailable',
    };
  if (!capability.referenceImagesSupported)
    return {
      status: 'blocked',
      reason: 'native image_gen reference-image support is unavailable',
    };
  if (!capability.outputBytesPersistable)
    return {
      status: 'blocked',
      reason: 'native image_gen output bytes cannot be persisted and inspected',
    };
  if (capability.quota !== 'available')
    return {
      status: 'blocked',
      reason: `image_gen quota is ${capability.quota}`,
    };
  if (!['free', 'authorized'].includes(capability.chargeState))
    return {
      status: 'blocked',
      reason: `image_gen charge state is ${capability.chargeState}`,
    };
  return { status: 'ready' };
}

function readPng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error('image signature is not PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const compressed: Buffer[] = [];
  let sawEnd = false;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('truncated PNG chunk');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (
      crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== expectedCrc
    )
      throw new Error(`PNG CRC mismatch in ${type}`);
    if (type === 'IHDR') {
      if (sawHeader || offset !== 8 || length !== 13)
        throw new Error('invalid PNG IHDR ordering');
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (
        !width ||
        !height ||
        bitDepth !== 8 ||
        ![0, 2, 4, 6].includes(colorType) ||
        data[12] !== 0
      )
        throw new Error('unsupported PNG decode parameters');
    } else if (type === 'IDAT') {
      if (!sawHeader || sawEnd) throw new Error('invalid PNG IDAT ordering');
      sawData = true;
      compressed.push(data);
    } else if (type === 'IEND') {
      if (!sawHeader || !sawData || length !== 0)
        throw new Error('invalid PNG IEND ordering');
      sawEnd = true;
      offset = end;
      break;
    }
    offset = end;
  }
  if (
    !width ||
    !height ||
    !compressed.length ||
    !sawEnd ||
    offset !== bytes.length
  )
    throw new Error('PNG has no complete decodable image');
  const channels = [1, 0, 3, 1, 2, 0, 4][colorType]!;
  const rowBytes = width * channels;
  const decoded = inflateSync(Buffer.concat(compressed));
  if (decoded.length !== (rowBytes + 1) * height)
    throw new Error('PNG pixel data length is invalid');
  let previous = Buffer.alloc(rowBytes);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = decoded[cursor++]!;
    const row = Buffer.from(decoded.subarray(cursor, cursor + rowBytes));
    cursor += rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= channels ? row[x - channels]! : 0;
      const up = previous[x]!;
      const upperLeft = x >= channels ? previous[x - channels]! : 0;
      if (filter === 1) row[x] = (row[x]! + left) & 255;
      else if (filter === 2) row[x] = (row[x]! + up) & 255;
      else if (filter === 3)
        row[x] = (row[x]! + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        row[x] =
          (row[x]! +
            (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) &
          255;
      } else if (filter !== 0) throw new Error('unsupported PNG filter');
    }
    previous = row;
  }
  return { width, height };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function assertSecureParents(
  root: string,
  target: string,
): Promise<void> {
  const rootReal = await realpath(root);
  const rel = relative(rootReal, dirname(target));
  if (rel.startsWith(`..${sep}`) || rel === '..')
    throw new Error('output parent escapes episode root');
  let current = rootReal;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`output parent is not a regular directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
}

async function preserveAttempt(
  root: string,
  attemptId: string,
  bytes: Buffer,
): Promise<string> {
  const directory = await resolveContained(root, 'attempts').catch(async () =>
    join(root, 'attempts'),
  );
  await assertSecureParents(root, directory);
  await mkdir(directory, { recursive: false }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const name = `attempts/${attemptId}${suffix ? `-${suffix}` : ''}.bin`;
    const target = await resolveContained(root, name);
    try {
      await writeFile(target, bytes, { flag: 'wx' });
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate unique attempt evidence path');
}

export async function ingestImageOutput(
  root: string,
  outputPath: string,
  bytes: Buffer,
  metadata: ImageOutputMetadata,
): Promise<{
  status: 'persisted';
  sha256: string;
  width: number;
  height: number;
  nativeReceiptId?: string;
  providerEvidence?: { path: string; sha256: string };
}> {
  const target = await resolveContained(root, outputPath);
  let dimensions: { width: number; height: number };
  try {
    dimensions = readPng(bytes);
  } catch (error) {
    await preserveAttempt(root, metadata.attemptId, bytes);
    throw new Error(
      `image output rejected after preservation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await assertSecureParents(root, target);
  await assertRegularOrMissing(target);
  try {
    await lstat(target);
    await preserveAttempt(root, metadata.attemptId, bytes);
    throw new Error('output already exists and will not be overwritten');
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !(error instanceof Error && /will not be overwritten/.test(error.message))
    )
      throw error;
    if (error instanceof Error && /will not be overwritten/.test(error.message))
      throw error;
  }
  assertSafeRelativePath(metadata.attemptId, 'attempt ID');
  await writeFile(target, bytes, { flag: 'wx' });
  return {
    status: 'persisted',
    sha256: sha256(bytes),
    ...dimensions,
    ...(metadata.nativeReceiptId
      ? { nativeReceiptId: metadata.nativeReceiptId }
      : {}),
    ...(metadata.providerEvidence
      ? { providerEvidence: metadata.providerEvidence }
      : {}),
  };
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`output path is not a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function inspectPixels(inspection: PixelInspection): PixelReviewResult {
  if (!HASH.test(inspection.imageSha256) || !inspection.pixelsDecoded)
    return {
      status: 'unknown',
      imageSha256: inspection.imageSha256,
      reasons: ['actual pixels were not decoded and inspected'],
    };
  const reasons: string[] = [];
  if (!inspection.requiredActionPresent)
    reasons.push('required visual action is absent');
  if (!inspection.requiredCharactersPresent)
    reasons.push('required character is absent or identity drifted');
  if (!inspection.requiredPropsPresent)
    reasons.push('required prop is absent or incorrect');
  if (!inspection.continuityMatches)
    reasons.push('character/prop continuity does not match frozen references');
  if (inspection.forbiddenTextPresent)
    reasons.push('unwanted text is present in pixels');
  if (inspection.staleReferences) reasons.push('references are stale');
  if (inspection.collageSuspected)
    reasons.push('suspected multi-panel or contact sheet image');
  if (inspection.unwantedLogoPresent) reasons.push('unwanted logo is visible');
  if (!inspection.notes.trim())
    reasons.push('independent pixel review notes are missing');
  return {
    status: reasons.length ? 'rejected' : 'approved',
    imageSha256: inspection.imageSha256,
    reasons,
  };
}

export async function readPersistedImage(
  root: string,
  outputPath: string,
): Promise<{ sha256: string; width: number; height: number }> {
  const target = await resolveContained(root, outputPath);
  await assertSecureParents(root, target);
  await assertRegularOrMissing(target);
  const bytes = await readFile(target);
  const dimensions = readPng(bytes);
  return { ...dimensions, sha256: sha256(bytes) };
}

export interface PreflightReceipt {
  status: 'blocked' | 'ready';
  quota: QuotaState;
  chargeState: ChargeState;
  reason?: string;
  providerInvoked: false;
  recordedAt: string;
}

export async function recordImagePreflight(
  root: string,
  capability: ImageGenerationCapability,
): Promise<PreflightReceipt> {
  const result = preflightImageGeneration(capability);
  const receipt: PreflightReceipt = {
    status: result.status,
    quota: capability.quota,
    chargeState: capability.chargeState,
    ...(result.reason ? { reason: result.reason } : {}),
    providerInvoked: false,
    recordedAt: new Date().toISOString(),
  };
  const path = await resolveContained(root, 'receipts/image-preflight.json');
  await assertSecureParents(root, path);
  await writeFile(path, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

export class ReceiptJournal {
  private receipts: ImageReceipt[] = [];
  private loaded = false;
  constructor(
    private readonly root: string,
    private readonly batchId: string,
    private readonly shotIds: string[],
    private readonly policy: BatchPolicy,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const path = await resolveContained(
      this.root,
      `receipts/${this.batchId}.json`,
    );
    try {
      this.receipts = JSON.parse(
        (await readFile(path)).toString('utf8'),
      ) as ImageReceipt[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.receipts = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const path = await resolveContained(
      this.root,
      `receipts/${this.batchId}.json`,
    );
    await assertSecureParents(this.root, path);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.receipts, null, 2), {
      flag: 'wx',
    });
    await rename(temporary, path);
  }

  async dispatch(
    attemptId: string,
    shotId: string,
    packetSha256: string,
  ): Promise<ImageReceipt> {
    await this.load();
    if (!['free', 'authorized'].includes(this.policy.authorizedChargeState))
      throw new Error('dispatch requires explicit charge authorization');
    assertSafeRelativePath(attemptId, 'attempt ID');
    if (!this.shotIds.includes(shotId))
      throw new Error('shot is not bound to this batch');
    if (this.receipts.some((receipt) => receipt.attemptId === attemptId))
      throw new Error('attempt ID already exists');
    const attempts = this.receipts.filter(
      (receipt) => receipt.shotId === shotId,
    );
    if (attempts.length >= this.policy.maxAttemptsPerShot)
      throw new Error('attempt limit exceeded for shot');
    if (
      this.receipts.filter(
        (receipt) => receipt.shotId && this.shotIds.includes(receipt.shotId),
      ).length >=
      this.policy.maxShots * this.policy.maxAttemptsPerShot
    )
      throw new Error('batch attempt limit exceeded');
    const receipt = {
      ...createDispatchReceipt(attemptId, shotId, packetSha256),
      batchId: this.batchId,
    };
    this.receipts.push(receipt);
    await this.save();
    return receipt;
  }

  async transition(
    attemptId: string,
    transition: ReceiptTransition,
  ): Promise<ImageReceipt> {
    await this.load();
    const index = this.receipts.findIndex(
      (receipt) => receipt.attemptId === attemptId,
    );
    if (index < 0) throw new Error('attempt receipt not found');
    const updated = transitionReceipt(this.receipts[index]!, transition);
    this.receipts[index] = updated;
    await this.save();
    return updated;
  }

  async reconcile(
    attemptId: string,
    transition: Extract<
      ReceiptTransition,
      { status: 'persisted' | 'rejected' }
    >,
  ): Promise<ImageReceipt> {
    await this.load();
    const index = this.receipts.findIndex(
      (receipt) => receipt.attemptId === attemptId,
    );
    if (index < 0) throw new Error('attempt receipt not found');
    const updated = reconcileReceipt(this.receipts[index]!, transition);
    this.receipts[index] = updated;
    await this.save();
    return updated;
  }

  async snapshot(): Promise<ImageReceipt[]> {
    await this.load();
    return this.receipts.map((receipt) => ({ ...receipt }));
  }
}

export function validateSemanticSequence(
  shots: Array<{ id: string; requiredVisualEvent: string; props: string[] }>,
  expected: readonly string[] = ['chest', 'crystal', 'shaking-room'],
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const events = shots.map((shot) =>
    `${shot.requiredVisualEvent} ${shot.props.join(' ')}`.toLowerCase(),
  );
  let cursor = -1;
  for (const item of expected) {
    const next = events.findIndex(
      (event, index) => index > cursor && event.includes(item),
    );
    if (next < 0) reasons.push(`semantic sequence is missing ${item}`);
    else cursor = next;
  }
  return { valid: reasons.length === 0, reasons };
}

/** Native generation callers must use this gate for a new series episode. */
export async function createValidatedShotPromptPacket(
  root: string,
  episode: Episode,
  shotId: string,
): Promise<ShotPromptPacket> {
  const shot = episode.shots.find((item) => item.id === shotId);
  if (!shot || !episode.referenceBible || !episode.story)
    throw new Error(
      'generation requires a known shot and approved reference bible',
    );
  const script = await readFile(
    await resolveContained(root, episode.script.path),
  );
  if (
    !episode.script.approved ||
    sha256(script) !== episode.script.sha256 ||
    script.toString('utf8') !== episode.story.scriptRevision.text
  )
    throw new Error('generation requires the approved exact script bytes');
  const bytes = await readFile(
    await resolveContained(root, episode.referenceBible.path),
  );
  if (
    sha256(bytes) !== episode.referenceBible.sha256 ||
    episode.referenceBible.status !== 'frozen'
  )
    throw new Error('generation requires current frozen reference bible bytes');
  const bible = JSON.parse(bytes.toString('utf8')) as ReferenceBible;
  const validatedReferences = await loadValidatedReferenceBible(root, bible, {
    storyRevisionId: episode.story.scriptRevision.id,
    storyRevisionSha256: episode.story.scriptRevision.textSha256,
    canonSha256: canonHash(episode.story.canon),
    canon: episode.story.canon,
  });
  const evolution = episode.series?.evolution
    ? await loadEpisodeEvolution(root, episode)
    : undefined;
  if (episode.imagePolicy && episode.series && !evolution)
    throw new Error('new series generation requires evolving visual canon');
  return createShotPromptPacket(
    episode,
    shot,
    episode.story.scriptRevision.text,
    validatedReferences,
    evolution,
  );
}
