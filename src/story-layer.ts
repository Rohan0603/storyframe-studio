import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertStableId, isStableId } from './ids.js';
import { resolveContained } from './paths.js';

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

export function validateScriptRevision(revision: ScriptRevision): string[] {
  const errors: string[] = [];
  if (!isStableId(revision.id))
    errors.push(`script revision ID is invalid: ${revision.id}`);
  if (revision.textSha256 !== hashNormalizedSpokenText(revision.text))
    errors.push('script revision hash mismatch');
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const segment of revision.segments) {
    if (!isStableId(segment.id) || ids.has(segment.id))
      errors.push(`script segment ID is invalid or duplicated: ${segment.id}`);
    ids.add(segment.id);
    if (!isStableId(segment.speakerId))
      errors.push(`speaker ID is invalid: ${segment.speakerId}`);
    if (
      !Number.isInteger(segment.startChar) ||
      !Number.isInteger(segment.endChar) ||
      segment.startChar < previousEnd ||
      segment.endChar < segment.startChar ||
      segment.endChar > revision.text.length ||
      revision.text.slice(segment.startChar, segment.endChar) !==
        segment.spokenText
    )
      errors.push(`invalid script segment span for ${segment.id}`);
    previousEnd = segment.endChar;
  }
  return errors;
}

export function createScriptRevision(input: {
  id: string;
  text: string;
  segments: Array<Omit<ScriptSegment, 'spokenText'>>;
}): ScriptRevision {
  assertStableId(input.id, 'script revision ID');
  const text = normalizeSpokenText(input.text);
  const ids = new Set<string>();
  let previousEnd = 0;
  const segments = input.segments.map((segment) => {
    assertStableId(segment.id, 'script segment ID');
    assertStableId(segment.speakerId, 'speaker ID');
    if (ids.has(segment.id))
      throw new Error(`duplicate script segment ID: ${segment.id}`);
    ids.add(segment.id);
    if (
      !Number.isInteger(segment.startChar) ||
      !Number.isInteger(segment.endChar) ||
      segment.startChar < previousEnd ||
      segment.endChar < segment.startChar ||
      segment.endChar > text.length
    )
      throw new Error(`invalid script span for ${segment.id}`);
    previousEnd = segment.endChar;
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
  if (!Array.isArray(claims))
    return { valid: false, errors: ['claim ledger must be an array'] };
  const ids = new Set<string>();
  for (const claim of claims) {
    if (!isStableId(claim.id)) errors.push(`claim ID is invalid: ${claim.id}`);
    if (ids.has(claim.id)) errors.push(`duplicate claim ID: ${claim.id}`);
    ids.add(claim.id);
    if (!claim.statement.trim())
      errors.push(`claim ${claim.id} statement is required`);
    try {
      const url = new URL(claim.sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('scheme');
    } catch {
      errors.push(`claim ${claim.id} sourceUrl is invalid`);
    }
    const date = new Date(`${claim.retrievedDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(claim.retrievedDate) ||
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== claim.retrievedDate
    )
      errors.push(`claim ${claim.id} retrievedDate is invalid`);
    if (!['high', 'medium', 'low'].includes(claim.confidence))
      errors.push(`claim ${claim.id} confidence is invalid`);
    if (!['verified', 'disputed', 'open'].includes(claim.status))
      errors.push(`claim ${claim.id} status is invalid`);
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
  if (
    !canon ||
    !Array.isArray(canon.characters) ||
    !Array.isArray(canon.props) ||
    !Array.isArray(canon.observations)
  )
    return { valid: false, errors: ['canon has an invalid shape'] };
  const entities = new Map<string, CanonEntity>();
  for (const entity of [...canon.characters, ...canon.props]) {
    if (!isStableId(entity.id))
      errors.push(`invalid canon entity ID: ${entity.id}`);
    if (entities.has(entity.id))
      errors.push(`duplicate canon entity ID: ${entity.id}`);
    entities.set(entity.id, entity);
  }
  const seen = new Map<string, string>();
  for (const observation of canon.observations) {
    if (!isStableId(observation.beatId))
      errors.push(`invalid beat ID: ${observation.beatId}`);
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
    const effective = seen.get(observation.entityId) ?? entity.state;
    if (observation.state !== effective && !observation.transition)
      errors.push(
        `state contradicts canon for ${observation.entityId}: ${observation.state}`,
      );
    seen.set(key, observation.state);
    seen.set(observation.entityId, observation.state);
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
      const path = await resolveContained(skillRoot, `${name}/SKILL.md`);
      return { name, path, content: await readFile(path, 'utf8') };
    }),
  );
  return {
    loaded,
    trace: { stage, selected, loaded: loaded.map((skill) => skill.name) },
  };
}
