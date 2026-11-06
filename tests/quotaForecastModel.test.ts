import { describe, expect, test } from 'bun:test';
import type { QuotaHistoryAccount, QuotaHistorySample } from '@/services/api/quotaSnapshots';
import {
  DAY,
  HOUR,
  MINUTE,
  buildQuotaForecast,
  drainEvents,
  enabledAccounts,
  formatNextReset,
  remainingAt,
  type ForecastInput,
} from '@/features/quota/quotaForecastModel';

const NOW = 1_800_000_000;
const sample = (authIndex: string, t: number, used: number, resetsAt = 0): QuotaHistorySample => ({
  t,
  authIndex,
  used,
  resetsAt,
});
const account = (
  priority = 0,
  disabled = false,
  label = 'user@example.com'
): QuotaHistoryAccount => ({
  label,
  priority,
  disabled,
});

const forecast = (overrides: Partial<ForecastInput>) =>
  buildQuotaForecast({
    window: 'weekly',
    samples: [],
    accounts: {},
    now: NOW,
    horizon: DAY,
    lookback: DAY,
    ...overrides,
  });

const pointAt = (points: { t: number }[], t: number) => points.filter((point) => point.t === t);

describe('remaining series', () => {
  const series = [
    sample('a', NOW - 3 * HOUR, 20, NOW - HOUR),
    sample('a', NOW - 2 * HOUR, 50, NOW - HOUR),
  ];

  test('uses the latest sample at or before t and returns to 100 after its reset', () => {
    expect(remainingAt(series, NOW - 4 * HOUR)).toBeNull();
    expect(remainingAt(series, NOW - 3 * HOUR)).toBe(80);
    expect(remainingAt(series, NOW - 90 * MINUTE)).toBe(50);
    expect(remainingAt(series, NOW - HOUR)).toBe(100);
    expect(remainingAt(series, NOW)).toBe(100);
  });

  test('past grid spans a quarter of the horizon and ends at now, with the reset visible', () => {
    const result = forecast({ samples: series, accounts: { a: account() }, horizon: DAY });
    expect(result.start).toBe(NOW - 6 * HOUR);
    expect(result.past[0].t).toBe(NOW - 6 * HOUR);
    expect(result.past[1].t - result.past[0].t).toBe(30 * MINUTE);
    expect(result.past[result.past.length - 1].t).toBe(NOW);
    expect(pointAt(result.past, NOW - 2 * HOUR)[0].total).toBe(50);
    expect(pointAt(result.past, NOW - HOUR)[0].total).toBe(100);
    expect(result.past[0].total).toBeNull();
    expect(result.current).toBe(100);
  });

  test('accounts without samples count towards the max only; disabled accounts not at all', () => {
    const result = forecast({
      samples: [sample('a', NOW - HOUR, 40), sample('off', NOW - HOUR, 0)],
      accounts: { a: account(), empty: account(), off: account(0, true) },
    });
    expect(result.max).toBe(200);
    expect(result.current).toBe(60);
    expect(result.accounts.map((entry) => entry.authIndex).sort()).toEqual(['a', 'empty']);
    expect(Object.keys(result.past[result.past.length - 1].byAccount)).toEqual(['a']);
  });

  test('unpolled API-key credentials (no label, no samples) do not count towards the max', () => {
    const result = forecast({
      samples: [sample('oauth', NOW - HOUR, 40), sample('unlabelled', NOW - HOUR, 0)],
      accounts: {
        oauth: account(),
        unlabelled: account(0, false, ''),
        apiKey: account(0, false, ''),
      },
    });
    expect(result.max).toBe(200);
    expect(result.accounts.map((entry) => entry.authIndex).sort()).toEqual(['oauth', 'unlabelled']);
  });

  test('a sample from before the requested range anchors the left edge', () => {
    const result = forecast({
      samples: [sample('a', NOW - 3 * DAY, 35, NOW + DAY)],
      accounts: { a: account() },
    });
    expect(result.past[0].total).toBe(65);
    expect(result.current).toBe(65);
  });

  test('an empty history has no data', () => {
    const result = forecast({ accounts: { a: account() } });
    expect(result.hasData).toBeFalse();
    expect(result.current).toBeNull();
    expect(result.max).toBe(100);
  });

  test('orders accounts by priority, highest first', () => {
    expect(
      enabledAccounts({ low: account(0), high: account(5), mid: account(2) }, []).map(
        (entry) => entry.authIndex
      )
    ).toEqual(['high', 'mid', 'low']);
  });
});

describe('drain', () => {
  test('counts positive drops only, never across a reset', () => {
    const events = drainEvents('a', [
      sample('a', NOW - 4 * HOUR, 70, NOW - 3 * HOUR),
      // Reset happened between these two: the apparent change is not drain.
      sample('a', NOW - 2 * HOUR, 10, NOW + 2 * HOUR),
      sample('a', NOW - HOUR, 30, NOW + 2 * HOUR),
      // A manual reset lowers usage: not drain either.
      sample('a', NOW, 5, NOW + 2 * HOUR),
    ]);
    expect(events).toEqual([{ authIndex: 'a', from: NOW - 2 * HOUR, to: NOW - HOUR, amount: 20 }]);
  });

  test('headline rate is the drop in the lookback over the observed hours', () => {
    const samples = [
      sample('a', NOW - 10 * HOUR, 0),
      sample('a', NOW - 5 * HOUR, 25),
      sample('b', NOW - 10 * HOUR, 0),
      sample('b', NOW, 25),
    ];
    const accounts = { a: account(), b: account() };
    // 50 points over the 10 observed hours, not over the full 24 h lookback.
    expect(forecast({ samples, accounts, lookback: DAY }).ratePerHour).toBeCloseTo(5);
    // A 6 h lookback sees the last hour of a's 5 h drop (5) and 6 of b's 10 h (15).
    expect(forecast({ samples, accounts, lookback: 6 * HOUR }).ratePerHour).toBeCloseTo(20 / 6);
  });

  test('drain bars cover the past span in hourly buckets for the weekly window', () => {
    const result = forecast({
      samples: [sample('a', NOW - 2 * HOUR, 0), sample('a', NOW - HOUR, 6)],
      accounts: { a: account() },
      horizon: DAY,
    });
    expect(result.drainBars).toHaveLength(6);
    expect(result.drainBars.every((bar) => bar.end - bar.start === HOUR)).toBeTrue();
    const busy = result.drainBars.find((bar) => bar.start === NOW - 2 * HOUR);
    expect(busy?.ratePerHour).toBeCloseTo(6);
    // Recording began 2 h ago: the average is over those 2 h, not the 6 h span.
    expect(result.drainAverage).toBeCloseTo(3);
  });

  test('the 5-hour window uses 15-minute drain buckets', () => {
    const result = forecast({
      window: '5h',
      samples: [sample('a', NOW - HOUR, 0, NOW + HOUR)],
      accounts: { a: account() },
      horizon: 12 * HOUR,
    });
    expect(result.drainBars[0].end - result.drainBars[0].start).toBe(15 * MINUTE);
    expect(result.drainBars).toHaveLength(12);
  });
});

describe('projection', () => {
  /** History that drains `perHour` points from account `id` over the two hours before now. */
  const drainHistory = (id: string, perHour: number, resetsAt: number, usedNow: number) => [
    sample(id, NOW - 2 * HOUR, usedNow - 2 * perHour, resetsAt),
    sample(id, NOW, usedNow, resetsAt),
  ];

  test('fills the highest-priority group first and spills the overflow evenly', () => {
    const far = NOW + 30 * DAY;
    const result = forecast({
      samples: [
        ...drainHistory('top', 20, far, 90),
        sample('b', NOW - HOUR, 0, far),
        sample('c', NOW - HOUR, 0, far),
      ],
      accounts: { top: account(10), b: account(0), c: account(0) },
    });
    expect(result.ratePerHour).toBeCloseTo(20);
    // First 30 min empty `top` (10 points), the next 30 min (10 points) split b/c.
    const hour = pointAt(result.projection, NOW + HOUR)[0];
    expect(hour.byAccount.top).toBeCloseTo(0);
    expect(hour.byAccount.b).toBeCloseTo(95);
    expect(hour.byAccount.c).toBeCloseTo(95);
    expect(hour.total).toBeCloseTo(190);
    // Accounts clamp at zero: a day of 20/h drains 480 > 210 available.
    const last = result.projection[result.projection.length - 1];
    expect(last.t).toBe(NOW + DAY);
    expect(last.total).toBeCloseTo(0);
  });

  test('weekly accounts reset to 100 at their reset and the next reset is a week later', () => {
    const result = forecast({
      samples: [sample('a', NOW, 60, NOW + 2 * HOUR)],
      accounts: { a: account() },
      horizon: 14 * DAY,
    });
    expect(result.ratePerHour).toBe(0);
    const jump = pointAt(result.projection, NOW + 2 * HOUR);
    expect(jump.map((point) => point.total)).toEqual([40, 100]);
    expect(result.resets.map((reset) => reset.t)).toEqual([
      NOW + 2 * HOUR,
      NOW + 2 * HOUR + 7 * DAY,
    ]);
    expect(result.nextReset).toEqual({ t: NOW + 2 * HOUR, gain: 60, authIndexes: ['a'] });
    // Nothing used since, so the second reset regains nothing.
    expect(result.resets[1].gain).toBe(0);
  });

  test('a passed weekly reset rolls forward by whole weeks', () => {
    const result = forecast({
      samples: [sample('a', NOW - 8 * DAY, 30, NOW - 7 * DAY - HOUR)],
      accounts: { a: account() },
      horizon: 7 * DAY,
    });
    expect(result.current).toBe(100);
    expect(result.resets[0].t).toBe(NOW - HOUR + 7 * DAY);
  });

  test('a 5-hour window restarts only when drained again', () => {
    const result = forecast({
      window: '5h',
      samples: drainHistory('a', 10, NOW + HOUR, 50),
      accounts: { a: account() },
      horizon: 12 * HOUR,
    });
    expect(result.ratePerHour).toBeCloseTo(10);
    // 40 left at the reset (one more hour of drain), so it regains 60.
    expect(result.resets[0].t).toBe(NOW + HOUR);
    expect(result.resets[0].gain).toBeCloseTo(60);
    // Drained again right after the reset → the new window ends 5 h later.
    expect(result.resets[1].t).toBe(NOW + 6 * HOUR);
    expect(result.resets[1].gain).toBeCloseTo(50);
  });

  test('an idle 5-hour window does not reset without drain; unknown resets are not projected', () => {
    const idle = forecast({
      window: '5h',
      samples: [sample('a', NOW - HOUR, 30, NOW - 10 * MINUTE)],
      accounts: { a: account() },
      horizon: 24 * HOUR,
    });
    expect(idle.current).toBe(100);
    expect(idle.resets).toEqual([]);
    expect(idle.nextReset).toBeNull();

    const unknown = forecast({
      samples: [sample('a', NOW, 40)],
      accounts: { a: account() },
      horizon: 14 * DAY,
    });
    expect(unknown.resets).toEqual([]);
  });

  test('projection starts at now and steps every 15 minutes for the weekly window', () => {
    const result = forecast({ samples: [sample('a', NOW, 0)], accounts: { a: account() } });
    expect(result.projection[0].t).toBe(NOW);
    expect(result.projection[1].t).toBe(NOW + 15 * MINUTE);
    expect(result.projection).toHaveLength(DAY / (15 * MINUTE) + 1);
  });
});

describe('next reset label', () => {
  test('formats the gain and the local weekday time', () => {
    const t = Date.UTC(2026, 9, 29, 2, 59) / 1000;
    expect(formatNextReset({ t, gain: 99.6, authIndexes: ['a'] }, 'en-US', 'UTC')).toEqual({
      gain: '+100%',
      when: 'Thu 2:59 AM',
    });
  });

  test('skips resets that regain nothing', () => {
    const result = forecast({
      samples: [sample('a', NOW, 0, NOW + HOUR), sample('b', NOW, 30, NOW + 3 * HOUR)],
      accounts: { a: account(), b: account() },
    });
    expect(result.resets[0].gain).toBe(0);
    expect(result.nextReset?.t).toBe(NOW + 3 * HOUR);
    expect(result.nextReset?.gain).toBe(30);
  });
});

describe('projection with bursts', () => {
  const far = NOW + 30 * DAY;
  /** `top` (priority 10) drains 20 points/h over the last two hours and has 60 left. */
  const base = (extra: Record<string, number>) => ({
    samples: [
      sample('top', NOW - 2 * HOUR, 0, far),
      sample('top', NOW, 40, far),
      ...Object.entries(extra).map(([id, used]) => sample(id, NOW - HOUR, used, far)),
    ],
    accounts: {
      top: account(10),
      ...Object.fromEntries(Object.keys(extra).map((id) => [id, account(0)])),
    },
  });
  const at = (result: ReturnType<typeof forecast>, t: number) => pointAt(result.projection, t)[0];

  test('a bursting account is drained before every priority until its end', () => {
    const result = forecast({
      ...base({ low: 50 }),
      bursts: [{ authIndex: 'low', endsAt: NOW + 2 * HOUR }],
    });
    expect(result.ratePerHour).toBeCloseTo(20);
    expect(at(result, NOW + HOUR).byAccount.low).toBeCloseTo(30);
    expect(at(result, NOW + HOUR).byAccount.top).toBeCloseTo(60);
    expect(at(result, NOW + 2 * HOUR).byAccount.low).toBeCloseTo(10);
    expect(at(result, NOW + 2 * HOUR).byAccount.top).toBeCloseTo(60);
    // Burst over: back to normal priority, so `top` drains and `low` keeps its 10.
    expect(at(result, NOW + 3 * HOUR).byAccount.top).toBeCloseTo(40);
    expect(at(result, NOW + 3 * HOUR).byAccount.low).toBeCloseTo(10);
  });

  test('bursts are used one at a time in burst order, then the priorities', () => {
    const result = forecast({
      ...base({ p: 80, q: 0 }),
      bursts: [
        { authIndex: 'p', endsAt: NOW + 4 * HOUR },
        { authIndex: 'q', endsAt: NOW + 4 * HOUR },
      ],
    });
    // `p` holds 20: empty after one hour, the overflow moves to `q`, not to `top`.
    expect(at(result, NOW + HOUR).byAccount.p).toBeCloseTo(0);
    expect(at(result, NOW + HOUR).byAccount.q).toBeCloseTo(100);
    expect(at(result, NOW + 2 * HOUR).byAccount.q).toBeCloseTo(80);
    expect(at(result, NOW + 4 * HOUR).byAccount.q).toBeCloseTo(40);
    expect(at(result, NOW + 4 * HOUR).byAccount.top).toBeCloseTo(60);
    expect(at(result, NOW + 5 * HOUR).byAccount.top).toBeCloseTo(40);
    expect(at(result, NOW + 5 * HOUR).byAccount.q).toBeCloseTo(40);
  });

  test('a burst ending mid-step hands over at its end instant', () => {
    const result = forecast({
      ...base({ low: 0 }),
      bursts: [{ authIndex: 'low', endsAt: NOW + 10 * MINUTE }],
    });
    // 10 of the first 15 minutes go to `low`, the last 5 to `top`.
    const quarter = at(result, NOW + 15 * MINUTE);
    expect(quarter.byAccount.low).toBeCloseTo(100 - 20 / 6);
    expect(quarter.byAccount.top).toBeCloseTo(60 - 20 / 12);
    // The hand-over is not a reset.
    expect(result.resets).toEqual([]);
  });

  test('expired bursts and accounts outside the chart change nothing', () => {
    const plain = forecast(base({ low: 50 }));
    const ignored = forecast({
      ...base({ low: 50 }),
      bursts: [
        { authIndex: 'low', endsAt: NOW },
        { authIndex: 'other-provider', endsAt: NOW + 2 * HOUR },
      ],
    });
    expect(ignored.projection).toEqual(plain.projection);
    expect(at(plain, NOW + HOUR).byAccount.top).toBeCloseTo(40);
  });
});
