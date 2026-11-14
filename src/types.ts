import type { ScriptRevision, SourceClaim, StoryCanon } from './story-layer.js';

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

export interface Episode {
  schemaVersion: 1;
  episodeId: string;
  mode: EpisodeMode;
  script: { path: string; sha256: string; approved: boolean };
  referenceBundle: { path: string; sha256: string };
  narration: {
    provider: string;
    textSha256: string;
    audioPath: string;
    alignmentPath: string;
    alignmentVerified: boolean;
  };
  story?: {
    scriptRevision: ScriptRevision;
    sourceClaims: SourceClaim[];
    canon: StoryCanon;
    beatCandidates: BeatCandidate[];
  };
  alignment?: AlignmentPlan;
  beats: Beat[];
  shots: Shot[];
  release: {
    productionQAPassed: boolean;
    creativeApproval: string | null;
    publishAuthorization: string | null;
  };
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
  image: { path: string; sha256: string | null; status: StageStatus };
  semanticReview: {
    status: 'pending' | 'pass' | 'fail' | 'unknown';
    reviewedImageSha256: string | null;
    notes: string;
  };
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
