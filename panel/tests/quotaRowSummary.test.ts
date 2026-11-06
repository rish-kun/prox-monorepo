/**
 * Compact quota rows: normalizing every provider's limits, and deciding when
 * the status column speaks.
 */

import { describe, expect, test } from 'bun:test';
import {
  canStartQuotaWindow,
  resolveQuotaRowStatus,
  summarizeProviderGroup,
  summarizeQuotaLimits,
  type QuotaLimitSummary,
} from '@/features/quota/quotaRowSummary';

const HOUR = 3_600_000;

const codexQuota = {
  status: 'success',
  windows: [
    { id: 'weekly', label: 'Weekly', usedPercent: 52, resetAtMs: 5 * 24 * HOUR, periodHours: 168 },
    { id: 'five-hour', label: '5h', usedPercent: 22, resetAtMs: 2 * HOUR, periodHours: 5 },
    {
      id: 'code-review-weekly',
      label: 'Code review weekly',
      usedPercent: 100,
      resetAtMs: 3 * HOUR,
      periodHours: 168,
    },
    // A model window sharing the account window's period (e.g. Spark weekly).
    { id: 'spark-weekly-0', label: 'Spark weekly', usedPercent: 10, periodHours: 168 },
  ],
};

describe('summarizeQuotaLimits', () => {
  test('returns nothing until the quota has loaded', () => {
    expect(summarizeQuotaLimits('codex', undefined)).toEqual([]);
    expect(summarizeQuotaLimits('codex', { status: 'loading' })).toEqual([]);
  });

  test('Codex: account windows first, shortest first; model windows are not primary', () => {
    const limits = summarizeQuotaLimits('codex', codexQuota);
    expect(limits.map((limit) => [limit.id, limit.primary, limit.remaining])).toEqual([
      ['five-hour', true, 78],
      ['weekly', true, 48],
      ['code-review-weekly', false, 0],
      ['spark-weekly-0', false, 90],
    ]);
  });

  test('Claude: only the 5-hour and 7-day windows are account-wide', () => {
    const limits = summarizeQuotaLimits('claude', {
      status: 'success',
      windows: [
        { id: 'five-hour', label: '5h', labelKey: 'claude_quota.five_hour', usedPercent: 4 },
        { id: 'seven-day', label: '7d', usedPercent: 0 },
        { id: 'seven-day-fable', label: 'Fable', usedPercent: 0 },
      ],
    });
    expect(limits.map((limit) => [limit.id, limit.primary])).toEqual([
      ['five-hour', true],
      ['seven-day', true],
      ['seven-day-fable', false],
    ]);
    expect(limits[0]).toMatchObject({ labelKey: 'claude_quota.five_hour', remaining: 96 });
  });

  test('normalizes remaining percent across provider conventions', () => {
    const devin = summarizeQuotaLimits('devin', {
      status: 'success',
      windows: [{ id: 'daily', remainingPercent: 40, resetAtMs: HOUR, periodHours: 24 }],
    } as never);
    expect(devin[0]).toMatchObject({ remaining: 40, labelKey: 'devin_quota.daily', primary: true });

    const antigravity = summarizeQuotaLimits('antigravity', {
      status: 'success',
      groups: [{ buckets: [{ id: 'gemini', label: 'Gemini', remainingFraction: 0.25 }] }],
    } as never);
    expect(antigravity[0]).toMatchObject({ remaining: 25, primary: false });

    const kimi = summarizeQuotaLimits('kimi', {
      status: 'success',
      rows: [{ id: 'weekly', label: 'Weekly', used: 30, limit: 120 }],
    } as never);
    expect(kimi[0]).toMatchObject({ remaining: 75, usage: { used: 30, limit: 120 } });

    const meta = summarizeQuotaLimits('meta', {
      status: 'success',
      data: { windows: [{ id: 'weekly', usedPercent: 10, resetAt: 100 }] },
    } as never);
    expect(meta[0]).toMatchObject({ remaining: 90, resetAtMs: 100_000, periodHours: 168 });

    const xai = summarizeQuotaLimits('xai', {
      status: 'success',
      billing: { periodType: 'weekly', usagePercent: 35, resetAtMs: HOUR },
    } as never);
    expect(xai[0]).toMatchObject({ remaining: 65, labelKey: 'xai_quota.weekly_limit' });
  });

  test('xAI monthly billing is not a quota window', () => {
    expect(
      summarizeQuotaLimits('xai', {
        status: 'success',
        billing: { periodType: 'monthly', usagePercent: 99 },
      } as never)
    ).toEqual([]);
  });
});

const limit = (overrides: Partial<QuotaLimitSummary>): QuotaLimitSummary => ({
  id: 'x',
  label: 'x',
  remaining: 50,
  resetAtMs: null,
  periodHours: null,
  primary: true,
  ...overrides,
});

describe('resolveQuotaRowStatus', () => {
  test('healthy accounts say nothing', () => {
    expect(resolveQuotaRowStatus({ status: 'success' }, false, [limit({})])).toEqual({
      kind: 'ok',
    });
  });

  test('a model-scoped window at 0% does not block the account', () => {
    const status = resolveQuotaRowStatus({ status: 'success' }, false, [
      limit({ id: 'five-hour' }),
      limit({ id: 'fable', primary: false, remaining: 0, resetAtMs: HOUR }),
    ]);
    expect(status.kind).toBe('ok');
  });

  test('exhausted accounts come back at the LATEST reset among exhausted windows', () => {
    const status = resolveQuotaRowStatus({ status: 'success' }, false, [
      limit({ id: 'five-hour', remaining: 0, resetAtMs: 2 * HOUR }),
      limit({ id: 'weekly', remaining: 0, resetAtMs: 120 * HOUR }),
    ]);
    expect(status).toEqual({ kind: 'exhausted', backAtMs: 120 * HOUR });
  });

  test('an exhausted window without a reset instant leaves the return time unknown', () => {
    const status = resolveQuotaRowStatus({ status: 'success' }, false, [
      limit({ remaining: 0, resetAtMs: null }),
    ]);
    expect(status).toEqual({ kind: 'exhausted', backAtMs: null });
  });

  test('401 means logged out; other failures are errors', () => {
    expect(resolveQuotaRowStatus({ status: 'error', errorStatus: 401 }, false, []).kind).toBe(
      'logged_out'
    );
    expect(
      resolveQuotaRowStatus({ status: 'error', error: 'boom', errorStatus: 500 }, false, [])
    ).toEqual({ kind: 'error', message: 'boom', status: 500 });
  });

  test('live limits count even when nothing was fetched', () => {
    expect(resolveQuotaRowStatus(undefined, false, [limit({})]).kind).toBe('ok');
    expect(resolveQuotaRowStatus(undefined, false, []).kind).toBe('idle');
  });

  test('a failed fetch (e.g. 429) is hidden while live limits exist', () => {
    expect(
      resolveQuotaRowStatus({ status: 'error', errorStatus: 429 }, false, [limit({})]).kind
    ).toBe('ok');
    // …but an expired login always surfaces.
    expect(
      resolveQuotaRowStatus({ status: 'error', errorStatus: 401 }, false, [limit({})]).kind
    ).toBe('logged_out');
  });

  test('disabled wins over everything', () => {
    expect(resolveQuotaRowStatus({ status: 'error', errorStatus: 401 }, true, []).kind).toBe(
      'disabled'
    );
  });
});

describe('summarizeProviderGroup', () => {
  test('counts available accounts and the soonest return', () => {
    expect(
      summarizeProviderGroup([
        { kind: 'ok' },
        { kind: 'exhausted', backAtMs: 5 * HOUR },
        { kind: 'exhausted', backAtMs: 2 * HOUR },
        { kind: 'logged_out' },
        { kind: 'loading' },
      ])
    ).toEqual({ total: 5, available: 1, nextBackAtMs: 2 * HOUR });
  });
});

describe('canStartQuotaWindow', () => {
  const NOW = 1_791_600_000_000;
  const fiveHour = (overrides: Partial<QuotaLimitSummary>): QuotaLimitSummary => ({
    id: 'five-hour',
    label: '5h',
    remaining: 100,
    resetAtMs: null,
    periodHours: 5,
    primary: true,
    ...overrides,
  });
  const ok = { kind: 'ok' } as const;

  test('idle 5-hour window (no reset instant) can be started', () => {
    expect(canStartQuotaWindow('claude', ok, [fiveHour({})], NOW)).toBe(true);
    expect(canStartQuotaWindow('codex', ok, [fiveHour({})], NOW)).toBe(true);
  });

  test('a running window cannot', () => {
    const running = fiveHour({ remaining: 99, resetAtMs: NOW + 2 * HOUR });
    expect(canStartQuotaWindow('claude', ok, [running], NOW)).toBe(false);
  });

  test('an unused window whose reset keeps sliding a full period ahead is idle', () => {
    const sliding = fiveHour({ resetAtMs: NOW + 5 * HOUR });
    expect(canStartQuotaWindow('codex', ok, [sliding], NOW)).toBe(true);
    const justStarted = fiveHour({ resetAtMs: NOW + 5 * HOUR - 10 * 60_000 });
    expect(canStartQuotaWindow('codex', ok, [justStarted], NOW)).toBe(false);
  });

  test('no data yet still offers the button', () => {
    expect(canStartQuotaWindow('claude', { kind: 'idle' }, [], NOW)).toBe(true);
  });

  test('never for blocked accounts or other providers', () => {
    for (const status of [
      { kind: 'disabled' },
      { kind: 'logged_out' },
      { kind: 'loading' },
      { kind: 'error', message: 'x' },
      { kind: 'exhausted', backAtMs: null },
    ] as const) {
      expect(canStartQuotaWindow('claude', status, [fiveHour({})], NOW)).toBe(false);
    }
    expect(canStartQuotaWindow('kimi', ok, [fiveHour({})], NOW)).toBe(false);
  });
});
