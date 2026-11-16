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
  referenceBible?: ReferenceBibleManifest;
  narration: {
    provider: NarrationProvider;
    textSha256: string;
    audioPath: string;
    alignmentPath: string;
    alignmentVerified: boolean;
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
  production?: ProducerSession;
  beats: Beat[];
  shots: Shot[];
  release: {
    productionQAPassed: boolean;
    creativeApproval: string | null;
    publishAuthorization: string | null;
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
  beatIds: string[];
  audioStartMs: number;
  audioEndMs: number;
  requiredVisualEvent: string;
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
  };
  referenceBinding?: {
    freezeSha256: string;
    storyRevisionId: string;
    referenceIds: string[];
    referenceHashes: Record<string, string>;
  };
}

export interface ImageProvenance {
  tool: 'codex-desktop.image_gen';
  packetSha256: string;
  attemptId: string;
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
