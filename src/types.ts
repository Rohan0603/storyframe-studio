import type {
  NarrativePlan,
  ScriptRevision,
  SourceClaim,
  StoryCanon,
} from './story-layer.js';
import type { ProducerSession } from './producer.js';

export type StageStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'needs-review'
  | 'approved'
  | 'rejected'
  | 'blocked'
  | 'failed'
  | 'stale';
export type EpisodeMode = 'guided' | 'auto';
export type NarrationProvider =
  | 'offline-fixture'
  | 'gemini-tts'
  | 'kokoro-onnx';

export interface Episode {
  schemaVersion: 1;
  episodeId: string;
  mode: EpisodeMode;
  script: { path: string; sha256: string; approved: boolean };
  referenceBundle: { path: string; sha256: string };
  series?: SeriesConfiguration;
  /** Strict production gates opt-in; old episodes stay readable. */
  imagePolicy?: {
    width: 1920;
    height: 1080;
    requireNativeReceipt: boolean;
    requireVisualScreening: boolean;
  };
  referenceBible?: ReferenceBibleManifest;
  narration: {
    provider: NarrationProvider;
    textSha256: string;
    audioPath: string;
    alignmentPath: string;
    alignmentVerified: boolean;
    alignmentSha256?: string;
    model?: string;
    voiceName?: string;
    audioSha256?: string;
    audioDurationMs?: number;
    receiptPath?: string;
    captionsPath?: string;
  };
  story?: {
    scriptRevision: ScriptRevision;
    narrativePlan?: NarrativePlan;
    sourceClaims: SourceClaim[];
    canon: StoryCanon;
    beatCandidates: BeatCandidate[];
  };
  alignment?: AlignmentPlan;
  /** Optional v2 audio-locked projection; v1 episodes remain readable but unverified. */
  syncTimeline?: SyncTimeline;
  production?: ProducerSession;
  beats: Beat[];
  shots: Shot[];
  release: {
    productionQAPassed: boolean;
    creativeApproval: string | null;
    publishAuthorization: string | null;
    youtubeTarget?: { videoId: string; state: 'scheduled' | 'public'; publishAt?: string; videoPath: string; videoSha256: string };
    youtubeVerification?: { path: string; sha256: string };
  };
}

export interface SeriesConfiguration {
  seriesId: string;
  revisionId: string;
  biblePath: string;
  bibleSha256: string;
  visualFormat: '2d-still' | '3d-still';
  applied: boolean;
  /** Immutable per-episode snapshot of time-versioned visual states. */
  evolution?: {
    path: string;
    sha256: string;
    episodeOrder: number;
    predecessor?: { path: string; sha256: string; manifestPath: string; manifestSha256: string; legacyMigrationNotes?: string };
  };
}

export type ReferenceKind = 'character' | 'prop' | 'environment' | 'style';

export interface ReferenceImage {
  path: string;
  sha256: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  approved: boolean;
}

export interface ReferenceEntry {
  id: string;
  kind: ReferenceKind;
  name: string;
  visualCanon: string;
  image: ReferenceImage;
  canonEntityId?: string;
}

export interface ReferenceBible {
  bundleId: string;
  storyRevisionId: string;
  storyRevisionSha256: string;
  canonSha256: string;
  entries: ReferenceEntry[];
}

export interface ReferenceBibleManifest {
  path: string;
  sha256: string;
  freezeSha256: string;
  storyRevisionId: string;
  storyRevisionSha256: string;
  canonSha256: string;
  status: 'draft' | 'frozen' | 'stale';
}

export interface BeatCandidate {
  id: string;
  spokenText: string;
  scriptStartChar: number;
  scriptEndChar: number;
  sourceClaimIds: string[];
}

export interface Beat {
  id: string;
  spokenText: string;
  scriptStartChar: number;
  scriptEndChar: number;
  sourceClaimIds: string[];
  scriptRevisionId?: string;
  scriptRevisionSha256?: string;
}
export type VisualPurpose = 'action' | 'establishing' | 'transition' | 'hold';

export interface AlignmentPlan {
  scriptRevisionId: string;
  scriptSha256: string;
  scriptRevisionSha256?: string;
  timingStatus: 'provisional' | 'verified';
  audioDurationMs: number | null;
  density: {
    style: 'reflective' | 'cinematic' | 'energetic' | 'custom';
    targetMin: number;
    targetMax: number;
  };
}
export interface Shot {
  id: string;
  sceneId?: string;
  beatIds: string[];
  audioStartMs: number;
  audioEndMs: number;
  requiredVisualEvent: string;
  imagePrompt?: string;
  characters: string[];
  props: string[];
  environment: string;
  composition: string;
  forbidden: string[];
  visualPurpose?: VisualPurpose;
  intentionalHold?: {
    reason: string;
    relatedBeatIds: string[];
  };
  image: {
    path: string;
    sha256: string | null;
    status: StageStatus;
    provenance?: ImageProvenance;
  };
  semanticReview: {
    status: 'pending' | 'pass' | 'fail' | 'unknown';
    reviewedImageSha256: string | null;
    notes: string;
    pixelsDecoded?: boolean;
    reviewedPacketSha256?: string;
    screening?: {
      imageSha256: string;
      collage: 'clear' | 'suspected' | 'unknown';
      text: 'clear' | 'detected' | 'unknown';
      checkedBy: string;
      notes: string;
      evidencePath?: string;
      evidenceSha256?: string;
      allowedText?: string[];
    };
  };
  referenceBinding?: {
    freezeSha256: string;
    storyRevisionId: string;
    referenceIds: string[];
    referenceHashes: Record<string, string>;
  };
  seriesBinding?: {
    seriesId: string;
    revisionId: string;
    /** Active, immutable appearance/prop state for entities used by this shot. */
    entityStates?: Record<string, string>;
  };
}

export interface SyncSubtitleCue {
  cueId: string;
  startMs: number;
  endMs: number;
  text: string;
  alignmentStatus: 'verified' | 'provisional' | 'unknown';
  sourceWordStart?: number;
  sourceWordEnd?: number;
}

export interface SyncTimelineRecord {
  shotId: string;
  sceneId: string;
  startMs: number;
  endMs: number;
  narration: {
    beatIds: string[];
    text: string;
    scriptStartChar: number;
    scriptEndChar: number;
    timingSource: 'audio-verified';
  };
  image: {
    prompt: string;
    promptSha256: string;
    requiredVisualEvent: string;
    path: string;
    sha256: string | null;
    sourceShotId: string;
    pixelReview: 'pass' | 'fail' | 'unknown' | 'pending';
    referenceFreezeSha256?: string;
  };
  subtitles: SyncSubtitleCue[];
  purpose?: VisualPurpose;
}

export interface SyncTimeline {
  version: 1;
  status: 'verified' | 'legacy-unverified';
  audioSha256: string;
  audioDurationMs: number;
  scriptSha256: string;
  alignmentPath: string;
  records: SyncTimelineRecord[];
}

export interface ImageProvenance {
  tool: 'codex-desktop.image_gen';
  packetSha256: string;
  attemptId: string;
  /** ID actually returned by the native generator. Never infer from shot or attempt IDs. */
  nativeReceiptId?: string;
  journalPath?: string;
  journalEntrySha256?: string;
  providerEvidence?: { path: string; sha256: string };
  normalizationReceipt?: { path: string; sha256: string };
  /** Original native output preserved separately when normalized. */
  nativeImage?: { path: string; sha256: string; width: number; height: number };
  receiptStatus: 'persisted' | 'reconciled';
  width: number;
  height: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
export interface Checkpoint {
  stage: string;
  attempt: number;
  status: StageStatus;
  inputHashes: Record<string, string>;
  outputHashes: Record<string, string>;
  recordedAt: string;
}

export type ImageReviewStatus = 'approved' | 'rejected' | 'unknown';
