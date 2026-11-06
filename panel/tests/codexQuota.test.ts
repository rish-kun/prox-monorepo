import { afterEach, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
  CODEX_CONFIG,
  buildCodexQuotaWindows,
  normalizeCodexAccountCredits,
} from '@/features/quota/providers/codex/data';
import type { CodexQuotaState, CodexUsagePayload } from '@/types';
import {
  apiCallApi,
  normalizeSnapshot,
  quotaSnapshotsApi,
  type QuotaSnapshotSet,
} from '@/services/api';
import { normalizeCodexResetCreditsPayload, parseCodexUsagePayload } from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const originalApiCallRequest = apiCallApi.request;
const originalRefresh = quotaSnapshotsApi.refresh;

/** A proxy snapshot with raw upstream responses, as `POST /quota/refresh` returns it. */
const bundle = (
  authIndex: string,
  responses: Record<string, { status_code: number; body: unknown }>
): QuotaSnapshotSet => ({
  pollIntervalSeconds: 3600,
  snapshots: {
    [authIndex]: normalizeSnapshot({
      auth_index: authIndex,
      provider: 'codex',
      fetched_at: '2026-10-26T10:00:00Z',
      attempted_at: '2026-10-26T10:00:00Z',
      responses,
      error: '',
      error_status: 0,
    }),
  },
});

const CURRENT_CODEX_USAGE_PAYLOAD: CodexUsagePayload = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 1,
      limit_window_seconds: 604800,
      reset_after_seconds: 601888,
      reset_at: 1785902974,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604800,
          reset_after_seconds: 602111,
          reset_at: 1785903197,
        },
        secondary_window: null,
      },
    },
  ],
  rate_limit_reset_credits: {
    available_count: 1,
    applicable_available_count: 0,
  },
};

afterEach(() => {
  apiCallApi.request = originalApiCallRequest;
  quotaSnapshotsApi.refresh = originalRefresh;
});

/** Any direct upstream call from the adapter is a bug: the proxy owns these endpoints. */
const forbidDirectCalls = () => {
  apiCallApi.request = async (payload) => {
    throw new Error(`Unexpected direct upstream call: ${payload.url}`);
  };
};

describe('Codex current usage payload', () => {
  test('parses the proxied JSON body and classifies both primary weekly windows', () => {
    const payload = parseCodexUsagePayload(JSON.stringify(CURRENT_CODEX_USAGE_PAYLOAD));
    expect(payload).not.toBeNull();

    const windows = buildCodexQuotaWindows(payload!, t);

    expect(windows.map(({ id }) => id)).toEqual(['weekly', 'gpt-5-3-codex-spark-weekly-0']);
    expect(windows.map(({ labelKey }) => labelKey)).toEqual([
      'codex_quota.secondary_window',
      'codex_quota.additional_secondary_window',
    ]);
    expect(windows.map(({ usedPercent }) => usedPercent)).toEqual([1, 0]);
    expect(windows[1]?.labelParams).toEqual({ name: 'GPT-5.3-Codex-Spark' });
  });

  test('shows reset support when total credits remain but none currently apply', () => {
    const summary = normalizeCodexResetCreditsPayload(
      CURRENT_CODEX_USAGE_PAYLOAD.rate_limit_reset_credits
    );

    expect(summary.invalidPayload).toBeFalse();
    expect(summary.availableCount).toBe(1);
    expect(summary.applicableAvailableCount).toBe(0);

    const quota: CodexQuotaState = {
      status: 'success',
      windows: [],
      rateLimitResetCreditsAvailableCount: summary.availableCount,
      rateLimitResetCreditsApplicableAvailableCount: summary.applicableAvailableCount,
    };
    expect(CODEX_CONFIG.canResetQuota?.(quota)).toBeTrue();
  });

  test('keeps reset support for legacy payloads without applicable count', () => {
    const quota: CodexQuotaState = {
      status: 'success',
      windows: [],
      rateLimitResetCreditsAvailableCount: 1,
    };

    expect(CODEX_CONFIG.canResetQuota?.(quota)).toBeTrue();
  });
});

describe('Codex account credits', () => {
  test('normalizes remaining balance without confusing it with manual resets', () => {
    expect(
      normalizeCodexAccountCredits({ has_credits: false, unlimited: false, balance: '0' })
    ).toEqual({ balance: '0', unlimited: false });
    expect(
      normalizeCodexAccountCredits({ has_credits: true, unlimited: false, balance: ' 12.50 ' })
    ).toEqual({ balance: '12.50', unlimited: false });
    expect(normalizeCodexAccountCredits({ unlimited: true, balance: null })).toEqual({
      balance: null,
      unlimited: true,
    });
    expect(normalizeCodexAccountCredits(null)).toEqual({ balance: null, unlimited: false });
    expect(normalizeCodexAccountCredits({ balance: 'not available' })).toEqual({
      balance: null,
      unlimited: false,
    });
    expect(normalizeCodexAccountCredits({ balance: -1 })).toEqual({
      balance: null,
      unlimited: false,
    });
  });

  test('reads credits from the proxy bundle and forwards them into quota state', async () => {
    forbidDirectCalls();
    const refreshed: Array<{ indexes?: readonly string[]; force?: boolean }> = [];
    quotaSnapshotsApi.refresh = async (indexes, options = {}) => {
      refreshed.push({ indexes, force: options.force });
      return bundle('codex:1', {
        usage: {
          status_code: 200,
          body: {
            ...CURRENT_CODEX_USAGE_PAYLOAD,
            credits: { has_credits: true, unlimited: false, balance: '8.75' },
          },
        },
        reset_credits: { status_code: 200, body: { available_count: 1, credits: [] } },
      });
    };

    const data = await CODEX_CONFIG.fetchQuota(
      { name: 'codex.json', type: 'codex', auth_index: 'codex:1' },
      t
    );
    const state = CODEX_CONFIG.buildSuccessState(data);
    expect(state.creditBalance).toBe('8.75');
    expect(state.creditsUnlimited).toBeFalse();
    expect(state.rateLimitResetCreditsAvailableCount).toBe(1);
    expect(state.fetchedAtMs).toBe(Date.parse('2026-10-26T10:00:00Z'));
    expect(refreshed).toEqual([{ indexes: ['codex:1'], force: undefined }]);
  });
});

describe('Codex live subscription renewal', () => {
  const file = {
    name: 'codex.json',
    type: 'codex',
    auth_index: 'codex:1',
    chatgpt_subscription_active_until: '2026-09-03T13:27:01Z',
  };

  test('prefers the subscription response stored in the bundle', async () => {
    forbidDirectCalls();
    quotaSnapshotsApi.refresh = async () =>
      bundle('codex:1', {
        usage: { status_code: 200, body: JSON.stringify(CURRENT_CODEX_USAGE_PAYLOAD) },
        subscription: { status_code: 200, body: { active_until: '2026-10-03T13:27:01Z' } },
      });

    const quota = await CODEX_CONFIG.fetchQuota(file, t);
    expect(quota.subscriptionActiveUntil).toBe('2026-10-03T13:27:01Z');
    expect(quota.windows.map(({ id }) => id)).toEqual(['weekly', 'gpt-5-3-codex-spark-weekly-0']);
  });

  test('falls back to the credential date when the subscription probe failed', async () => {
    forbidDirectCalls();
    quotaSnapshotsApi.refresh = async () =>
      bundle('codex:1', {
        usage: { status_code: 200, body: CURRENT_CODEX_USAGE_PAYLOAD },
        subscription: { status_code: 503, body: { error: 'temporarily unavailable' } },
        reset_credits: { status_code: 500, body: 'upstream exploded' },
      });

    const quota = await CODEX_CONFIG.fetchQuota(file, t);
    expect(quota.subscriptionActiveUntil).toBe('2026-09-03T13:27:01Z');
    expect(quota.rateLimitResetCreditsError).toBe('500 upstream exploded');
    // The usage payload's own reset-credit summary still applies.
    expect(quota.rateLimitResetCreditsAvailableCount).toBe(1);
  });
});
