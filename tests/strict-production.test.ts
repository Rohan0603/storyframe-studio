import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createValidatedShotPromptPacket } from '../src/image-generation.js';
import { normalizeGeneratedStill } from '../src/image-normalization.js';
import { validateEpisode } from '../src/manifest.js';
import { canonHash, freezeReferenceBible } from '../src/reference-bible.js';
import { createScriptRevision } from '../src/story-layer.js';
import {
  loadEpisodeEvolution,
  type SeriesEvolution,
} from '../src/series-evolution.js';
import { validateImageEvidence } from '../src/production-evidence.js';
import {
  verifyEpisodeYouTubeState,
  validatePublicationReceipt,
} from '../src/youtube-state.js';
import type { Episode, ReferenceBible, Shot } from '../src/types.js';

const sha = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const policy = {
  width: 1920 as const,
  height: 1080 as const,
  requireNativeReceipt: true,
  requireVisualScreening: true,
};

async function fixture(): Promise<{
  root: string;
  episode: Episode;
  evolution: SeriesEvolution;
}> {
  const root = await mkdtemp(join(tmpdir(), 'strict-series-'));
  for (const dir of ['references', 'series-bible', 'receipts', 'images'])
    await mkdir(join(root, dir));
  const script = 'Hero arrives. Hero changes clothes.';
  const revision = createScriptRevision({
    id: 'rev-one',
    text: script,
    segments: [],
  });
  const canon = {
    characters: [{ id: 'hero', name: 'Hero', state: 'ragged' }],
    props: [],
    observations: [],
  };
  await writeFile(join(root, 'script.md'), script);
  await writeFile(join(root, 'references/bundle.json'), '{}');
  await writeFile(join(root, 'series-bible/series.json'), '{}');
  await writeFile(join(root, 'references/ragged.png'), png);
  await writeFile(join(root, 'references/room.png'), png);
  const normalized = await normalizeGeneratedStill(
    root,
    'references/ragged.png',
    'references/wealthy.png',
  );
  const bible: ReferenceBible = {
    bundleId: 'bible-one',
    storyRevisionId: revision.id,
    storyRevisionSha256: revision.textSha256,
    canonSha256: canonHash(canon),
    entries: [
      {
        id: 'hero-ragged',
        kind: 'character',
        name: 'Hero',
        canonEntityId: 'hero',
        visualCanon: 'Ragged clothes',
        image: {
          path: 'references/ragged.png',
          sha256: sha(png),
          mimeType: 'image/png',
          approved: true,
        },
      },
      {
        id: 'hero-wealthy',
        kind: 'character',
        name: 'Hero',
        canonEntityId: 'hero',
        visualCanon: 'New tailored clothes',
        image: {
          path: 'references/wealthy.png',
          sha256: normalized.output.sha256,
          mimeType: 'image/png',
          approved: true,
        },
      },
      {
        id: 'room-ref',
        kind: 'environment',
        name: 'Room',
        canonEntityId: 'room',
        visualCanon: 'A room',
        image: {
          path: 'references/room.png',
          sha256: sha(png),
          mimeType: 'image/png',
          approved: true,
        },
      },
    ],
  };
  const bibleText = JSON.stringify(bible);
  await writeFile(join(root, 'references/bible.json'), bibleText);
  const beats = ['Hero arrives.', 'Hero changes clothes.'].map((text, i) => ({
    id: 'beat-' + (i + 1),
    spokenText: text,
    scriptStartChar: script.indexOf(text),
    scriptEndChar: script.indexOf(text) + text.length,
    sourceClaimIds: [],
    scriptRevisionId: revision.id,
    scriptRevisionSha256: revision.textSha256,
  }));
  const evolution: SeriesEvolution = {
    version: 1,
    seriesId: 'series-test',
    throughEpisode: 1,
    episodeId: 'episode-01',
    entities: [
      {
        entityId: 'hero',
        kind: 'character',
        states: [
          {
            id: 'ragged',
            fromEpisode: 1,
            fromShot: 0,
            fromBeatId: 'beat-1',
            scriptRevisionSha256: revision.textSha256,
            referenceId: 'hero-ragged',
            referenceSha256: sha(png),
            visualCanon: 'Ragged clothes',
            changeReason: 'Opening',
          },
          {
            id: 'wealthy',
            fromEpisode: 1,
            fromShot: 1,
            fromBeatId: 'beat-2',
            scriptRevisionSha256: revision.textSha256,
            referenceId: 'hero-wealthy',
            referenceSha256: normalized.output.sha256,
            visualCanon: 'New tailored clothes',
            changeReason: 'Changes clothes',
          },
        ],
      },
      {
        entityId: 'room',
        kind: 'environment',
        states: [
          {
            id: 'room-one',
            fromEpisode: 1,
            fromShot: 0,
            fromBeatId: 'beat-1',
            scriptRevisionSha256: revision.textSha256,
            referenceId: 'room-ref',
            referenceSha256: sha(png),
            visualCanon: 'A room',
            changeReason: 'Opening',
          },
        ],
      },
    ],
  };
  const stateBytes = JSON.stringify(evolution);
  await writeFile(join(root, 'series-bible/evolution.json'), stateBytes);
  const shots: Shot[] = beats.map((beat, i) => {
    const state = evolution.entities[0]!.states[i]!;
    return {
      id: 'shot-' + (i + 1),
      beatIds: [beat.id],
      audioStartMs: i * 1000,
      audioEndMs: (i + 1) * 1000,
      requiredVisualEvent: beat.spokenText,
      imagePrompt: state.visualCanon,
      characters: ['hero'],
      props: [],
      environment: 'room',
      composition: 'wide',
      forbidden: [],
      image: {
        path: 'images/shot-' + (i + 1) + '.png',
        sha256: null,
        status: 'pending',
      },
      semanticReview: {
        status: 'pending',
        reviewedImageSha256: null,
        notes: '',
      },
      referenceBinding: {
        freezeSha256: freezeReferenceBible(bible),
        storyRevisionId: revision.id,
        referenceIds: [state.referenceId, 'room-ref'],
        referenceHashes: {
          [state.referenceId]: state.referenceSha256,
          'room-ref': sha(png),
        },
      },
      seriesBinding: {
        seriesId: 'series-test',
        revisionId: 'series-rev-one',
        entityStates: { hero: state.id, room: 'room-one' },
      },
    };
  });
  const episode: Episode = {
    schemaVersion: 1,
    episodeId: 'episode-01',
    mode: 'guided',
    script: { path: 'script.md', sha256: sha(script), approved: true },
    referenceBundle: { path: 'references/bundle.json', sha256: sha('{}') },
    imagePolicy: policy,
    series: {
      seriesId: 'series-test',
      revisionId: 'series-rev-one',
      biblePath: 'series-bible/series.json',
      bibleSha256: sha('{}'),
      visualFormat: '2d-still',
      applied: true,
      evolution: {
        path: 'series-bible/evolution.json',
        sha256: sha(stateBytes),
        episodeOrder: 1,
      },
    },
    referenceBible: {
      path: 'references/bible.json',
      sha256: sha(bibleText),
      freezeSha256: freezeReferenceBible(bible),
      storyRevisionId: revision.id,
      storyRevisionSha256: revision.textSha256,
      canonSha256: bible.canonSha256,
      status: 'frozen',
    },
    narration: {
      provider: 'offline-fixture',
      textSha256: sha(script),
      audioPath: 'audio.wav',
      alignmentPath: 'alignment.json',
      alignmentVerified: false,
    },
    story: {
      scriptRevision: revision,
      sourceClaims: [],
      canon,
      beatCandidates: [],
    },
    alignment: {
      scriptRevisionId: revision.id,
      scriptSha256: sha(script),
      scriptRevisionSha256: revision.textSha256,
      timingStatus: 'provisional',
      audioDurationMs: null,
      density: { style: 'cinematic', targetMin: 1, targetMax: 8 },
    },
    beats,
    shots,
    release: {
      productionQAPassed: false,
      creativeApproval: null,
      publishAuthorization: null,
    },
  };
  return { root, episode, evolution };
}

describe('strict production integration', () => {
  it('resolves actual frozen reference bytes and rejects an old state before dispatch', async () => {
    const { root, episode } = await fixture();
    const first = await createValidatedShotPromptPacket(
      root,
      episode,
      'shot-1',
    );
    const second = await createValidatedShotPromptPacket(
      root,
      episode,
      'shot-2',
    );
    expect(first.activeSeriesStates?.hero).toBe('ragged');
    expect(second.activeSeriesStates?.hero).toBe('wealthy');
    expect(first.packetSha256).not.toBe(second.packetSha256);
    const later = episode.shots[1]!;
    later.seriesBinding!.entityStates!.hero = 'ragged';
    later.referenceBinding = structuredClone(
      episode.shots[0]!.referenceBinding!,
    );
    await expect(
      createValidatedShotPromptPacket(root, episode, 'shot-2'),
    ).rejects.toThrow(/stale|premature|obsolete/);
    expect((await validateEpisode(episode, root)).errors.join(' ')).toMatch(
      /stale|premature|obsolete/,
    );
  });

  it('rejects truncated predecessor history even when the new file is freshly hashed', async () => {
    const { root, episode, evolution } = await fixture();
    const previous = JSON.stringify(evolution);
    episode.release.productionQAPassed = true;
    const archived = JSON.stringify(episode);
    await writeFile(join(root, 'series-bible/previous.json'), previous);
    await writeFile(
      join(root, 'series-bible/previous-manifest.json'),
      archived,
    );
    episode.episodeId = 'episode-02';
    evolution.episodeId = episode.episodeId;
    evolution.throughEpisode = 2;
    const current = JSON.stringify(evolution);
    await writeFile(join(root, 'series-bible/evolution.json'), current);
    episode.series!.evolution = {
      path: 'series-bible/evolution.json',
      sha256: sha(current),
      episodeOrder: 2,
      predecessor: {
        path: 'series-bible/previous.json',
        sha256: sha(previous),
        manifestPath: 'series-bible/previous-manifest.json',
        manifestSha256: sha(archived),
      },
    };
    expect((await loadEpisodeEvolution(root, episode)).episodeOrder).toBe(2);
    evolution.entities[0]!.states.pop();
    const shortened = JSON.stringify(evolution);
    await writeFile(join(root, 'series-bible/evolution.json'), shortened);
    episode.series!.evolution!.sha256 = sha(shortened);
    await expect(loadEpisodeEvolution(root, episode)).rejects.toThrow(
      /history was removed|rewritten/,
    );
  });

  it('cannot approve stale bytes merely by setting passing review metadata or an invented receipt ID', async () => {
    const { root, episode } = await fixture();
    const firstPacket = await createValidatedShotPromptPacket(
      root,
      episode,
      'shot-1',
    );
    const shot = episode.shots[1]!;
    const hd = await normalizeGeneratedStill(
      root,
      'references/ragged.png',
      shot.image.path,
    );
    shot.image.sha256 = hd.output.sha256;
    shot.image.status = 'approved';
    shot.image.provenance = {
      tool: 'codex-desktop.image_gen',
      packetSha256: firstPacket.packetSha256,
      attemptId: 'attempt-one',
      nativeReceiptId: 'invented-id',
      receiptStatus: 'persisted',
      width: 1920,
      height: 1080,
    };
    shot.semanticReview = {
      status: 'pass',
      reviewedImageSha256: hd.output.sha256,
      reviewedPacketSha256: firstPacket.packetSha256,
      pixelsDecoded: true,
      notes: 'Fixture review',
      screening: {
        imageSha256: hd.output.sha256,
        collage: 'clear',
        text: 'clear',
        checkedBy: 'fixture',
        notes: 'Fixture notes',
      },
    };
    const errors = (await validateEpisode(episode, root)).errors.join(' ');
    expect(errors).toMatch(/stale for current prompt/);
    expect(errors).toMatch(/native receipt evidence/);
    expect(errors).toMatch(/persisted scan receipt/);
    expect((await validateImageEvidence(root, episode, shot)).length).toBe(2);
  });

  it('binds read-only publication verification to the intended episode and video hash', async () => {
    const { root, episode } = await fixture();
    const video = 'fixture-render-bytes';
    await writeFile(join(root, 'video.mp4'), video);
    episode.release.publishAuthorization = 'Fixture owner authorization';
    episode.release.youtubeTarget = {
      videoId: 'hlQVQ_jdwvI',
      state: 'public',
      videoPath: 'video.mp4',
      videoSha256: sha(video),
    };
    const read = async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'hlQVQ_jdwvI',
              status: { privacyStatus: 'public', uploadStatus: 'processed' },
            },
          ],
        }),
        { status: 200 },
      );
    await expect(
      verifyEpisodeYouTubeState(
        root,
        episode,
        'abcdefghijk',
        { state: 'public' },
        'fixture-token',
        read,
      ),
    ).rejects.toThrow(/publication target/);
    const result = await verifyEpisodeYouTubeState(
      root,
      episode,
      'hlQVQ_jdwvI',
      { state: 'public' },
      'fixture-token',
      read,
    );
    expect(result.episodeId).toBe('episode-01');
    expect(await validatePublicationReceipt(root, episode)).toEqual([]);
    await writeFile(join(root, 'video.mp4'), 'changed');
    expect((await validatePublicationReceipt(root, episode)).join(' ')).toMatch(
      /stale/,
    );
  });
});
