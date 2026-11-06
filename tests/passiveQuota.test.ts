/**
 * Live quota from the proxy's passive header observations — the source the
 * quota page uses so it never has to poll rate-limited usage endpoints.
 */

import { describe, expect, test } from 'bun:test';
import {
  mergeQuotaLimits,
  readPassiveQuota,
  rollOverLimits,
  shouldClearStaleCooldown,
} from '@/features/quota/passiveQuota';
import type { QuotaLimitSummary } from '@/features/quota/quotaRowSummary';
import type { AuthFileItem } from '@/types';

const NOW = 1_791_490_000_000;
const sec = (ms: number) => String(Math.floor(ms / 1000));

const file = (extra: Record<string, unknown>): AuthFileItem =>
  ({ name: 'x.json', ...extra }) as AuthFileItem;

describe('readPassiveQuota', () => {
  test('Claude: unified 5h/7d utilization becomes remaining percent', () => {
    const quota = readPassiveQuota(
      'claude',
      file({
        quota: {
          observed_at: '2026-10-09T02:17:11+05:30',
          signals: {
            'Anthropic-Ratelimit-Unified-5h-Utilization': '0.08',
            'Anthropic-Ratelimit-Unified-5h-Reset': sec(NOW + 3_600_000),
            'Anthropic-Ratelimit-Unified-5h-Status': 'allowed',
            'Anthropic-Ratelimit-Unified-7d-Utilization': '0.4',
            'Anthropic-Ratelimit-Unified-7d-Reset': sec(NOW + 86_400_000),
          },
        },
      })
    );
    expect(quota.limits.map((l) => [l.id, l.remaining, l.primary])).toEqual([
      ['five-hour', 92, true],
      ['seven-day', 60, true],
    ]);
    expect(quota.limits[0].labelKey).toBe('claude_quota.five_hour');
    expect(quota.observedAtMs).toBe(Date.parse('2026-10-09T02:17:11+05:30'));
  });

  test('Claude: a rejected window is exhausted regardless of utilization', () => {
    const quota = readPassiveQuota(
      'claude',
      file({
        quota: {
          signals: {
            'Anthropic-Ratelimit-Unified-5h-Utilization': '0.97',
            'Anthropic-Ratelimit-Unified-5h-Status': 'rejected',
            'Anthropic-Ratelimit-Unified-5h-Reset': sec(NOW + 60_000),
          },
        },
      })
    );
    expect(quota.limits[0].remaining).toBe(0);
  });

  test('Codex: primary/secondary windows, plan type, and window length', () => {
    const quota = readPassiveQuota(
      'codex',
      file({
        quota: {
          signals: {
            'X-Codex-Plan-Type': 'plus',
            'X-Codex-Primary-Used-Percent': '33',
            'X-Codex-Primary-Window-Minutes': '300',
            'X-Codex-Primary-Reset-At': sec(NOW + 7_200_000),
            'X-Codex-Secondary-Used-Percent': '54',
            'X-Codex-Secondary-Window-Minutes': '10080',
            'X-Codex-Secondary-Reset-At': sec(NOW + 400_000_000),
          },
        },
      })
    );
    expect(quota.planType).toBe('plus');
    expect(quota.limits.map((l) => [l.id, l.remaining, l.periodHours])).toEqual([
      ['five-hour', 67, 5],
      ['weekly', 46, 168],
    ]);
  });

  test('falls back to the newest per-model snapshot when the account one is empty', () => {
    const quota = readPassiveQuota(
      'codex',
      file({
        quota: { signals: {} },
        model_quotas: {
          old: {
            observed_at: '2026-10-08T10:00:00Z',
            signals: { 'X-Codex-Primary-Used-Percent': '90' },
          },
          new: {
            observed_at: '2026-10-08T12:00:00Z',
            signals: { 'X-Codex-Primary-Used-Percent': '10' },
          },
        },
      })
    );
    expect(quota.limits[0].remaining).toBe(90); // newest snapshot: 10% used
  });

  test('rollOverLimits: a window whose reset has passed shows as full with no next reset', () => {
    const quota = readPassiveQuota(
      'codex',
      file({
        quota: {
          signals: {
            'X-Codex-Primary-Used-Percent': '100',
            'X-Codex-Primary-Window-Minutes': '300',
            'X-Codex-Primary-Reset-At': sec(NOW - 60_000),
          },
        },
      })
    );
    // The raw limit keeps its anchor for the timeline…
    expect(quota.limits[0]).toMatchObject({ remaining: 0, resetAtMs: NOW - 60_000 });
    // …while the displayed one has rolled over.
    expect(rollOverLimits(quota.limits, NOW)[0]).toMatchObject({ remaining: 100, resetAtMs: null });
    expect(rollOverLimits(quota.limits, NOW - 120_000)[0].remaining).toBe(0);
  });

  test('providers without passive observation and credentials without signals give nothing', () => {
    expect(readPassiveQuota('kimi', file({ quota: { signals: { a: '1' } } })).limits).toEqual([]);
    expect(readPassiveQuota('claude', file({})).limits).toEqual([]);
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

describe('mergeQuotaLimits', () => {
  test('live windows replace fetched ones by id; fetched-only windows are kept', () => {
    const merged = mergeQuotaLimits(
      [
        limit({ id: 'five-hour', remaining: 80, label: 'fetched 5h' }),
        limit({ id: 'seven-day-fable', remaining: 100, primary: false }),
      ],
      [limit({ id: 'five-hour', remaining: 60 }), limit({ id: 'seven-day', remaining: 40 })]
    );
    expect(merged.map((l) => [l.id, l.remaining])).toEqual([
      ['seven-day', 40],
      ['five-hour', 60],
      ['seven-day-fable', 100],
    ]);
    expect(merged.find((l) => l.id === 'five-hour')?.label).toBe('fetched 5h');
  });

  test('a fetch newer than the passive observation wins shared windows', () => {
    // Weekly reset done on ChatGPT: the proxy still remembers 100% used.
    const merged = mergeQuotaLimits(
      [limit({ id: 'weekly', remaining: 100 }), limit({ id: 'five-hour', remaining: 100 })],
      [limit({ id: 'weekly', remaining: 0 }), limit({ id: 'monthly', remaining: 50 })],
      { fetchedAtMs: NOW, liveObservedAtMs: NOW - 60_000 }
    );
    expect(merged.map((l) => [l.id, l.remaining])).toEqual([
      ['monthly', 50],
      ['weekly', 100],
      ['five-hour', 100],
    ]);
  });

  test('passive data observed after the fetch still wins', () => {
    const merged = mergeQuotaLimits(
      [limit({ id: 'five-hour', remaining: 100 })],
      [limit({ id: 'five-hour', remaining: 30 })],
      { fetchedAtMs: NOW - 60_000, liveObservedAtMs: NOW }
    );
    expect(merged.map((l) => l.remaining)).toEqual([30]);
  });
});

describe('shouldClearStaleCooldown', () => {
  const cooled = file({ next_retry_after: new Date(NOW + 4 * 86_400_000).toISOString() });
  const usable = [
    limit({ id: 'five-hour', remaining: 100 }),
    limit({ id: 'weekly', remaining: 100 }),
  ];

  test('newer fetch shows quota back while the proxy is still cooling down', () => {
    expect(shouldClearStaleCooldown(cooled, usable, NOW, NOW - 60_000, NOW)).toBe(true);
  });

  test('not when any primary window is still exhausted', () => {
    const limits = [...usable.slice(0, 1), limit({ id: 'weekly', remaining: 0 })];
    expect(shouldClearStaleCooldown(cooled, limits, NOW, NOW - 60_000, NOW)).toBe(false);
  });

  test('not when the fetch is older than the passive observation', () => {
    expect(shouldClearStaleCooldown(cooled, usable, NOW - 60_000, NOW, NOW)).toBe(false);
  });

  test('not when there is no active cooldown', () => {
    const expired = file({ next_retry_after: new Date(NOW - 1000).toISOString() });
    expect(shouldClearStaleCooldown(expired, usable, NOW, null, NOW)).toBe(false);
    expect(shouldClearStaleCooldown(file({}), usable, NOW, null, NOW)).toBe(false);
  });
});
