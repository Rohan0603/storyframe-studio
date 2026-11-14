import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStableId } from './ids.js';

export const STORY_SKILLS = [
  'premise-workshop',
  'research',
  'plot-structure',
  'character-management',
  'worldbuilding',
  'scene-craft',
  'voice-style',
  'revision-continuity',
  'story-maintenance',
  'series-continuity',
] as const;

export type StorySkill = (typeof STORY_SKILLS)[number];
export type StoryStage =
  | 'premise'
  | 'research'
  | 'planning'
  | 'scene'
  | 'script'
  | 'maintenance'
  | 'series';

const SKILLS_BY_STAGE: Record<StoryStage, readonly StorySkill[]> = {
  premise: ['premise-workshop'],
  research: ['research'],
  planning: ['plot-structure', 'character-management', 'worldbuilding'],
  scene: ['scene-craft'],
  script: ['voice-style', 'revision-continuity'],
  maintenance: ['story-maintenance'],
  series: ['series-continuity'],
};

export function normalizeSpokenText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashNormalizedSpokenText(text: string): string {
  return createHash('sha256')
    .update(normalizeSpokenText(text), 'utf8')
    .digest('hex');
}

export interface ScriptSegment {
  id: string;
  speakerId: string;
  startChar: number;
  endChar: number;
  spokenText: string;
}

export interface ScriptRevision {
  id: string;
  text: string;
  textSha256: string;
  segments: ScriptSegment[];
}

export function createScriptRevision(input: {
  id: string;
  text: string;
  segments: Array<Omit<ScriptSegment, 'spokenText'>>;
}): ScriptRevision {
  assertStableId(input.id, 'script revision ID');
  const text = normalizeSpokenText(input.text);
  const segments = input.segments.map((segment) => {
    assertStableId(segment.id, 'script segment ID');
    assertStableId(segment.speakerId, 'speaker ID');
    if (
      segment.startChar < 0 ||
      segment.endChar < segment.startChar ||
      segment.endChar > text.length
    )
      throw new Error(`invalid script span for ${segment.id}`);
    return {
      ...segment,
      spokenText: text.slice(segment.startChar, segment.endChar),
    };
  });
  return {
    id: input.id,
    text,
    textSha256: hashNormalizedSpokenText(text),
    segments,
  };
}

export interface SourceClaim {
  id: string;
  statement: string;
  sourceUrl: string;
  retrievedDate: string;
  confidence: 'high' | 'medium' | 'low';
  status: 'verified' | 'disputed' | 'open';
}

export function validateClaimLedger(
  claims: SourceClaim[],
  options: { factualRelease: boolean },
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const claim of claims) {
    if (ids.has(claim.id)) errors.push(`duplicate claim ID: ${claim.id}`);
    ids.add(claim.id);
    try {
      new URL(claim.sourceUrl);
    } catch {
      errors.push(`claim ${claim.id} sourceUrl is invalid`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(claim.retrievedDate))
      errors.push(`claim ${claim.id} retrievedDate is invalid`);
    if (options.factualRelease && claim.status !== 'verified')
      errors.push(
        `claim ${claim.id} is ${claim.status} and blocks factual release`,
      );
  }
  return { valid: errors.length === 0, errors };
}

export interface CanonEntity {
  id: string;
  name: string;
  state: string;
}

export interface CanonObservation {
  entityId: string;
  beatId: string;
  state: string;
  transition?: boolean;
}

export interface StoryCanon {
  characters: CanonEntity[];
  props: CanonEntity[];
  observations: CanonObservation[];
}

export function validateCanon(canon: StoryCanon): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const entities = new Map(
    [...canon.characters, ...canon.props].map((entity) => [entity.id, entity]),
  );
  const seen = new Map<string, string>();
  for (const observation of canon.observations) {
    const entity = entities.get(observation.entityId);
    if (!entity) {
      errors.push(
        `observation references unknown entity ${observation.entityId}`,
      );
      continue;
    }
    const key = `${observation.entityId}:${observation.beatId}`;
    const previous = seen.get(key);
    if (previous && previous !== observation.state)
      errors.push(
        `contradictory state for ${observation.entityId} at ${observation.beatId}`,
      );
    if (observation.state !== entity.state && !observation.transition)
      errors.push(
        `state contradicts canon for ${observation.entityId}: ${observation.state}`,
      );
    seen.set(key, observation.state);
  }
  return { valid: errors.length === 0, errors };
}

export function selectSkills(stage: StoryStage): StorySkill[] {
  return [...SKILLS_BY_STAGE[stage]];
}

export interface LoadedSkill {
  name: StorySkill;
  path: string;
  content: string;
}

export async function loadSelectedSkills(
  stage: StoryStage,
  skillRoot: string,
): Promise<{
  loaded: LoadedSkill[];
  trace: { stage: StoryStage; selected: StorySkill[]; loaded: StorySkill[] };
}> {
  const selected = selectSkills(stage);
  const loaded = await Promise.all(
    selected.map(async (name) => {
      const path = join(skillRoot, name, 'SKILL.md');
      return { name, path, content: await readFile(path, 'utf8') };
    }),
  );
  return {
    loaded,
    trace: { stage, selected, loaded: loaded.map((skill) => skill.name) },
  };
}
