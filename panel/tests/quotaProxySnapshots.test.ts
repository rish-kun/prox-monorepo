/**
 * Claude / Codex quota comes only from the proxy: API normalisation, adapters
 * building state from a snapshot bundle, the single batched refresh, and
 * hydration from stored snapshots without any upstream call.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
  CLAUDE_CONFIG,
  buildClaudeQuotaFromSnapshot,
} from '@/features/quota/providers/claude/data';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { QUOTA_ADAPTERS } from '@/features/quota/providers';
import {
  hydrateProxyQuota,
  refreshProxyQuotaEntries,
  shouldHydrate,
} from '@/features/quota/proxyQuota';
import {
  QUOTA_HISTORY_PATH,
  QUOTA_REFRESH_PATH,
  QUOTA_SNAPSHOTS_PATH,
  apiCallApi,
  apiClient,
  normalizeQuotaHistory,
  normalizeSnapshot,
  normalizeSnapshotSet,
  quotaSnapshotsApi,
  type QuotaSnapshotSet,
} from '@/services/api';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as TFunction;
const mocks: Array<{ mockRestore(): void }> = [];
const track = <T extends { mockRestore(): void }>(mock: T): T => {
  mocks.push(mock);
  return mock;
};

beforeEach(() => {
  useQuotaStore.getState().clearQuotaCache();
  // Any direct upstream call is a failure: the proxy owns these endpoints.
  track(
    spyOn(apiCallApi, 'request').mockImplementation(async (payload) => {
      throw new Error(`Unexpected direct upstream call: ${payload.url}`);
    })
  );
});

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

const FETCHED = '2026-10-26T10:00:00Z';
const FETCHED_MS = Date.parse(FETCHED);

const CLAUDE_USAGE = {
  five_hour: { utilization: 12, resets_at: '2026-10-26T12:00:00Z' },
  seven_day: { utilization: 40, resets_at: '2026-10-30T09:00:00Z' },
};

const claudeSnapshot = (overrides: Record<string, unknown> = {}) =>
  normalizeSnapshot({
    auth_index: 'claude:1',
    provider: 'claude',
    fetched_at: FETCHED,
    attempted_at: FETCHED,
    responses: {
      usage: { status_code: 200, body: CLAUDE_USAGE },
      profile: { status_code: 200, body: { account: { has_claude_max: true } } },
    },
    error: '',
    error_status: 0,
    next_poll_at: '2026-10-26T11:00:00Z',
    ...overrides,
  });

describe('quota snapshot API normalisation', () => {
  test('maps snake_case snapshots, parses JSON bodies and keeps non-JSON text', () => {
    const set = normalizeSnapshotSet({
      poll_interval_seconds: 3600,
      snapshots: {
        'claude:1': {
          auth_index: 'claude:1',
          provider: 'Claude',
          fetched_at: FETCHED,
          attempted_at: '2026-10-26T10:05:00Z',
          responses: {
            usage: { status_code: 200, body: { five_hour: { utilization: 3 } } },
            profile: { status_code: 200, body: '{"account":{}}' },
            subscription: { status_code: 502, body: 'Bad Gateway' },
            junk: 'not an object',
          },
          error: 'HTTP 429',
          error_status: 429,
          next_poll_at: null,
        },
        // Missing fields degrade to defaults; the map key fills auth_index.
        'codex:2': {},
      },
    });
    expect(set.pollIntervalSeconds).toBe(3600);
    const claude = set.snapshots['claude:1'];
    expect(claude.provider).toBe('claude');
    expect(claude.fetchedAtMs).toBe(FETCHED_MS);
    expect(claude.attemptedAtMs).toBe(Date.parse('2026-10-26T10:05:00Z'));
    expect(claude.nextPollAtMs).toBeNull();
    expect(claude.errorStatus).toBe(429);
    expect(claude.responses.usage.body).toEqual({ five_hour: { utilization: 3 } });
    expect(claude.responses.profile.body).toEqual({ account: {} });
    expect(claude.responses.subscription).toEqual({
      statusCode: 502,
      body: 'Bad Gateway',
      bodyText: 'Bad Gateway',
    });
    expect(Object.keys(claude.responses).sort()).toEqual(['profile', 'subscription', 'usage']);
    expect(set.snapshots['codex:2']).toEqual({
      authIndex: 'codex:2',
      provider: '',
      fetchedAtMs: null,
      attemptedAtMs: null,
      responses: {},
      error: '',
      errorStatus: null,
      nextPollAtMs: null,
    });
  });

  test('success snapshots carry an empty error and a zero status', () => {
    const snapshot = claudeSnapshot();
    expect(snapshot.error).toBe('');
    expect(snapshot.errorStatus).toBeNull();
  });

  test('tolerates garbage at the top level', () => {
    expect(normalizeSnapshotSet(null)).toEqual({ pollIntervalSeconds: 0, snapshots: {} });
    expect(normalizeSnapshotSet({ snapshots: [] })).toEqual({
      pollIntervalSeconds: 0,
      snapshots: {},
    });
  });

  test('history: sorts samples, drops malformed ones, clamps usage, reads accounts', () => {
    const history = normalizeQuotaHistory({
      provider: 'codex',
      window: '5h',
      from: 1000,
      to: 5000,
      first_recorded_at: 900,
      samples: [
        { t: 3000, auth_index: 'b', used: 120, resets_at: 9000 },
        // Before `from`: the account's starting state, kept as-is.
        { t: 500, auth_index: 'a', used: 10 },
        { t: 2000, auth_index: 'a', used: '25.5', resets_at: 0 },
        { t: 0, auth_index: 'a', used: 1 },
        { t: 2500, used: 1 },
        { t: 2600, auth_index: 'a', used: null },
      ],
      accounts: {
        a: { label: 'a@example.com', priority: 5, disabled: false },
        b: { label: '', disabled: true },
        c: null,
      },
    });
    expect(history.window).toBe('5h');
    expect(history.firstRecordedAt).toBe(900);
    expect(history.samples).toEqual([
      { t: 500, authIndex: 'a', used: 10, resetsAt: 0 },
      { t: 2000, authIndex: 'a', used: 25.5, resetsAt: 0 },
      { t: 3000, authIndex: 'b', used: 100, resetsAt: 9000 },
    ]);
    expect(history.accounts).toEqual({
      a: { label: 'a@example.com', priority: 5, disabled: false },
      b: { label: '', priority: 0, disabled: true },
      c: { label: '', priority: 0, disabled: false },
    });
    expect(normalizeQuotaHistory({}).firstRecordedAt).toBeNull();
  });

  test('requests go through the management client with snake_case bodies', async () => {
    const get = track(spyOn(apiClient, 'get').mockResolvedValue({ snapshots: {} }));
    const post = track(spyOn(apiClient, 'post').mockResolvedValue({ snapshots: {} }));

    await quotaSnapshotsApi.getSnapshots('codex');
    expect(get).toHaveBeenLastCalledWith(QUOTA_SNAPSHOTS_PATH, { params: { provider: 'codex' } });

    await quotaSnapshotsApi.refresh(['a', 'b'], { force: true });
    expect(post.mock.calls[0][0]).toBe(QUOTA_REFRESH_PATH);
    expect(post.mock.calls[0][1]).toEqual({ auth_indexes: ['a', 'b'], force: true });

    await quotaSnapshotsApi.refresh();
    expect(post.mock.calls[1][1]).toEqual({});

    await quotaSnapshotsApi.getHistory({
      provider: 'claude',
      window: 'weekly',
      from: 10.7,
      to: 99,
    });
    expect(get).toHaveBeenLastCalledWith(QUOTA_HISTORY_PATH, {
      params: { provider: 'claude', window: 'weekly', from: 10, to: 99 },
    });
  });
});

describe('Claude adapter from a snapshot bundle', () => {
  test('builds windows, plan and the proxy fetch time', () => {
    const data = buildClaudeQuotaFromSnapshot(claudeSnapshot(), t);
    expect(data.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['five-hour', 12],
      ['seven-day', 40],
    ]);
    expect(data.planType).toBe('plan_max');
    const state = QUOTA_ADAPTERS.claude.buildSuccessState(data);
    expect(state.fetchedAtMs).toBe(FETCHED_MS);
  });

  test('a failed profile never fails the snapshot', () => {
    const data = buildClaudeQuotaFromSnapshot(
      claudeSnapshot({
        responses: {
          usage: { status_code: 200, body: JSON.stringify(CLAUDE_USAGE) },
          profile: { status_code: 500, body: 'oops' },
        },
      }),
      t
    );
    expect(data.windows).toHaveLength(2);
    expect(data.planType).toBeNull();
  });

  test('a newer rate-limited attempt keeps the last good data', () => {
    const data = buildClaudeQuotaFromSnapshot(
      claudeSnapshot({
        attempted_at: '2026-10-26T10:30:00Z',
        error: 'HTTP 429',
        error_status: 429,
      }),
      t
    );
    expect(data.windows).toHaveLength(2);
  });

  test('a newer authentication failure is shown even with stale data', () => {
    expect(() =>
      buildClaudeQuotaFromSnapshot(
        claudeSnapshot({
          attempted_at: '2026-10-26T10:30:00Z',
          error: 'token revoked',
          error_status: 401,
        }),
        t
      )
    ).toThrow('token revoked');
  });

  test('an error older than the last success is history, not state', () => {
    const data = buildClaudeQuotaFromSnapshot(
      claudeSnapshot({ attempted_at: FETCHED, error: 'token revoked', error_status: 401 }),
      t
    );
    expect(data.windows).toHaveLength(2);
  });

  test('a failure with no saved usage throws with its status', () => {
    let thrown: unknown;
    try {
      buildClaudeQuotaFromSnapshot(
        claudeSnapshot({ fetched_at: null, responses: {}, error: 'HTTP 503', error_status: 503 }),
        t
      );
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe('HTTP 503');
    expect((thrown as { status?: number }).status).toBe(503);
  });

  test('fetchQuota asks the proxy for that one credential', async () => {
    const refresh = track(
      spyOn(quotaSnapshotsApi, 'refresh').mockResolvedValue({
        pollIntervalSeconds: 3600,
        snapshots: { 'claude:1': claudeSnapshot() },
      })
    );
    const data = await CLAUDE_CONFIG.fetchQuota(
      { name: 'claude.json', type: 'claude', auth_index: 'claude:1' },
      t
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(['claude:1'], {});
    expect(data.windows).toHaveLength(2);
  });
});

const claudeFile: AuthFileItem = { name: 'claude.json', type: 'claude', auth_index: 'claude:1' };
const codexFile: AuthFileItem = { name: 'codex.json', type: 'codex', auth_index: 'codex:2' };
const codexSnapshot = normalizeSnapshot({
  auth_index: 'codex:2',
  provider: 'codex',
  fetched_at: FETCHED,
  attempted_at: FETCHED,
  responses: {
    usage: {
      status_code: 200,
      body: {
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1793000000 },
        },
      },
    },
  },
});
const bothSnapshots: QuotaSnapshotSet = {
  pollIntervalSeconds: 3600,
  snapshots: { 'claude:1': claudeSnapshot(), 'codex:2': codexSnapshot },
};

describe('batched refresh', () => {
  test('one proxy request covers every Claude and Codex credential', async () => {
    const refresh = track(spyOn(quotaSnapshotsApi, 'refresh').mockResolvedValue(bothSnapshots));
    const claude = { type: 'claude' as const, file: claudeFile };
    const codex = { type: 'codex' as const, file: codexFile };
    const missing = { type: 'codex' as const, file: { name: 'gone.json', type: 'codex' } };

    const results = await refreshProxyQuotaEntries([claude, codex, missing], t);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toEqual(['claude:1', 'codex:2']);
    expect(results.get(claude)?.status).toBe('success');
    const codexResult = results.get(codex);
    expect(codexResult?.status).toBe('success');
    if (codexResult?.status === 'success') {
      const state = CODEX_CONFIG.buildSuccessState(codexResult.data as never);
      expect(state.planType).toBe('pro');
      expect(state.windows[0]?.usedPercent).toBe(30);
    }
    expect(results.get(missing)).toEqual({
      status: 'error',
      error: 'codex_quota.missing_auth_index',
    });
  });

  test('a transport failure fails every entry with its status', async () => {
    const failure = Object.assign(new Error('Service Unavailable'), { status: 503 });
    track(spyOn(quotaSnapshotsApi, 'refresh').mockRejectedValue(failure));
    const entry = { type: 'claude' as const, file: claudeFile };
    const results = await refreshProxyQuotaEntries([entry], t);
    expect(results.get(entry)).toEqual({
      status: 'error',
      error: 'Service Unavailable',
      errorStatus: 503,
    });
  });
});

describe('hydration from stored snapshots', () => {
  test('fills idle rows from GET /quota/snapshots without any upstream call', async () => {
    const getSnapshots = track(
      spyOn(quotaSnapshotsApi, 'getSnapshots').mockResolvedValue(bothSnapshots)
    );
    const refresh = track(spyOn(quotaSnapshotsApi, 'refresh'));
    await hydrateProxyQuota([claudeFile, codexFile, { name: 'kimi.json', type: 'kimi' }], t);

    expect(getSnapshots).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    const state = useQuotaStore.getState();
    expect(state.claudeQuota['claude.json']?.status).toBe('success');
    expect(state.claudeQuota['claude.json']?.fetchedAtMs).toBe(FETCHED_MS);
    expect(state.codexQuota['codex.json']?.status).toBe('success');
  });

  test('concurrent callers share one snapshot read', async () => {
    const getSnapshots = track(
      spyOn(quotaSnapshotsApi, 'getSnapshots').mockResolvedValue(bothSnapshots)
    );
    await Promise.all([hydrateProxyQuota([claudeFile], t), hydrateProxyQuota([codexFile], t)]);
    expect(getSnapshots).toHaveBeenCalledTimes(1);
  });

  test('never replaces an in-flight load or newer data', () => {
    const next = { status: 'success' as const, fetchedAtMs: 2000 };
    expect(shouldHydrate(undefined, next, 2000)).toBeTrue();
    expect(shouldHydrate({ status: 'idle' }, next, 2000)).toBeTrue();
    expect(shouldHydrate({ status: 'loading' }, next, 2000)).toBeFalse();
    expect(shouldHydrate({ status: 'success', fetchedAtMs: 2000 }, next, 2000)).toBeFalse();
    expect(shouldHydrate({ status: 'success', fetchedAtMs: 1000 }, next, 2000)).toBeTrue();
    const failed = { status: 'error' as const, error: 'x', errorStatus: 401 };
    expect(shouldHydrate({ status: 'success', fetchedAtMs: 1000 }, failed, 1500)).toBeTrue();
    expect(shouldHydrate({ ...failed }, failed, 1500)).toBeFalse();
  });

  test('skips snapshots that hold nothing yet and tolerates a missing endpoint', async () => {
    track(
      spyOn(quotaSnapshotsApi, 'getSnapshots').mockResolvedValue({
        pollIntervalSeconds: 3600,
        snapshots: { 'claude:1': normalizeSnapshot({ auth_index: 'claude:1' }) },
      })
    );
    await hydrateProxyQuota([claudeFile], t);
    expect(useQuotaStore.getState().claudeQuota['claude.json']).toBeUndefined();

    mocks.splice(-1)[0].mockRestore();
    track(
      spyOn(quotaSnapshotsApi, 'getSnapshots').mockRejectedValue(
        Object.assign(new Error('Not Found'), { status: 404 })
      )
    );
    await hydrateProxyQuota([claudeFile], t);
    expect(useQuotaStore.getState().claudeQuota['claude.json']).toBeUndefined();
  });
});
