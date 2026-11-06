import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import type { RecentRequestBucket, RecentRequestUsageEntry } from '@/utils/recentRequests';
import {
  buildCredentialRows,
  countCredentials,
  lastUsedBucketsAgo,
  lifetimeTotal,
  recentErrorLines,
  resolveCredentialStatus,
  sortCredentialRows,
  sumBuckets,
  summarizeTraffic,
  type CredentialRow,
} from '@/features/dashboard/model';

const NOW = 1_791_490_000_000;
const sec = (ms: number) => String(Math.floor(ms / 1000));

/** 20 buckets, oldest first; `values[i]` = [success, failed] placed at the tail. */
const buckets = (...values: Array<[number, number]>): RecentRequestBucket[] => {
  const out: RecentRequestBucket[] = Array.from({ length: 20 }, () => ({ success: 0, failed: 0 }));
  values.forEach(([success, failed], index) => {
    out[20 - values.length + index] = { success, failed };
  });
  return out;
};

const file = (extra: Partial<AuthFileItem> & Record<string, unknown>): AuthFileItem =>
  ({ name: 'cred.json', type: 'codex', ...extra }) as AuthFileItem;

const noUsage = new Map<string, Map<string, RecentRequestUsageEntry>>();

describe('window sums', () => {
  test('the last hour is the newest six buckets; the window is all twenty', () => {
    const series = buckets([5, 0], [1, 1], [0, 0], [2, 0], [3, 1], [1, 0], [4, 2]);
    expect(sumBuckets(series)).toEqual({ success: 16, failure: 4, total: 20 });
    expect(sumBuckets(series, 6)).toEqual({ success: 11, failure: 4, total: 15 });
    expect(sumBuckets(series, 0)).toEqual({ success: 0, failure: 0, total: 0 });
  });

  test('summarizeTraffic merges credentials and reports peak and the current bucket', () => {
    const traffic = summarizeTraffic([buckets([3, 0], [1, 1]), buckets([0, 0], [2, 0])]);
    expect(traffic.window).toEqual({ success: 6, failure: 1, total: 7 });
    expect(traffic.peak).toBe(4);
    expect(traffic.current).toBe(4);
    expect(traffic.windowMinutes).toBe(200);
    expect(traffic.successRate).toBeCloseTo((6 / 7) * 100);
  });

  test('an empty window has no success rate rather than 100%', () => {
    expect(summarizeTraffic([buckets()]).successRate).toBeNull();
    expect(summarizeTraffic([]).buckets).toEqual([]);
  });

  test('lifetime counters are never mixed into window totals', () => {
    const rows = buildCredentialRows(
      [file({ successCount: 900, failureCount: 100, recentRequests: buckets([2, 1]) })],
      noUsage,
      NOW
    );
    expect(rows[0].window.total).toBe(3);
    expect(lifetimeTotal(rows)).toBe(1000);
    expect(summarizeTraffic(rows.map((row) => row.buckets)).window.total).toBe(3);
  });
});

describe('last used', () => {
  test('counts buckets back to the newest non-empty one', () => {
    expect(lastUsedBucketsAgo(buckets([1, 0]))).toBe(0);
    expect(lastUsedBucketsAgo(buckets([0, 1], [0, 0], [0, 0]))).toBe(2);
    expect(lastUsedBucketsAgo(buckets())).toBeNull();
  });
});

describe('credential status', () => {
  test('a healthy credential has an empty status cell', () => {
    expect(resolveCredentialStatus(file({ status: 'active' }), [], NOW)).toEqual({ kind: 'ok' });
    expect(
      resolveCredentialStatus(file({ statusMessage: 'ok', status: 'active' }), [], NOW)
    ).toEqual({ kind: 'ok' });
  });

  test('disabled wins over everything', () => {
    expect(resolveCredentialStatus(file({ disabled: true, unavailable: true }), [], NOW)).toEqual({
      kind: 'disabled',
    });
  });

  test('an exhausted passive window reports when it is back', () => {
    const exhausted = file({
      type: 'claude',
      quota: {
        signals: {
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': sec(NOW + 3_600_000),
          'anthropic-ratelimit-unified-7d-utilization': '0.5',
          'anthropic-ratelimit-unified-7d-reset': sec(NOW + 86_400_000),
        },
      },
    });
    const [row] = buildCredentialRows([exhausted], noUsage, NOW);
    expect(row.status).toEqual({ kind: 'exhausted', backAtMs: NOW + 3_600_000 });
    expect(row.fiveHour?.remaining).toBe(0);
    expect(row.weekly?.remaining).toBe(50);
  });

  test('a window whose reset has passed rolls over instead of staying exhausted', () => {
    const rolled = file({
      type: 'codex',
      quota: {
        signals: {
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': sec(NOW - 60_000),
        },
      },
    });
    const [row] = buildCredentialRows([rolled], noUsage, NOW);
    expect(row.status).toEqual({ kind: 'ok' });
    expect(row.fiveHour?.remaining).toBe(100);
  });

  test('an active credential-wide cooldown shows its remaining time', () => {
    const cooling = file({
      unavailable: true,
      statusMessage: 'quota exhausted',
      cooldownSnapshot: {
        receivedAtMs: NOW - 10_000,
        records: [
          {
            scope: 'model',
            modelKey: 'gpt-5',
            reason: 'quota',
            retryAt: '',
            remainingSeconds: 30,
          },
          {
            scope: 'credential',
            reason: 'unauthorized',
            retryAt: '',
            remainingSeconds: 120,
            httpStatus: 401,
          },
        ],
      },
    });
    expect(resolveCredentialStatus(cooling, [], NOW)).toEqual({
      kind: 'cooldown',
      seconds: 110,
      credentialWide: true,
      models: 1,
    });
  });

  test('an elapsed cooldown falls through to the reported error', () => {
    const failing = file({
      unavailable: true,
      statusMessage: 'upstream rejected',
      cooldownSnapshot: {
        receivedAtMs: NOW - 120_000,
        records: [
          {
            scope: 'credential',
            reason: 'unauthorized',
            retryAt: '',
            remainingSeconds: 60,
            httpStatus: 401,
          },
        ],
      },
    });
    expect(resolveCredentialStatus(failing, [], NOW)).toEqual({
      kind: 'error',
      message: 'upstream rejected',
      httpStatus: 401,
    });
  });
});

describe('rows', () => {
  const row = (name: string, total: number, kind: CredentialRow['status']['kind']): CredentialRow =>
    ({
      key: name,
      name,
      window: { success: total, failure: 0, total },
      status:
        kind === 'exhausted'
          ? { kind, backAtMs: null }
          : kind === 'error'
            ? { kind, message: 'x' }
            : { kind },
    }) as CredentialRow;

  test('problems first, then by volume, disabled last', () => {
    const sorted = sortCredentialRows([
      row('busy', 50, 'ok'),
      row('off', 99, 'disabled'),
      row('quiet', 1, 'ok'),
      row('broken', 0, 'error'),
      row('empty', 5, 'exhausted'),
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['empty', 'broken', 'busy', 'quiet', 'off']);
  });

  test('api-key usage adds config keys, skips keys already listed, and masks the key', () => {
    const usage = new Map([
      [
        'gemini',
        new Map<string, RecentRequestUsageEntry>([
          [
            'https://example.test/v1|sk-config-secret-1234',
            { success: 4, failed: 1, recentRequests: buckets([4, 1]) },
          ],
          ['|sk-listed-secret-9999', { success: 7, failed: 0, recentRequests: buckets([7, 0]) }],
        ]),
      ],
    ]);
    const listed = file({
      name: 'runtime-key',
      type: 'gemini',
      account_type: 'api_key',
      account: 'sk-listed-secret-9999',
      recentRequests: buckets([7, 0]),
    });
    const rows = buildCredentialRows([listed], usage, NOW);
    expect(rows).toHaveLength(2);
    const keyRow = rows.find((entry) => entry.source === 'api-key')!;
    expect(keyRow.name).not.toContain('config-secret');
    expect(keyRow.name).toContain('example.test');
    expect(keyRow.window.total).toBe(5);
    expect(summarizeTraffic(rows.map((entry) => entry.buckets)).window.total).toBe(12);
    expect(countCredentials(rows)).toEqual({ total: 2, usable: 2 });
  });
});

describe('recent errors', () => {
  const prefix = (time: string) => `[2026-06-08 ${time}] [a1b2c3d4] [info ] [gin_logger.go:110]`;

  test('keeps request lines with status >= 400, newest first, without query strings', () => {
    const lines = [
      `${prefix('12:00:00')} 200 | 12ms | 127.0.0.1 | POST "/v1/messages"`,
      `${prefix('12:00:01')} 429 | 1.2s | 127.0.0.1 | POST "/v1/messages"`,
      `${prefix('12:00:02')} 500 | 3ms | 127.0.0.1 | POST "/v1beta/models/x:generateContent?key=AIzaSECRET"`,
      `${prefix('12:00:03')} 401 | 1ms | 127.0.0.1 | GET "/v8/management/credentials"`,
      `${prefix('12:00:04')} 404 | 0s | 127.0.0.1 | HEAD "/api/hello"`,
      '[2026-06-08 12:00:04] [--------] [error] status: 500 while refreshing token',
    ];
    const entries = recentErrorLines(lines, 8);
    expect(entries.map((entry) => [entry.time, entry.status, entry.method, entry.path])).toEqual([
      ['12:00:02', 500, 'POST', '/v1beta/models/x:generateContent'],
      ['12:00:01', 429, 'POST', '/v1/messages'],
    ]);
    expect(entries[1].latency).toBe('1.2s');
  });

  test('caps the list', () => {
    const lines = Array.from(
      { length: 20 },
      (_, index) =>
        `${prefix(`12:00:${String(index).padStart(2, '0')}`)} 502 | 1ms | 127.0.0.1 | GET "/v1/models"`
    );
    const entries = recentErrorLines(lines, 8);
    expect(entries).toHaveLength(8);
    expect(entries[0].time).toBe('12:00:19');
  });
});
