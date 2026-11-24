import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Episode, Shot } from './types.js';
import { resolveContained } from './paths.js';
import { readPersistedImage, type ImageReceipt } from './image-generation.js';
import type { ScreeningResult } from './visual-screening.js';

const sha = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

async function boundJson<T>(
  root: string,
  path: string,
  expected: string,
): Promise<T> {
  const bytes = await readFile(await resolveContained(root, path));
  if (sha(bytes) !== expected)
    throw new Error('evidence bytes do not match hash');
  return JSON.parse(bytes.toString('utf8')) as T;
}

/** Local evidence consistency, not cryptographic provider attestation. */
export async function validateImageEvidence(
  root: string,
  episode: Episode,
  shot: Shot,
): Promise<string[]> {
  const policy = episode.imagePolicy;
  if (!policy || shot.image.sha256 === null) return [];
  const errors: string[] = [];
  const p = shot.image.provenance;
  if (policy.requireNativeReceipt) {
    try {
      if (
        !p?.nativeReceiptId?.trim() ||
        p.nativeReceiptId === shot.id ||
        p.nativeReceiptId === p.attemptId ||
        !p.journalPath ||
        !p.journalEntrySha256 ||
        !p.providerEvidence ||
        !p.nativeImage
      )
        throw new Error(
          'missing native response, dispatch journal or original image evidence',
        );
      const raw = await readFile(
        await resolveContained(root, p.providerEvidence.path),
      );
      if (
        sha(raw) !== p.providerEvidence.sha256 ||
        !raw.toString('utf8').includes(p.nativeReceiptId)
      )
        throw new Error('native response does not contain the receipt ID');
      const journal = JSON.parse(
        await readFile(await resolveContained(root, p.journalPath), 'utf8'),
      ) as ImageReceipt[];
      const matching = journal.filter(
        (entry) => entry.attemptId === p.attemptId,
      );
      const receipt = matching[0];
      const native = p.nativeImage;
      if (
        matching.length !== 1 ||
        !receipt ||
        sha(JSON.stringify(receipt)) !== p.journalEntrySha256 ||
        receipt.shotId !== shot.id ||
        receipt.packetSha256 !== p.packetSha256 ||
        receipt.tool !== p.tool ||
        receipt.status !== p.receiptStatus ||
        !['persisted', 'reconciled'].includes(receipt.status) ||
        receipt.nativeReceiptId !== p.nativeReceiptId ||
        receipt.providerEvidence?.path !== p.providerEvidence.path ||
        receipt.providerEvidence?.sha256 !== p.providerEvidence.sha256 ||
        receipt.outputPath !== native.path ||
        receipt.sha256 !== native.sha256 ||
        receipt.width !== native.width ||
        receipt.height !== native.height
      )
        throw new Error(
          'journal does not bind native receipt, shot, packet and original bytes',
        );
      const actual = await readPersistedImage(root, native.path);
      if (
        actual.sha256 !== native.sha256 ||
        actual.width !== native.width ||
        actual.height !== native.height
      )
        throw new Error('native dimensions or bytes disagree with receipt');
      if (
        native.path !== shot.image.path ||
        native.sha256 !== shot.image.sha256
      ) {
        const proof = p.normalizationReceipt;
        if (!proof) throw new Error('normalization receipt required');
        const normalized = await boundJson<{
          tool: string;
          native: {
            path: string;
            sha256: string;
            width: number;
            height: number;
          };
          output: {
            path: string;
            sha256: string;
            width: number;
            height: number;
          };
        }>(root, proof.path, proof.sha256);
        if (
          normalized.tool !== 'ffmpeg' ||
          normalized.native.path !== native.path ||
          normalized.native.sha256 !== native.sha256 ||
          normalized.native.width !== native.width ||
          normalized.native.height !== native.height ||
          normalized.output.path !== shot.image.path ||
          normalized.output.sha256 !== shot.image.sha256 ||
          normalized.output.width !== 1920 ||
          normalized.output.height !== 1080
        )
          throw new Error('normalization evidence does not bind both images');
      }
    } catch (error) {
      errors.push(
        `image ${shot.id} native receipt evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (policy.requireVisualScreening) {
    try {
      const review = shot.semanticReview.screening;
      if (!review?.evidencePath || !review.evidenceSha256)
        throw new Error('persisted scan receipt required');
      const scan = await boundJson<ScreeningResult>(
        root,
        review.evidencePath,
        review.evidenceSha256,
      );
      if (
        scan.version !== 1 ||
        scan.imagePath !== shot.image.path ||
        scan.imageSha256 !== shot.image.sha256 ||
        scan.collage !== 'clear' ||
        !scan.checkedBy?.trim() ||
        !scan.notes?.trim() ||
        !Array.isArray(scan.detectedText)
      )
        throw new Error('screening stale, unavailable or suspected collage');
      if (!['clear', 'detected'].includes(scan.text))
        throw new Error('automated text evidence unknown');
      if (
        scan.text === 'detected' &&
        (!review.allowedText?.length ||
          !scan.detectedText.length ||
          scan.detectedText.some((line) => !review.allowedText!.includes(line)))
      )
        throw new Error(
          'detected text needs explicit allowed-signage disposition',
        );
    } catch (error) {
      errors.push(
        `image ${shot.id} screening evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}
