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
  beats: Beat[];
  shots: Shot[];
  release: {
    productionQAPassed: boolean;
    creativeApproval: string | null;
    publishAuthorization: string | null;
  };
}

export interface Beat {
  id: string;
  spokenText: string;
  scriptStartChar: number;
  scriptEndChar: number;
  sourceClaimIds: string[];
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
