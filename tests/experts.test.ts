import { describe, expect, test } from 'bun:test';
import {
  EXPERT_IDS,
  EXPERT_PROFILES,
  expertRoutingGuide,
  expertRoutingTable,
  isExpertId,
  resolveExpertModel,
} from '../src/config/experts';
import { BUILD_MODEL, getModelEntry } from '../src/config/models';

describe('expert roster', () => {
  test('every expert id has a complete profile', () => {
    for (const id of EXPERT_IDS) {
      const p = EXPERT_PROFILES[id];
      expect(p.id).toBe(id);
      expect(p.displayName.length).toBeGreaterThan(0);
      expect(p.summary.length).toBeGreaterThan(20);
      expect(p.whenToUse.length).toBeGreaterThan(0);
      expect(p.whenNotToUse.length).toBeGreaterThan(0);
      expect(p.preferredModel.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(p.thinkingLevel);
      expect(p.compaction.keepRecentTokens).toBeGreaterThan(0);
      expect(p.compaction.reserveTokens).toBeGreaterThan(0);
    }
  });

  test('preferred models are registered (or known vision/code variants)', () => {
    for (const id of EXPERT_IDS) {
      const model = EXPERT_PROFILES[id].preferredModel;
      const entry = getModelEntry(model);
      expect(entry).toBeDefined();
    }
  });

  test('experts use specialized models by default (not all identical)', () => {
    const models = new Set(
      EXPERT_IDS.map((id) => EXPERT_PROFILES[id].preferredModel),
    );
    // At least fast / strong / vision (or deep) differentiation
    expect(models.size).toBeGreaterThanOrEqual(3);
  });

  test('spectacle prefers a vision-capable model', () => {
    const model = EXPERT_PROFILES.spectacle.preferredModel;
    const entry = getModelEntry(model);
    expect(entry?.vision).toBe(true);
  });

  test('research has no codebase tools; oracle has search tools', () => {
    expect(EXPERT_PROFILES.research.toolkit).not.toContain('ripgrep');
    expect(EXPERT_PROFILES.research.toolkit).toContain('web_search');
    expect(EXPERT_PROFILES.oracle.toolkit).toContain('semantic_search');
    expect(EXPERT_PROFILES.spectacle.toolkit).toEqual([]);
  });

  test('resolveExpertModel prefers LAVALAMP_EXPERT_<ID>_MODEL', () => {
    const model = resolveExpertModel('oracle', {
      LAVALAMP_EXPERT_ORACLE_MODEL: 'anthropic/claude-sonnet-4-20250514',
      LAVALAMP_MODEL: BUILD_MODEL,
    });
    expect(model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  test('resolveExpertModel can follow session model when requested', () => {
    const model = resolveExpertModel('ui', {
      LAVALAMP_EXPERTS_FOLLOW_SESSION: '1',
      LAVALAMP_MODEL: 'openai/gpt-4o',
    });
    expect(model).toBe('openai/gpt-4o');
  });

  test('resolveExpertModel uses preferred model by default', () => {
    const model = resolveExpertModel('critique', {});
    expect(model).toBe(EXPERT_PROFILES.critique.preferredModel);
  });

  test('isExpertId and routing helpers', () => {
    expect(isExpertId('ui')).toBe(true);
    expect(isExpertId('nope')).toBe(false);
    const table = expertRoutingTable();
    for (const id of EXPERT_IDS) {
      expect(table).toContain(`\`${id}\``);
    }
    const guide = expertRoutingGuide();
    expect(guide).toContain('Mixture of Experts');
    expect(guide).toContain('oracle');
  });
});
