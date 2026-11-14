import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STORY_SKILLS,
  createScriptRevision,
  hashNormalizedSpokenText,
  loadSelectedSkills,
  normalizeSpokenText,
  selectSkills,
  validateCanon,
  validateClaimLedger,
} from '../src/story-layer.js';

describe('story layer', () => {
  it('normalizes spoken text and hashes it deterministically', () => {
    expect(normalizeSpokenText('  Hello\r\n  world  ')).toBe('Hello world');
    expect(hashNormalizedSpokenText('Hello\nworld')).toBe(
      hashNormalizedSpokenText(' Hello   world '),
    );
  });

  it('creates an exact, speaker-stable script revision', () => {
    const revision = createScriptRevision({
      id: 'script-rev-01',
      text: 'Mira: Open the chest.',
      segments: [
        { id: 'span-01', speakerId: 'speaker-mira', startChar: 0, endChar: 21 },
      ],
    });
    expect(revision.textSha256).toHaveLength(64);
    expect(revision.segments[0]?.speakerId).toBe('speaker-mira');
    expect(revision.segments[0]?.spokenText).toBe('Mira: Open the chest.');
  });

  it('rejects unstable script and speaker IDs', () => {
    expect(() =>
      createScriptRevision({
        id: 'Script 01',
        text: 'Hello',
        segments: [
          { id: 'span-01', speakerId: 'Speaker 01', startChar: 0, endChar: 5 },
        ],
      }),
    ).toThrow(/stable ID/i);
  });

  it('blocks disputed and open claims from factual release', () => {
    const result = validateClaimLedger(
      [
        {
          id: 'claim-01',
          statement: 'A claim',
          sourceUrl: 'https://example.com/source',
          retrievedDate: '2026-11-14',
          confidence: 'medium',
          status: 'disputed',
        },
      ],
      { factualRelease: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/claim-01.*disputed/i);
  });

  it('rejects contradictory character and prop states', () => {
    const result = validateCanon({
      characters: [{ id: 'character-mira', name: 'Mira', state: 'alive' }],
      props: [{ id: 'prop-crystal', name: 'Crystal', state: 'blue' }],
      observations: [
        { entityId: 'character-mira', beatId: 'beat-01', state: 'dead' },
        { entityId: 'prop-crystal', beatId: 'beat-01', state: 'red' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/character-mira|prop-crystal/);
  });

  it('selects and loads only skills relevant to a stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'story-skills-'));
    await mkdir(join(root, 'premise-workshop'));
    await mkdir(join(root, 'research'));
    await mkdir(join(root, 'publishing'));
    await writeFile(join(root, 'premise-workshop', 'SKILL.md'), 'premise');
    await writeFile(join(root, 'research', 'SKILL.md'), 'research');
    await writeFile(join(root, 'publishing', 'SKILL.md'), 'publishing');

    const selected = selectSkills('research');
    const loaded = await loadSelectedSkills('research', root);
    expect(selected).toEqual(['research']);
    expect(loaded.loaded.map((skill) => skill.name)).toEqual(['research']);
    expect(loaded.trace).toEqual({
      stage: 'research',
      selected: ['research'],
      loaded: ['research'],
    });
    expect(STORY_SKILLS).not.toContain('publishing');
  });
});
