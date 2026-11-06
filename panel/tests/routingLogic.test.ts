import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import {
  applyFlatPreset,
  applyPlanPreset,
  buildRoutingSavePlan,
  changedSettingKeys,
  credentialState,
  effectiveTTLMs,
  groupByProvider,
  groupIntoTiers,
  normalizeClaudePlanType,
  parseGoDurationMs,
  planPresetPriority,
  pruneSavedDrafts,
  readExcludedBaseline,
  readRoutingSettings,
  stickyResetRisk,
  toRoutingCredentials,
  updateCredentialDraft,
  validatePriorityText,
  validateRoutingDraft,
  validateTTL,
  validateWeightText,
  type RoutingCredential,
  type RoutingDraftState,
  type RoutingSettings,
} from '@/features/routing/logic';

const routing = {
  strategy: 'fill-first',
  'session-affinity': true,
  'session-affinity-ttl': '30m',
  retry: { 'request-retry': 2, 'max-retry-credentials': 0, 'max-retry-interval': 30 },
  cooldown: { 'disable-cooling': false, 'transient-error-cooldown-seconds': -1 },
};

const baseline = readRoutingSettings(routing, { claude: true, codex: false });

const credential = (overrides: Partial<RoutingCredential> = {}): RoutingCredential => ({
  key: 'a.json',
  name: 'a.json',
  provider: 'codex',
  label: 'a@example.test',
  disabled: false,
  editable: true,
  priority: 0,
  planType: null,
  ...overrides,
});

const state = (overrides: Partial<RoutingDraftState> = {}): RoutingDraftState => ({
  baseline,
  settings: baseline,
  credentials: [],
  drafts: {},
  excluded: {},
  ...overrides,
});

const withSettings = (patch: Partial<RoutingSettings>) => ({ ...baseline, ...patch });

describe('routing settings', () => {
  test('reads the v8 routing subtree with backend defaults', () => {
    expect(baseline).toEqual({
      strategy: 'fill-first',
      sessionAffinity: true,
      sessionAffinityTTL: '30m',
      sessionAffinitySubagents: true,
      requestRetry: '2',
      maxRetryCredentials: '0',
      maxRetryInterval: '30',
      cooling: true,
      saveCooldownStatus: false,
      transientErrorCooldownSeconds: '-1',
      claudeModelLevelCooling: true,
      codexModelLevelCooling: false,
    });
    const empty = readRoutingSettings({});
    expect(empty.strategy).toBe('round-robin');
    expect(empty.sessionAffinitySubagents).toBe(true);
    expect(readRoutingSettings({ strategy: 'wrr' }).strategy).toBe('weighted-round-robin');
    expect(readRoutingSettings({ cooldown: { 'disable-cooling': true } }).cooling).toBe(false);
  });

  test('parses Go durations and validates the TTL minimum', () => {
    expect(parseGoDurationMs('1h')).toBe(3_600_000);
    expect(parseGoDurationMs('2h30m')).toBe(9_000_000);
    expect(parseGoDurationMs('1.5s')).toBe(1500);
    expect(parseGoDurationMs('500ms')).toBe(500);
    expect(parseGoDurationMs('1d')).toBeNull();
    expect(parseGoDurationMs('-1h')).toBeNull();
    expect(validateTTL('')).toBeNull();
    expect(validateTTL('soon')).toBe('duration');
    expect(validateTTL('500ms')).toBe('duration_min');
    expect(validateTTL('1s')).toBeNull();
    expect(effectiveTTLMs('')).toBe(3_600_000);
  });

  test('validates only changed settings', () => {
    const odd = readRoutingSettings({ 'session-affinity-ttl': 'garbage' });
    expect(validateRoutingDraft(state({ baseline: odd, settings: odd })).valid).toBe(true);
    const result = validateRoutingDraft(
      state({ settings: withSettings({ requestRetry: '-1', maxRetryInterval: '1.5' }) })
    );
    expect(result.valid).toBe(false);
    expect(result.settings).toEqual({ requestRetry: 'non_negative', maxRetryInterval: 'integer' });
  });

  test('builds a nested routing merge patch, deletions and upstream patch', () => {
    const plan = buildRoutingSavePlan(
      state({
        settings: withSettings({
          strategy: 'weighted-round-robin',
          sessionAffinityTTL: '',
          requestRetry: '3',
          maxRetryCredentials: '',
          cooling: false,
          saveCooldownStatus: true,
          codexModelLevelCooling: true,
        }),
      })
    );
    expect(plan.routingPatch).toEqual({
      strategy: 'weighted-round-robin',
      retry: { 'request-retry': 3 },
      cooldown: { 'disable-cooling': true, 'save-cooldown-status': true },
    });
    expect(plan.routingDeletions).toEqual([
      ['session-affinity-ttl'],
      ['retry', 'max-retry-credentials'],
    ]);
    expect(plan.upstreamPatch).toEqual({ codex: true });
    expect(plan.changeCount).toBe(7);
    expect(changedSettingKeys(baseline, baseline)).toEqual([]);
  });

  test('flags sticky resets only when affinity is live and the selector changes', () => {
    expect(stickyResetRisk(baseline, withSettings({ requestRetry: '9' }))).toBe(false);
    expect(stickyResetRisk(baseline, withSettings({ strategy: 'round-robin' }))).toBe(true);
    expect(stickyResetRisk(baseline, withSettings({ sessionAffinityTTL: '1h' }))).toBe(true);
    expect(stickyResetRisk(baseline, withSettings({ sessionAffinityTTL: ' 30m ' }))).toBe(false);
    expect(stickyResetRisk(baseline, withSettings({ sessionAffinitySubagents: false }))).toBe(true);
    const off = withSettings({ sessionAffinity: false });
    expect(stickyResetRisk(off, { ...off, strategy: 'round-robin' })).toBe(false);
  });
});

describe('credential pools', () => {
  const files: AuthFileItem[] = [
    {
      name: 'b.json',
      type: 'codex',
      email: 'b@x.test',
      priority: 5,
      id_token: { plan_type: 'team' },
    },
    { name: 'a.json', type: 'codex', email: 'a@x.test', plan_type: 'plus' },
    { name: 'a.json', type: 'codex', email: 'dup@x.test' },
    { name: 'c.json', type: 'claude', disabled: true, weight: 3 },
    { name: 'v.json', type: 'vertex', runtime_only: true },
    { name: 'e.json', type: '' },
  ];

  test('dedupes by file, resolves plans and groups providers claude, codex, then others', () => {
    const credentials = toRoutingCredentials(files, (provider) =>
      provider === 'claude' ? 'plan_max' : null
    );
    expect(credentials.map((item) => item.key)).toEqual(['b.json', 'a.json', 'c.json', 'v.json']);
    expect(credentials[0]).toMatchObject({ priority: 5, planType: 'team', label: 'b@x.test' });
    expect(credentials[1].planType).toBe('plus');
    expect(credentials[2]).toMatchObject({ planType: 'plan_max', weight: 3, label: 'c' });
    expect(credentials[3].editable).toBe(false);
    expect(groupByProvider(credentials).map((pool) => pool.provider)).toEqual([
      'claude',
      'codex',
      'vertex',
    ]);
  });

  test('normalizes Claude plan claims', () => {
    expect(normalizeClaudePlanType('max')).toBe('plan_max');
    expect(normalizeClaudePlanType('plan_team')).toBe('plan_team');
    expect(normalizeClaudePlanType('PRO')).toBe('plan_pro');
    expect(normalizeClaudePlanType('mystery')).toBeNull();
  });

  test('groups tiers highest first, with draft priorities and serving/fallback roles', () => {
    const a = credential({ key: 'a', name: 'a', label: 'a', priority: 10, disabled: true });
    const b = credential({ key: 'b', name: 'b', label: 'b', priority: 5 });
    const c = credential({ key: 'c', name: 'c', label: 'c', priority: 0 });
    const tiers = groupIntoTiers([c, b, a], { c: { priority: '5' }, b: { priority: 'x' } });
    expect(
      tiers.map((tier) => [tier.priority, tier.role, tier.credentials.map((x) => x.key)])
    ).toEqual([
      [10, 'off', ['a']],
      [5, 'primary', ['b', 'c']],
    ]);
  });

  test('keeps drafts minimal and validates priority/weight text', () => {
    const item = credential({ priority: 3, weight: 2 });
    let drafts = updateCredentialDraft({}, item, { priority: '4' });
    expect(drafts).toEqual({ 'a.json': { priority: '4' } });
    drafts = updateCredentialDraft(drafts, item, { priority: '3' });
    expect(drafts).toEqual({});
    expect(updateCredentialDraft({}, item, { weight: '2' })).toEqual({});
    expect(validatePriorityText('')).toBe('integer');
    expect(validatePriorityText('-5')).toBeNull();
    expect(validatePriorityText('99999999999')).toBe('max');
    expect(validateWeightText('')).toBeNull();
    expect(validateWeightText('-1')).toBe('non_negative');
    expect(validateWeightText('1000001')).toBe('max');
    expect(validateWeightText('1.5')).toBe('integer');
  });

  test('plan presets rank Codex Plus/Pro > Team > Go/Free and Claude Max > Team > Pro', () => {
    expect(planPresetPriority('codex', 'pro')).toBe(20);
    expect(planPresetPriority('codex', 'plus')).toBe(20);
    expect(planPresetPriority('codex', 'team')).toBe(10);
    expect(planPresetPriority('codex', 'free')).toBe(0);
    expect(planPresetPriority('claude', 'plan_max20')).toBe(30);
    expect(planPresetPriority('claude', 'plan_team')).toBe(20);
    expect(planPresetPriority('claude', 'plan_pro')).toBe(10);
    expect(planPresetPriority('gemini', 'pro')).toBeNull();

    const pool = [
      credential({ key: 'p', name: 'p', planType: 'pro' }),
      credential({ key: 't', name: 't', planType: 'team', priority: 10 }),
      credential({ key: 'u', name: 'u', planType: null, priority: 7 }),
      credential({ key: 'r', name: 'r', planType: 'go', editable: false }),
    ];
    const result = applyPlanPreset(pool, {});
    expect(result).toEqual({ drafts: { p: { priority: '20' } }, applied: 2, skipped: 1 });
    expect(applyFlatPreset(pool, result.drafts)).toEqual({
      t: { priority: '0' },
      u: { priority: '0' },
    });
  });

  test('derives per-credential patches; weights only under weighted round robin', () => {
    const a = credential({ key: 'a', name: 'a', label: 'A', priority: 1, weight: 4 });
    const b = credential({ key: 'b', name: 'b', label: 'B' });
    const ro = credential({ key: 'r', name: 'r', editable: false });
    const drafts = {
      a: { priority: '2', weight: '' },
      b: { weight: '9', excludedText: 'gpt-x\n gpt-x \nGPT-y' },
      r: { priority: '3' },
    };
    const excluded = { b: { models: [], field: 'excluded-models' as const } };
    const rr = buildRoutingSavePlan(state({ credentials: [a, b, ro], drafts, excluded }));
    expect(rr.credentialPatches).toEqual([
      { name: 'a', label: 'A', fields: { priority: 2 } },
      { name: 'b', label: 'B', fields: { 'excluded-models': ['gpt-x', 'GPT-y'] } },
    ]);
    expect(rr.changeCount).toBe(2);

    const weighted = withSettings({ strategy: 'weighted-round-robin' });
    const wrr = buildRoutingSavePlan(
      state({ settings: weighted, credentials: [a, b], drafts, excluded })
    );
    expect(wrr.credentialPatches.map((patch) => patch.fields)).toEqual([
      { priority: 2, weight: null },
      { weight: 9, 'excluded-models': ['gpt-x', 'GPT-y'] },
    ]);
    // strategy + 4 credential fields
    expect(wrr.changeCount).toBe(5);

    const invalid = validateRoutingDraft(
      state({ settings: weighted, credentials: [a], drafts: { a: { weight: 'x', priority: '' } } })
    );
    expect(invalid.credentials).toEqual({ a: { priority: 'integer', weight: 'integer' } });
    expect(pruneSavedDrafts(drafts, ['a', 'b'])).toEqual({ r: { priority: '3' } });
  });

  test('reads excluded models from either key spelling', () => {
    expect(readExcludedBaseline({ 'excluded-models': ['a', 'A', ' b '] })).toEqual({
      models: ['a', 'b'],
      field: 'excluded-models',
    });
    expect(readExcludedBaseline({})).toEqual({ models: [], field: 'excluded_models' });
  });

  test('summarizes runtime state from cooldown snapshots', () => {
    const now = Date.now();
    const cooling = credential({
      cooldown: {
        receivedAtMs: now,
        records: [{ scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: 90 }],
      },
    });
    expect(credentialState(cooling, now)).toEqual({
      kind: 'cooling',
      scope: 'credential',
      modelCount: 0,
      seconds: 90,
    });
    expect(credentialState(cooling, now + 91_000)).toEqual({ kind: 'ready' });
    expect(credentialState(credential({ disabled: true }), now)).toEqual({ kind: 'off' });
    expect(
      credentialState(credential({ cooldown: { receivedAtMs: now, records: null } }), now)
    ).toEqual({ kind: 'unknown' });
  });
});
