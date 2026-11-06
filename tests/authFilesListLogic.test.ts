import { describe, expect, test } from 'bun:test';
import {
  countByProviderKey,
  getAuthFileProviderKey,
  groupAuthFilesByProvider,
  resolveAuthFileHealth,
  resolveAuthFileQuotaType,
  summarizeAuthFileGroup,
} from '../src/features/authFiles/logic';
import type { AuthFileItem } from '../src/types';

const authFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'credential.json',
  type: 'codex',
  ...overrides,
});

const NOW = 1_700_000_000_000;

const cooling = (remainingSeconds: number): Partial<AuthFileItem> => ({
  cooldownSnapshot: {
    receivedAtMs: NOW,
    records: [{ scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds }],
  },
});

describe('resolveAuthFileQuotaType', () => {
  test('all shows each supported provider quota', () => {
    expect(resolveAuthFileQuotaType(authFile({ type: 'codex' }), 'all')).toBe('codex');
    expect(resolveAuthFileQuotaType(authFile({ type: 'kimi' }), 'all')).toBe('kimi');
  });

  test('unsupported providers or mismatched filters show no quota', () => {
    expect(resolveAuthFileQuotaType(authFile({ type: 'gemini' }), 'all')).toBeNull();
    expect(resolveAuthFileQuotaType(authFile({ type: 'codex' }), 'claude')).toBeNull();
    expect(resolveAuthFileQuotaType(authFile({ type: 'codex' }), null)).toBeNull();
  });
});

describe('groupAuthFilesByProvider', () => {
  test('groups by normalized provider key, type first then provider', () => {
    expect(getAuthFileProviderKey(authFile({ type: 'Codex' }))).toBe('codex');
    expect(getAuthFileProviderKey(authFile({ type: undefined, provider: 'claude' }))).toBe(
      'claude'
    );
    expect(getAuthFileProviderKey(authFile({ type: undefined }))).toBe('unknown');
  });

  test('orders groups alphabetically with unknown last and rows by name', () => {
    const files = [
      authFile({ name: 'z.json', type: 'codex' }),
      authFile({ name: 'x.json', type: undefined }),
      authFile({ name: 'a.json', type: 'codex' }),
      authFile({ name: 'm.json', type: 'claude' }),
    ];
    const groups = groupAuthFilesByProvider(files);
    expect(groups.map((group) => group.type)).toEqual(['claude', 'codex', 'unknown']);
    expect(groups[1].files.map((file) => file.name)).toEqual(['a.json', 'z.json']);
    expect(files.map((file) => file.name)).toEqual(['z.json', 'x.json', 'a.json', 'm.json']);
  });

  test('keeps same-name credentials apart by auth index order', () => {
    const groups = groupAuthFilesByProvider([
      authFile({ name: 'same.json', authIndex: 'b' }),
      authFile({ name: 'same.json', authIndex: 'a' }),
    ]);
    expect(groups[0].files.map((file) => file.authIndex)).toEqual(['a', 'b']);
  });
});

describe('resolveAuthFileHealth', () => {
  test('disabled wins over problems; problems win over cooldowns', () => {
    expect(resolveAuthFileHealth(authFile({ disabled: true, unavailable: true }), NOW)).toEqual({
      kind: 'disabled',
    });
    expect(resolveAuthFileHealth(authFile({ unavailable: true, ...cooling(60) }), NOW)).toEqual({
      kind: 'problem',
    });
    expect(resolveAuthFileHealth(authFile({ statusMessage: 'HTTP 429' }), NOW).kind).toBe(
      'problem'
    );
  });

  test('active cooldowns report the remaining server-measured seconds', () => {
    expect(resolveAuthFileHealth(authFile(cooling(240)), NOW)).toEqual({
      kind: 'cooling',
      seconds: 240,
    });
    expect(resolveAuthFileHealth(authFile(cooling(240)), NOW + 240_000)).toEqual({ kind: 'ok' });
    expect(resolveAuthFileHealth(authFile({ statusMessage: 'ok' }), NOW)).toEqual({ kind: 'ok' });
  });
});

describe('summarizeAuthFileGroup', () => {
  test('counts active credentials and selects only selectable problem rows', () => {
    const problem = authFile({ name: 'p.json', unavailable: true });
    const virtualProblem = authFile({ name: 'v.json', unavailable: true, runtimeOnly: true });
    const files = [
      authFile({ name: 'ok.json' }),
      authFile({ name: 'cool.json', ...cooling(30) }),
      authFile({ name: 'off.json', disabled: true }),
      problem,
      virtualProblem,
    ];
    const summary = summarizeAuthFileGroup(files, (file) => resolveAuthFileHealth(file, NOW));
    expect(summary.total).toBe(5);
    expect(summary.active).toBe(2);
    expect(summary.problemCount).toBe(2);
    expect(summary.problemFiles).toEqual([problem]);
  });
});

describe('countByProviderKey', () => {
  test('normalizes provider keys before counting', () => {
    const counts = countByProviderKey({ Codex: ['a', 'b'], codex: ['c'], claude: [] });
    expect(counts.get('codex')).toBe(3);
    expect(counts.get('claude')).toBe(0);
  });
});
