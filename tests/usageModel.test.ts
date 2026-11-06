import { describe, expect, test } from 'bun:test';
import type { UsageSummaryRow } from '@/services/api/usage';
import { normalizeUsageSummary } from '@/services/api/usage';
import type { AuthFileItem } from '@/types';
import {
  DAY_SECONDS,
  HOUR_SECONDS,
  MAX_BUCKETS,
  alignBucketStart,
  bucketGrid,
  chartScaleMax,
  costState,
  fillBuckets,
  formatUsd,
  groupByAccount,
  groupByModel,
  groupByProvider,
  liveAccountNames,
  priceRows,
  rangeQuery,
  resolveAccountName,
  sortGroups,
  sumRows,
} from '@/features/usage/model';
import { DEFAULT_PRICES } from '@/features/usage/pricing';

/** 2026-10-11 12:34:56 UTC. */
const NOW_MS = Date.UTC(2026, 9, 11, 12, 34, 56);
const NOW = Math.floor(NOW_MS / 1000);
const HOUR_START = Date.UTC(2026, 9, 11, 12) / 1000;
const IST = 330;

const r = (extra: Partial<UsageSummaryRow>): UsageSummaryRow => ({
  start: HOUR_START,
  provider: 'claude',
  authIndex: 'a1',
  model: 'claude-opus-5-5',
  promptTier: 0,
  requests: 1,
  failed: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  unclassifiedTokens: 0,
  ...extra,
});

describe('ranges', () => {
  test('24h = 24 hour buckets ending with the current hour', () => {
    const query = rangeQuery('24h', NOW_MS, IST);
    expect(query.bucket).toBe('hour');
    expect(query.to).toBe(HOUR_START + HOUR_SECONDS);
    expect(query.from).toBe(HOUR_START - 23 * HOUR_SECONDS);
    expect(bucketGrid(query, null).starts).toHaveLength(24);
  });

  test('day ranges start at local midnight in the given offset', () => {
    // 12:34 UTC = 18:04 IST, so today (IST) began at 18:30 UTC the day before.
    const todayIst = Date.UTC(2026, 9, 10, 18, 30) / 1000;
    expect(alignBucketStart(NOW, 'day', IST)).toBe(todayIst);
    const week = rangeQuery('7d', NOW_MS, IST);
    expect(week.bucket).toBe('day');
    expect(week.tzOffsetMinutes).toBe(IST);
    expect(week.to).toBe(todayIst + DAY_SECONDS);
    expect(week.from).toBe(todayIst - 6 * DAY_SECONDS);
    expect(bucketGrid(week, null).starts).toHaveLength(7);
    expect(bucketGrid(rangeQuery('90d', NOW_MS, 0), null).starts).toHaveLength(90);
  });

  test('negative offsets align to the local midnight too', () => {
    // UTC-7: 12:34 UTC is 05:34 local; local midnight was 07:00 UTC.
    expect(alignBucketStart(NOW, 'day', -420)).toBe(Date.UTC(2026, 9, 11, 7) / 1000);
  });

  test('"All" queries from 0 and starts the grid at the first recorded bucket', () => {
    const query = rangeQuery('all', NOW_MS, 0);
    expect(query.from).toBe(0);
    expect(bucketGrid(query, null).starts).toEqual([]);
    const first = Date.UTC(2026, 9, 9, 15) / 1000;
    const { starts } = bucketGrid(query, first);
    expect(starts[0]).toBe(Date.UTC(2026, 9, 9) / 1000);
    expect(starts).toHaveLength(3);
  });

  test('the grid is capped, keeping the newest buckets', () => {
    const query = rangeQuery('all', NOW_MS, 0);
    const { starts } = bucketGrid(query, NOW - 10 * 365 * DAY_SECONDS);
    expect(starts).toHaveLength(MAX_BUCKETS);
    expect(starts[starts.length - 1]).toBe(alignBucketStart(NOW, 'day', 0));
  });
});

describe('bucket filling', () => {
  test('rows land in their bucket and empty buckets stay as zeros', () => {
    const query = rangeQuery('24h', NOW_MS, 0);
    const rows = priceRows(
      [
        r({ start: HOUR_START, inputTokens: 100 }),
        r({ start: HOUR_START, model: 'gpt-5', provider: 'codex', outputTokens: 50 }),
        r({ start: HOUR_START - 3 * HOUR_SECONDS, cacheReadTokens: 10 }),
      ],
      DEFAULT_PRICES
    );
    const buckets = fillBuckets(rows, query, null);
    expect(buckets).toHaveLength(24);
    expect(buckets[23].start).toBe(HOUR_START);
    expect(buckets[23].totals.total).toBe(150);
    expect(buckets[23].totals.requests).toBe(2);
    expect(buckets[20].totals.total).toBe(10);
    expect(buckets[0].totals.total).toBe(0);
    expect(buckets.filter((bucket) => bucket.totals.total > 0)).toHaveLength(2);
  });

  test('rows outside the grid are ignored', () => {
    const query = rangeQuery('24h', NOW_MS, 0);
    const rows = priceRows(
      [r({ start: HOUR_START - 30 * HOUR_SECONDS, inputTokens: 5 })],
      DEFAULT_PRICES
    );
    const buckets = fillBuckets(rows, query, null);
    expect(buckets.reduce((sum, bucket) => sum + bucket.totals.total, 0)).toBe(0);
  });

  test('"All" spans from the earliest of first_recorded_at and the first row', () => {
    const query = rangeQuery('all', NOW_MS, 0);
    const rows = priceRows([r({ start: alignBucketStart(NOW, 'day', 0) })], DEFAULT_PRICES);
    const recorded = NOW - 4 * DAY_SECONDS;
    expect(fillBuckets(rows, query, recorded)).toHaveLength(5);
    expect(fillBuckets(rows, query, null)).toHaveLength(1);
  });
});

describe('totals and cost state', () => {
  test('total tokens exclude reasoning (already inside output)', () => {
    const totals = sumRows(
      priceRows(
        [
          r({
            inputTokens: 1,
            cacheReadTokens: 2,
            cacheWriteTokens: 3,
            outputTokens: 10,
            reasoningTokens: 7,
            unclassifiedTokens: 4,
            requests: 3,
            failed: 1,
          }),
        ],
        DEFAULT_PRICES
      )
    );
    expect(totals.total).toBe(20);
    expect(totals.reasoning).toBe(7);
    expect(totals.requests).toBe(3);
    expect(totals.failed).toBe(1);
  });

  test('unpriced tokens never count as $0: partial and none states', () => {
    const priced = r({ inputTokens: 1_000_000 });
    const unpriced = r({ model: 'gpt-oss-120b', provider: 'codex', inputTokens: 500 });
    const mixed = sumRows(priceRows([priced, unpriced], DEFAULT_PRICES));
    expect(mixed.cost).toBeCloseTo(4, 10);
    expect(mixed.unpricedTokens).toBe(500);
    expect(costState(mixed)).toBe('partial');

    const none = sumRows(priceRows([unpriced], DEFAULT_PRICES));
    expect(none.cost).toBe(0);
    expect(costState(none)).toBe('none');

    expect(costState(sumRows(priceRows([priced], DEFAULT_PRICES)))).toBe('full');
  });

  test('a failed-only unpriced row (no tokens) does not make cost partial', () => {
    const totals = sumRows(
      priceRows(
        [r({ inputTokens: 10 }), r({ model: 'gpt-oss-120b', requests: 1, failed: 1 })],
        DEFAULT_PRICES
      )
    );
    expect(costState(totals)).toBe('full');
  });

  test('long-context tiers price separately within one model', () => {
    const rows = priceRows(
      [
        r({ model: 'claude-haiku-5-5', promptTier: 0, inputTokens: 1_000_000 }),
        r({ model: 'claude-haiku-5-5', promptTier: 1, inputTokens: 1_000_000 }),
      ],
      DEFAULT_PRICES
    );
    expect(rows[0].cost).toBeCloseTo(0.1, 10);
    expect(rows[1].cost).toBeCloseTo(0.5, 10);
    const [model] = groupByModel(rows);
    expect(model.totals.cost).toBeCloseTo(0.6, 10);
    expect(model.priceKey).toBe('claude-haiku-5-5');
  });
});

describe('grouping and sorting', () => {
  const rows = priceRows(
    [
      r({ provider: 'claude', authIndex: 'a1', inputTokens: 1_000_000 }), // $4
      r({ provider: 'claude', authIndex: 'a2', outputTokens: 1_000_000 }), // $20
      r({ provider: 'codex', authIndex: 'c1', model: 'gpt-5', outputTokens: 100_000 }), // $1
      r({ provider: 'codex', authIndex: 'c1', model: 'gpt-oss-120b', inputTokens: 9_000_000 }),
    ],
    DEFAULT_PRICES
  );

  test('by provider, cost descending by default', () => {
    const groups = sortGroups(groupByProvider(rows), { key: 'cost', dir: 'desc' });
    expect(groups.map((group) => group.provider)).toEqual(['claude', 'codex']);
    expect(groups[0].totals.cost).toBeCloseTo(24, 10);
    expect(costState(groups[1].totals)).toBe('partial');
  });

  test('by account nests accounts under providers, both sorted', () => {
    const groups = groupByAccount(rows, { key: 'cost', dir: 'desc' });
    expect(groups.map((group) => group.provider)).toEqual(['claude', 'codex']);
    expect(groups[0].accounts.map((account) => account.authIndex)).toEqual(['a2', 'a1']);
    expect(groups[1].accounts).toHaveLength(1);
    expect(groups[1].accounts[0].totals.total).toBe(9_100_000);
  });

  test('fully unpriced groups sort below priced ones on cost, either direction last on desc', () => {
    const models = sortGroups(groupByModel(rows), { key: 'cost', dir: 'desc' });
    expect(models[models.length - 1].model).toBe('gpt-oss-120b');
    expect(models[models.length - 1].priceKey).toBeNull();
    const ascending = sortGroups(groupByModel(rows), { key: 'cost', dir: 'asc' });
    expect(ascending[0].model).toBe('gpt-oss-120b');
  });

  test('other columns sort numerically; ties fall back to total tokens', () => {
    const byTotal = sortGroups(groupByModel(rows), { key: 'total', dir: 'desc' });
    expect(byTotal[0].model).toBe('gpt-oss-120b');
    const byRequests = sortGroups(groupByModel(rows), { key: 'requests', dir: 'asc' });
    // gpt-5 and gpt-oss both have 1 request; the larger total comes first.
    expect(byRequests.slice(0, 2).map((group) => group.model)).toEqual(['gpt-oss-120b', 'gpt-5']);
  });
});

describe('account names', () => {
  const files = [
    { name: 'claude-x.json', type: 'claude', email: 'live@example.com', authIndex: 'a1' },
    { name: 'codex-key.json', type: 'codex', account: 'sk-secret', auth_index: 'c1' },
  ] as unknown as AuthFileItem[];
  const live = liveAccountNames(files);

  test('live credentials first, never the account field', () => {
    expect(resolveAccountName('a1', live, {})).toEqual({ name: 'live@example.com', mono: false });
    const codex = resolveAccountName('c1', live, {});
    expect(codex).toEqual({ name: 'codex-key', mono: true });
    expect(JSON.stringify([...live.values()])).not.toContain('sk-secret');
  });

  test('then the recorded label, then a short masked index', () => {
    const recorded = { gone: { provider: 'claude', label: 'old@example.com' } };
    expect(resolveAccountName('gone', live, recorded)).toEqual({
      name: 'old@example.com',
      mono: false,
    });
    expect(resolveAccountName('0123456789abcdef', live, {})).toEqual({
      name: '#012345…',
      mono: true,
    });
    expect(resolveAccountName('', live, {})).toBeNull();
  });
});

describe('formatting and axis', () => {
  test('USD keeps cents while they matter', () => {
    expect(formatUsd(0, 'en')).toBe('$0');
    expect(formatUsd(0.004, 'en')).toBe('<$0.01');
    expect(formatUsd(12.345, 'en')).toBe('$12.35');
    expect(formatUsd(1234.5, 'en')).toBe('$1,235');
  });

  test('cost axis allows fractional steps; token axis stays integral', () => {
    expect(chartScaleMax(0.3, 3, false)).toBeCloseTo(0.3, 10);
    expect(chartScaleMax(0.31, 3, false)).toBeCloseTo(0.45, 10);
    expect(chartScaleMax(5, 3, true)).toBe(6);
    expect(chartScaleMax(0, 3, true)).toBe(3);
  });
});

describe('summary normalisation', () => {
  test('maps the snake_case contract and tolerates junk', () => {
    const summary = normalizeUsageSummary({
      from: 1760000000,
      to: 1760086400,
      bucket: 'day',
      tz_offset_minutes: 330,
      first_recorded_at: 1760000000,
      rows: [
        {
          start: 1760003600,
          provider: 'Claude',
          auth_index: 'a1b2',
          model: 'claude-opus-5-5',
          prompt_tier: 2,
          requests: 12,
          failed: 1,
          input_tokens: 1000,
          cache_read_tokens: 50000,
          cache_write_tokens: 4000,
          output_tokens: 3000,
          reasoning_tokens: 800,
          unclassified_tokens: 0,
        },
        { start: 1760000000, provider: 'codex', model: '', prompt_tier: 9 },
        'junk',
        { provider: 'no-start' },
      ],
      accounts: { a1b2: { provider: 'claude', label: 'user@example.com' }, bad: 3 },
    });
    expect(summary.bucket).toBe('day');
    expect(summary.tzOffsetMinutes).toBe(330);
    expect(summary.firstRecordedAt).toBe(1760000000);
    expect(summary.rows.map((row) => row.start)).toEqual([1760000000, 1760003600]);
    expect(summary.rows[0]).toMatchObject({ model: 'unknown', promptTier: 2, authIndex: '' });
    expect(summary.rows[1]).toMatchObject({
      provider: 'claude',
      authIndex: 'a1b2',
      promptTier: 2,
      cacheReadTokens: 50000,
      reasoningTokens: 800,
    });
    expect(summary.accounts).toEqual({ a1b2: { provider: 'claude', label: 'user@example.com' } });
  });

  test('empty store reads as nothing recorded', () => {
    const summary = normalizeUsageSummary({ rows: [], first_recorded_at: 0, accounts: {} });
    expect(summary.firstRecordedAt).toBeNull();
    expect(summary.rows).toEqual([]);
    expect(summary.bucket).toBe('hour');
  });
});
