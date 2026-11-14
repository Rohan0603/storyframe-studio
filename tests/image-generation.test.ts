import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createShotPromptPacket,
  inspectPixels,
  ingestImageOutput,
  preflightImageGeneration,
  createBatchPlan,
  createDispatchReceipt,
  transitionReceipt,
  reconcileReceipt,
  ReceiptJournal,
  recordImagePreflight,
  validateSemanticSequence,
  type PixelInspection,
} from '../src/image-generation.js';
import { freezeReferenceBible } from '../src/reference-bible.js';
import type { Episode, Shot } from '../src/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const hash = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');

function episode(): Episode {
  const bible = referenceBible();
  const scriptHash = hash('A traveler opens the chest.');
  return {
    schemaVersion: 1,
    episodeId: 'episode-01',
    mode: 'guided',
    script: {
      path: 'script.md',
      sha256: hash('A traveler opens the chest.'),
      approved: true,
    },
    referenceBundle: { path: 'references/bundle.json', sha256: 'a'.repeat(64) },
    referenceBible: {
      path: 'references/bible.json',
      sha256: 'b'.repeat(64),
      freezeSha256: freezeReferenceBible(bible),
      storyRevisionId: 'script-revision-01',
      storyRevisionSha256: scriptHash,
      canonSha256: 'e'.repeat(64),
      status: 'frozen',
    },
    narration: {
      provider: 'offline-fixture',
      textSha256: hash('A traveler opens the chest.'),
      audioPath: 'audio/narration.wav',
      alignmentPath: 'audio/alignment.json',
      alignmentVerified: false,
    },
    story: {
      scriptRevision: {
        id: 'script-revision-01',
        text: 'A traveler opens the chest.',
        textSha256: scriptHash,
        segments: [],
      },
      sourceClaims: [],
      canon: { characters: [], props: [], observations: [] },
      beatCandidates: [],
    },
    beats: [
      {
        id: 'beat-01',
        spokenText: 'A traveler opens the chest.',
        scriptStartChar: 0,
        scriptEndChar: 27,
        sourceClaimIds: [],
        scriptRevisionId: 'script-revision-01',
        scriptRevisionSha256: scriptHash,
      },
    ],
    shots: [],
    release: {
      productionQAPassed: false,
      creativeApproval: null,
      publishAuthorization: null,
    },
  };
}

function referenceBible() {
  return {
    bundleId: 'bible-01',
    storyRevisionId: 'script-revision-01',
    storyRevisionSha256: hash('A traveler opens the chest.'),
    canonSha256: 'e'.repeat(64),
    entries: [
      {
        id: 'traveler',
        kind: 'character' as const,
        name: 'Traveler',
        visualCanon: 'consistent',
        image: {
          path: 'traveler.png',
          sha256: '1'.repeat(64),
          mimeType: 'image/png' as const,
          approved: true,
        },
      },
      {
        id: 'chest',
        kind: 'prop' as const,
        name: 'Chest',
        visualCanon: 'wooden',
        image: {
          path: 'chest.png',
          sha256: '2'.repeat(64),
          mimeType: 'image/png' as const,
          approved: true,
        },
      },
    ],
  };
}

function shot(): Shot {
  const bible = referenceBible();
  return {
    id: 'shot-01',
    beatIds: ['beat-01'],
    audioStartMs: 0,
    audioEndMs: 1000,
    requiredVisualEvent: 'Traveler opens the wooden chest.',
    characters: ['traveler'],
    props: ['chest'],
    environment: 'stone-room',
    composition: 'medium close-up',
    forbidden: ['on-image text'],
    image: { path: 'images/shot-01.png', sha256: null, status: 'pending' },
    semanticReview: { status: 'pending', reviewedImageSha256: null, notes: '' },
    referenceBinding: {
      freezeSha256: freezeReferenceBible(bible),
      storyRevisionId: 'script-revision-01',
      referenceIds: ['traveler', 'chest'],
      referenceHashes: { traveler: '1'.repeat(64), chest: '2'.repeat(64) },
    },
  };
}

describe('image generation contracts', () => {
  it('builds a deterministic packet from the exact narration span and frozen refs', () => {
    const packet = createShotPromptPacket(
      episode(),
      shot(),
      'A traveler opens the chest.',
      {
        bible: referenceBible(),
        freezeSha256: freezeReferenceBible(referenceBible()),
        valid: true,
      },
    );
    expect(packet.narrationText).toBe('A traveler opens the chest.');
    expect(packet.referenceBinding.referenceHashes).toEqual({
      traveler: '1'.repeat(64),
      chest: '2'.repeat(64),
    });
    expect(packet.crop).toBe('medium close-up');
    expect(packet.packetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      createShotPromptPacket(episode(), shot(), 'unrelated'),
    ).toThrow(/exact narration/i);
  });

  it('fails closed when capability or charge state is unknown', () => {
    const result = preflightImageGeneration({
      nativeToolAvailable: true,
      referenceImagesSupported: true,
      outputBytesPersistable: true,
      quota: 'unknown',
      chargeState: 'unknown',
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/quota|charge/i);
  });

  it('persists only decoded PNG output inside the episode root and records its hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-image-'));
    const result = await ingestImageOutput(root, 'images/shot-01.png', png, {
      attemptId: 'attempt-01',
      packetSha256: 'f'.repeat(64),
      tool: 'codex-desktop.image_gen',
    });
    expect(result.status).toBe('persisted');
    expect(result.sha256).toBe(hash(png));
    expect((await readFile(join(root, 'images/shot-01.png'))).equals(png)).toBe(
      true,
    );
    await expect(
      ingestImageOutput(root, '../escape.png', png, {
        attemptId: 'attempt-02',
        packetSha256: 'f'.repeat(64),
        tool: 'codex-desktop.image_gen',
      }),
    ).rejects.toThrow(/safe|escape/i);
    await expect(
      ingestImageOutput(
        root,
        'images/bad.png',
        Buffer.from('beautiful unrelated image'),
        {
          attemptId: 'attempt-03',
          packetSha256: 'f'.repeat(64),
          tool: 'codex-desktop.image_gen',
        },
      ),
    ).rejects.toThrow(/signature|decode/i);
    await expect(
      ingestImageOutput(root, 'images/traversal.png', png, {
        attemptId: '../escape',
        packetSha256: 'f'.repeat(64),
        tool: 'codex-desktop.image_gen',
      }),
    ).rejects.toThrow(/attempt ID|safe path/i);
  });

  it('rejects an output symlink during the final path recheck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-image-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'storyframe-image-outside-'));
    await writeFile(join(outside, 'kept.png'), png);
    await symlink(join(outside, 'kept.png'), join(root, 'output.png'));
    await expect(
      ingestImageOutput(root, 'output.png', png, {
        attemptId: 'attempt-link',
        packetSha256: 'f'.repeat(64),
        tool: 'codex-desktop.image_gen',
      }),
    ).rejects.toThrow(/regular file|symlink|escape/i);
  });

  it('does not overwrite existing output and preserves rejected evidence uniquely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-image-existing-'));
    await mkdir(join(root, 'images'));
    await writeFile(
      join(root, 'images/shot.png'),
      Buffer.from('approved-bytes'),
    );
    await expect(
      ingestImageOutput(root, 'images/shot.png', png, {
        attemptId: 'same-attempt',
        packetSha256: 'f'.repeat(64),
        tool: 'codex-desktop.image_gen',
      }),
    ).rejects.toThrow(/overwrite|exists/i);
    expect((await readFile(join(root, 'images/shot.png'))).toString()).toBe(
      'approved-bytes',
    );
    expect((await readdir(join(root, 'attempts'))).length).toBe(1);
    await expect(
      ingestImageOutput(root, 'images/bad.png', Buffer.from('bad'), {
        attemptId: 'same-attempt',
        packetSha256: 'f'.repeat(64),
        tool: 'codex-desktop.image_gen',
      }),
    ).rejects.toThrow(/preservation|signature/i);
    expect((await readdir(join(root, 'attempts'))).length).toBe(2);
  });

  it('rejects symlinked output parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-image-parent-'));
    const outside = await mkdtemp(
      join(tmpdir(), 'storyframe-image-parent-outside-'),
    );
    await symlink(outside, join(root, 'images'));
    await expect(
      ingestImageOutput(root, 'images/shot.png', png, {
        attemptId: 'parent-link',
        packetSha256: 'f'.repeat(64),
        tool: 'codex-desktop.image_gen',
      }),
    ).rejects.toThrow(/parent|symlink|regular directory|escapes/i);
  });

  it('rejects PNG CRC corruption and trailing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-image-png-'));
    const crcCorrupt = Buffer.from(png);
    crcCorrupt[crcCorrupt.length - 5] =
      (crcCorrupt[crcCorrupt.length - 5] ?? 0) ^ 1;
    await expect(
      ingestImageOutput(root, 'crc.png', crcCorrupt, {
        attemptId: 'crc',
        packetSha256: 'f'.repeat(64),
        tool: 'codex-desktop.image_gen',
      }),
    ).rejects.toThrow(/CRC/i);
    await expect(
      ingestImageOutput(
        root,
        'trailing.png',
        Buffer.concat([png, Buffer.from('trailing')]),
        {
          attemptId: 'trailing',
          packetSha256: 'f'.repeat(64),
          tool: 'codex-desktop.image_gen',
        },
      ),
    ).rejects.toThrow(/complete|trailing/i);
  });

  it('rejects attractive but unrelated pixels and passes only independently inspected story pixels', () => {
    const base: PixelInspection = {
      imageSha256: hash(png),
      pixelsDecoded: true,
      requiredActionPresent: true,
      requiredCharactersPresent: true,
      requiredPropsPresent: true,
      continuityMatches: true,
      forbiddenTextPresent: false,
      staleReferences: false,
      notes: 'actual pixels inspected',
    };
    expect(inspectPixels(base).status).toBe('approved');
    expect(
      inspectPixels({ ...base, requiredActionPresent: false }).status,
    ).toBe('rejected');
    expect(
      inspectPixels({
        ...base,
        requiredPropsPresent: false,
        notes: 'crystal absent',
      }).status,
    ).toBe('rejected');
    expect(inspectPixels({ ...base, pixelsDecoded: false }).status).toBe(
      'unknown',
    );
    expect(inspectPixels({ ...base, forbiddenTextPresent: true }).status).toBe(
      'rejected',
    );
  });

  it('bounds batches and attempts before any provider call', () => {
    const result = createBatchPlan(['shot-01', 'shot-02', 'shot-03'], {
      maxShots: 2,
      maxAttemptsPerShot: 1,
      authorizedChargeState: 'authorized',
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/batch/i);
    expect(
      createBatchPlan(['shot-01'], {
        maxShots: 2,
        maxAttemptsPerShot: 0,
        authorizedChargeState: 'authorized',
      }).status,
    ).toBe('blocked');
  });

  it('records receipt transitions and reconciles ambiguous outcomes without retrying them', () => {
    const receipt = createDispatchReceipt(
      'attempt-01',
      'shot-01',
      'a'.repeat(64),
    );
    expect(receipt.status).toBe('dispatched');
    const unknown = transitionReceipt(receipt, {
      status: 'unknown',
      failure: 'provider return was ambiguous',
    });
    expect(unknown.status).toBe('unknown');
    expect(() => transitionReceipt(unknown, { status: 'dispatched' })).toThrow(
      /retry|reconcile/i,
    );
    const reconciled = reconcileReceipt(unknown, {
      status: 'persisted',
      outputPath: 'images/shot-01.png',
      sha256: 'b'.repeat(64),
      width: 1,
      height: 1,
    });
    expect(reconciled.status).toBe('reconciled');
    expect(reconciled.outputPath).toBe('images/shot-01.png');
  });

  it('binds attempts to a durable batch journal across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-journal-'));
    const policy = {
      maxShots: 1,
      maxAttemptsPerShot: 1,
      authorizedChargeState: 'authorized' as const,
    };
    const first = new ReceiptJournal(root, 'batch-01', ['shot-01'], policy);
    await first.dispatch('attempt-01', 'shot-01', 'a'.repeat(64));
    await expect(
      first.dispatch('attempt-02', 'shot-01', 'a'.repeat(64)),
    ).rejects.toThrow(/attempt limit/i);
    const restarted = new ReceiptJournal(root, 'batch-01', ['shot-01'], policy);
    await expect(
      restarted.dispatch('attempt-02', 'shot-01', 'a'.repeat(64)),
    ).rejects.toThrow(/attempt limit/i);
    const blocked = new ReceiptJournal(root, 'batch-02', ['shot-01'], {
      maxShots: 1,
      maxAttemptsPerShot: 1,
      authorizedChargeState: 'unknown',
    });
    await expect(
      blocked.dispatch('attempt-01', 'shot-01', 'a'.repeat(64)),
    ).rejects.toThrow(/charge authorization/i);
  });

  it('records blocked preflight state without provider invocation and preserves unknown billing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-preflight-'));
    const receipt = await recordImagePreflight(root, {
      nativeToolAvailable: false,
      referenceImagesSupported: false,
      outputBytesPersistable: false,
      quota: 'unknown',
      chargeState: 'unknown',
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.providerInvoked).toBe(false);
    expect(receipt.quota).toBe('unknown');
    expect(
      JSON.parse(
        await readFile(join(root, 'receipts/image-preflight.json'), 'utf8'),
      ).chargeState,
    ).toBe('unknown');
  });

  it('accepts the offline fixture semantic sequence only in order', () => {
    const shots = [
      {
        id: 'one',
        requiredVisualEvent: 'traveler opens chest',
        props: ['chest'],
      },
      {
        id: 'two',
        requiredVisualEvent: 'traveler sees glowing crystal',
        props: ['crystal'],
      },
      {
        id: 'three',
        requiredVisualEvent: 'room shaking around traveler',
        props: ['shaking-room'],
      },
    ];
    expect(validateSemanticSequence(shots).valid).toBe(true);
    expect(validateSemanticSequence([...shots].reverse()).valid).toBe(false);
  });
});
