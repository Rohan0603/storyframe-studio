import { describe, expect, it } from 'vitest';
import {
  validateNarrativePlan,
  type NarrativePlan,
} from '../src/story-layer.js';

const goodPlan: NarrativePlan = {
  hook: 'A pig turns a potato patch into an international crisis.',
  contradiction: 'The supposedly trivial incident mobilizes two militaries.',
  protagonistGoal: 'Cutlar wants to protect his farm and avoid arrest.',
  stakes: 'A disputed island could become a U.S.-British armed confrontation.',
  escalationBeats: [
    'Cutlar is threatened with arrest.',
    'Troops and warships arrive.',
  ],
  reversal: 'The admiral refuses to fight over the pig and forces a pause.',
  endingPayoff:
    'The boundary is settled years later; the pig remains the only casualty.',
  voiceDirection:
    'Dry, alert, quick on reversals; stress the absurd nouns and military scale.',
  factualGuardrails: [
    'Do not call it a declared war.',
    'Do not invent dialogue or casualty counts.',
  ],
};

describe('narrative plan contract', () => {
  it('accepts a complete plan with concrete story functions', () => {
    expect(validateNarrativePlan(goodPlan)).toEqual([]);
  });

  it('rejects a premise-only plan that cannot drive an engaging two-minute story', () => {
    const errors = validateNarrativePlan({
      ...goodPlan,
      escalationBeats: [],
      reversal: '',
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'at least two escalation beats are required',
        'reversal or turn is required',
      ]),
    );
  });

  it('requires voice direction and factual guardrails separately', () => {
    const errors = validateNarrativePlan({
      ...goodPlan,
      voiceDirection: '',
      factualGuardrails: [],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'voice direction is required',
        'at least one factual guardrail is required',
      ]),
    );
  });
});
