#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendCheckpoint,
  readCheckpoints,
  resumeCheckpoints,
} from './checkpoints.js';
import { validateEpisode, sha256 } from './manifest.js';
import { createEpisode } from './scaffold.js';
import { resolveContained } from './paths.js';
import type { Episode } from './types.js';
import { densityNote, storyboardMarkdown } from './alignment.js';
import { recordImagePreflight } from './image-generation.js';
import { renderStillEpisode } from './render.js';
import { validateAndWriteTimelineReview } from './sync.js';
import {
  approveProducerStage,
  assessProducer,
  boundedPolicy,
  generateProducerCaptions,
  generateProducerRender,
  runAutoProducer,
  recordProducerRender,
  recordProducerReview,
  saveProducerEpisode,
  startProducer,
  writeProducerPackage,
  type ProducerReview,
  type ProducerStage,
} from './producer.js';

async function load(root: string): Promise<Episode> {
  return JSON.parse(
    await readFile(join(root, 'episode.json'), 'utf8'),
  ) as Episode;
}

async function inputHashes(
  root: string,
  episode: Episode,
): Promise<Record<string, string>> {
  const script = await readFile(
    await resolveContained(root, episode.script.path),
  );
  const refs = await readFile(
    await resolveContained(root, episode.referenceBundle.path),
  );
  const referenceBible = episode.referenceBible
    ? await readFile(await resolveContained(root, episode.referenceBible.path))
    : '';
  const dependencies = JSON.stringify({
    narration: episode.narration,
    series: episode.series,
    alignment: episode.alignment,
    story: episode.story,
    beats: episode.beats,
    shots: episode.shots,
  });
  return {
    script: sha256(script),
    referenceBundle: sha256(refs),
    referenceBible: sha256(referenceBible),
    episodeDependencies: sha256(dependencies),
  };
}

export async function runCli(args: string[]): Promise<number> {
  const [command, root = '.', episodeId = 'episode-01'] = args;
  if (!command)
    throw new Error(
      'usage: storyframe <new|select-provider|plan|align|references|validate|resume|image-preflight|sync-review|render> <episode-root> [episode-id] [provider]',
    );
  if (command === 'new') {
    await createEpisode(root, episodeId);
    return 0;
  }
  if (command === 'image-preflight') {
    const result = await recordImagePreflight(root, {
      nativeToolAvailable: false,
      referenceImagesSupported: false,
      outputBytesPersistable: false,
      quota: 'unknown',
      chargeState: 'unknown',
    });
    throw new Error(
      `image-preflight ${result.status.toUpperCase()}: ${result.reason}`,
    );
  }
  if (command === 'producer') {
    const action = args[2];
    const episode = await load(root);
    if (action === 'init') {
      const mode = args[3];
      if (mode !== 'guided' && mode !== 'auto')
        throw new Error('producer init requires guided or auto');
      const maxShots = Number(args[4]);
      const maxDurationSeconds = Number(args[5]);
      if (!Number.isInteger(maxDurationSeconds))
        throw new Error('producer init requires an integer duration limit');
      episode.mode = mode;
      startProducer(
        episode,
        boundedPolicy(maxShots, maxDurationSeconds * 1000),
      );
      const validation = await validateEpisode(episode, root);
      if (!validation.valid)
        throw new Error(
          'producer init requires a valid episode: ' +
            validation.errors.join('; '),
        );
      await saveProducerEpisode(root, episode);
      return 0;
    }
    if (action === 'status' || action === 'next') {
      const report = await assessProducer(root, episode);
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (action === 'approve') {
      await approveProducerStage(
        root,
        episode,
        args[3] as ProducerStage,
        args[4] ?? '',
        args.slice(5).join(' '),
      );
      await saveProducerEpisode(root, episode);
      return 0;
    }
    if (action === 'create-captions') {
      await generateProducerCaptions(
        root,
        episode,
        args[3] ?? 'audio/producer.srt',
      );
      await saveProducerEpisode(root, episode);
      return 0;
    }
    if (action === 'render') {
      await generateProducerRender(
        root,
        episode,
        args[3] ?? 'output/producer-video.mp4',
      );
      await saveProducerEpisode(root, episode);
      return 0;
    }
    if (action === 'run') {
      const report = await runAutoProducer(root, episode);
      await saveProducerEpisode(root, episode);
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (action === 'verify-render') {
      if (!args[3]) throw new Error('render path is required');
      await recordProducerRender(root, episode, args[3]);
      await saveProducerEpisode(root, episode);
      return 0;
    }
    if (action === 'record-review') {
      if (!args[3]) throw new Error('QA evidence path is required');
      const review = JSON.parse(
        await readFile(await resolveContained(root, args[3]), 'utf8'),
      ) as ProducerReview;
      await recordProducerReview(episode, review);
      await saveProducerEpisode(root, episode);
      return 0;
    }
    if (action === 'package') {
      console.log(await writeProducerPackage(root, episode));
      return 0;
    }
    throw new Error(
      'producer usage: <root> <init|status|next|approve|create-captions|render|run|verify-render|record-review|package>',
    );
  }
  if (command === 'select-provider') {
    const provider = args[3];
    if (provider !== 'gemini-tts' && provider !== 'kokoro-onnx')
      throw new Error('provider must be gemini-tts or kokoro-onnx');
    const episode = await load(root);
    const validation = await validateEpisode(episode, root);
    if (!validation.valid)
      throw new Error(
        `episode validation failed:\n${validation.errors.join('\n')}`,
      );
    episode.narration.provider = provider;
    episode.narration.alignmentVerified = false;
    delete episode.narration.audioSha256;
    delete episode.narration.audioDurationMs;
    delete episode.narration.receiptPath;
    delete episode.narration.captionsPath;
    episode.release.productionQAPassed = false;
    if (episode.alignment) {
      episode.alignment.timingStatus = 'provisional';
      episode.alignment.audioDurationMs = null;
    }
    await writeFile(
      join(root, 'episode.json'),
      JSON.stringify(episode, null, 2) + '\n',
      'utf8',
    );
    return 0;
  }
  const episode = await load(root);
  if (command === 'sync-review') {
    const result = await validateAndWriteTimelineReview(root, episode);
    console.log(JSON.stringify(result, null, 2));
    if (!result.validation.valid && result.status !== 'legacy-unverified')
      throw new Error(`sync timeline validation failed:\n${result.validation.errors.join('\n')}`);
    return 0;
  }
  const validation = await validateEpisode(episode, root);
  if (!validation.valid)
    throw new Error(
      `episode validation failed:\n${validation.errors.join('\n')}`,
    );
  const hashes = await inputHashes(root, episode);
  if (command === 'validate') return 0;
  if (command === 'plan' || command === 'align') {
    await writeFile(
      join(root, 'storyboard.md'),
      `${storyboardMarkdown(episode)}\n${densityNote(episode)}\n`,
    );
    const existing = await readCheckpoints(root);
    const stage = command === 'align' ? 'alignment' : 'plan';
    const attempt =
      Math.max(
        0,
        ...existing
          .filter((checkpoint) => checkpoint.stage === stage)
          .map((checkpoint) => checkpoint.attempt),
      ) + 1;
    await appendCheckpoint(root, {
      stage,
      attempt,
      status: 'approved',
      inputHashes: hashes,
      outputHashes: {},
      recordedAt: new Date().toISOString(),
    });
    return 0;
  }
  if (command === 'references') {
    if (!episode.referenceBible)
      throw new Error('reference bible is required for references validation');
    if (episode.referenceBible.status !== 'frozen')
      throw new Error('reference bible must be frozen before approval');
    const existing = await readCheckpoints(root);
    const attempt =
      Math.max(
        0,
        ...existing
          .filter((checkpoint) => checkpoint.stage === 'references')
          .map((checkpoint) => checkpoint.attempt),
      ) + 1;
    await appendCheckpoint(root, {
      stage: 'references',
      attempt,
      status: 'approved',
      inputHashes: hashes,
      outputHashes: { freezeSha256: episode.referenceBible.freezeSha256 },
      recordedAt: new Date().toISOString(),
    });
    return 0;
  }
  if (command === 'render') {
    if (!episode.narration.alignmentVerified)
      throw new Error('render requires verified narration alignment');
    await renderStillEpisode(root, episode);
    return 0;
  }
  if (command === 'resume') {
    await resumeCheckpoints(root, hashes);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
