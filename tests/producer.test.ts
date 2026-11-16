import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEpisode } from '../src/scaffold.js';
import { createScriptRevision } from '../src/story-layer.js';
import { runCli } from '../src/cli.js';
import {
  approveProducerStage,
  assessProducer,
  boundedPolicy,
  recordProducerReview,
  runAutoProducer,
  stageFingerprint,
  startProducer,
  writeProducerPackage,
} from '../src/producer.js';

describe('Guided/Auto producer contracts', () => {
  it('starts a bounded Guided run without generation or publishing permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-producer-'));
    const episode = await createEpisode(root, 'episode-01');
    startProducer(episode, boundedPolicy(40, 120_000));
    const report = await assessProducer(root, episode);
    expect(report.mode).toBe('guided');
    expect(report.nextStage).toBe('research');
    expect(report.stages[0]?.status).toBe('blocked');
    expect(report.publishAuthorized).toBe(false);
    expect(report.readyToPackage).toBe(false);
    expect(episode.production?.policy.cloudTtsCallsAuthorized).toBe(false);
    expect(episode.production?.policy.imageCallsAuthorized).toBe(false);
    expect(episode.production?.policy.budgetUsd).toBe(0);
  });

  it('stops Auto mode at missing evidence rather than simulating generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-auto-'));
    const episode = await createEpisode(root, 'episode-01');
    episode.mode = 'auto';
    startProducer(episode, boundedPolicy(32, 180_000));
    const report = await assessProducer(root, episode);
    expect(report.stages[0]?.status).toBe('blocked');
    expect(report.nextStage).toBe('research');
    expect(report.readyToPackage).toBe(false);
    const afterRun = await runAutoProducer(root, episode);
    expect(afterRun.nextStage).toBe('research');
    expect(episode.narration.captionsPath).toBeUndefined();
    expect(episode.production?.render).toBeUndefined();
    await expect(writeProducerPackage(root, episode)).rejects.toThrow(
      /accepted QA/i,
    );
  });

  it('refuses unbounded or paid producer policies and silent restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-policy-'));
    const episode = await createEpisode(root, 'episode-01');
    expect(() => boundedPolicy(0, 120_000)).toThrow(/bounded/);
    expect(() => boundedPolicy(2_000, 120_000)).toThrow(/bounded/);
    expect(() => boundedPolicy(50, Number.POSITIVE_INFINITY)).toThrow(
      /bounded/,
    );
    const policy = boundedPolicy(30, 120_000);
    expect(() =>
      startProducer(episode, { ...policy, imageCallsAuthorized: true }),
    ).toThrow(/authorize/);
    expect(() => startProducer(episode, { ...policy, budgetUsd: 10 })).toThrow(
      /authorize/,
    );
    startProducer(episode, policy);
    expect(() => startProducer(episode, policy)).toThrow(/already exists/);
  });

  it('binds approvals to upstream story, image and audio dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-fingerprints-'));
    const episode = await createEpisode(root, 'episode-01');
    startProducer(episode, boundedPolicy(30, 180_000));
    const imageBefore = stageFingerprint(episode, 'images');
    const narrationBefore = stageFingerprint(episode, 'narration');
    const researchBefore = stageFingerprint(episode, 'research');
    episode.narration.provider = 'kokoro-onnx';
    expect(stageFingerprint(episode, 'images')).toBe(imageBefore);
    expect(stageFingerprint(episode, 'narration')).not.toBe(narrationBefore);
    episode.script.sha256 = 'b'.repeat(64);
    expect(stageFingerprint(episode, 'research')).not.toBe(researchBefore);
  });

  it('requires actual review evidence before approvals or QA are accepted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-review-'));
    const episode = await createEpisode(root, 'episode-01');
    startProducer(episode, boundedPolicy(30, 120_000));
    await expect(
      approveProducerStage(
        root,
        episode,
        'research',
        'owner',
        'Reviewed source ledger',
      ),
    ).rejects.toThrow(/current evidence/i);
    await expect(
      approveProducerStage(root, episode, 'research', '', ''),
    ).rejects.toThrow(/reviewer/i);
    await expect(
      recordProducerReview(episode, {
        reviewer: 'owner',
        notes: 'watched and listened',
        renderSha256: 'a'.repeat(64),
        checks: {} as never,
      }),
    ).rejects.toThrow(/render hash/i);
  });

  it('blocks script approval for a legacy story without a narrative plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-narrative-gate-'));
    const episode = await createEpisode(root, 'episode-01');
    episode.mode = 'auto';
    episode.script.approved = true;
    episode.story = {
      scriptRevision: createScriptRevision({
        id: 'script-revision-01',
        text: 'A surprising historical story.',
        segments: [],
      }),
      sourceClaims: [],
      canon: { characters: [], props: [], observations: [] },
      beatCandidates: [],
    };
    episode.alignment!.scriptRevisionSha256 =
      episode.story.scriptRevision.textSha256;
    startProducer(episode, boundedPolicy(30, 120_000));
    const report = await assessProducer(root, episode);
    expect(
      report.stages.find((stage) => stage.stage === 'script'),
    ).toMatchObject({
      status: 'blocked',
      reasons: expect.arrayContaining(['narrative plan: hook is required']),
    });
  });

  it('keeps the Auto script stage human-reviewed even with a complete plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-narrative-review-'));
    const episode = await createEpisode(root, 'episode-01');
    episode.mode = 'auto';
    episode.script.approved = true;
    episode.story = {
      scriptRevision: createScriptRevision({
        id: 'script-revision-01',
        text: 'A surprising historical story.',
        segments: [],
      }),
      narrativePlan: {
        hook: 'A small dispute triggers a national crisis.',
        contradiction: 'The stakes are international despite the tiny cause.',
        protagonistGoal: 'The farmer wants to protect his land.',
        stakes: 'A local dispute could become an armed confrontation.',
        escalationBeats: [
          "A threat changes the farmer's options.",
          'Troops arrive and raise the stakes.',
        ],
        reversal: 'Officials prevent the expected battle.',
        endingPayoff: 'The crisis ends with an absurdly small casualty.',
        voiceDirection: 'Dry and alert, with emphasis on the reversals.',
        factualGuardrails: ['Do not invent dialogue or casualty counts.'],
      },
      sourceClaims: [],
      canon: { characters: [], props: [], observations: [] },
      beatCandidates: [],
    };
    episode.alignment!.scriptRevisionSha256 =
      episode.story.scriptRevision.textSha256;
    startProducer(episode, boundedPolicy(30, 120_000));

    const report = await assessProducer(root, episode);

    expect(
      report.stages.find((stage) => stage.stage === 'script'),
    ).toMatchObject({ status: 'needs-review', reasons: [] });
  });

  it('exposes a real CLI state file and fails closed without prior inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storyframe-producer-cli-'));
    await runCli(['new', root, 'episode-01']);
    await expect(
      runCli(['producer', root, 'init', 'guided', '40', '120']),
    ).resolves.toBe(0);
    const episode = JSON.parse(
      await readFile(join(root, 'episode.json'), 'utf8'),
    );
    expect(episode.production.policy.maxShots).toBe(40);
    expect(episode.production.policy.maxDurationMs).toBe(120_000);
    expect(episode.production.policy.publishingAuthorized).toBe(false);
    await expect(
      runCli(['producer', root, 'approve', 'research', 'owner', 'looks good']),
    ).rejects.toThrow(/current evidence/i);
    await expect(runCli(['producer', root, 'package'])).rejects.toThrow(
      /accepted QA/i,
    );
    await expect(
      runCli(['producer', root, 'init', 'auto', '40', '120']),
    ).rejects.toThrow(/already exists/i);
  });
});
