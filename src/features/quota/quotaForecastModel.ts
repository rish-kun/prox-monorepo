/**
 * Remaining-quota forecast for one provider and one window (5-hour or weekly),
 * from the proxy's recorded history (`GET /quota/history`).
 *
 * Units: every instant is unix seconds, every quantity is percentage points of
 * one account (an account holds 0..100; the provider total holds up to
 * `accounts × 100`). `now` is always passed in — nothing here reads a clock.
 *
 * - Remaining at t: 100 − used of the latest sample ≤ t; back to 100 once that
 *   sample's reset has passed. The proxy also returns each account's last
 *   sample from before the requested range: it anchors the left edge. Accounts without a sample are left out of the
 *   total but count towards the max; disabled accounts are excluded entirely.
 * - Drain: positive drops between consecutive samples of one account with no
 *   reset in between, spread evenly over the interval between the samples.
 * - Projection: the drain rate goes to the highest-priority group that still
 *   has quota (evenly within the group, overflow to the next group); accounts
 *   reset to 100 at their reset instant. Weekly windows restart right away
 *   (+7 d); a 5-hour window restarts only when it is next drained (+5 h).
 * - Bursts ("Prioritise plan"): until its `endsAt`, a bursting account is
 *   drained before every priority group, one burst at a time in burst order;
 *   afterwards it is back in its normal priority group.
 *
 * React-free; covered by tests/quotaForecastModel.test.ts.
 */

import type {
  QuotaHistoryAccount,
  QuotaHistorySample,
  QuotaHistoryWindow,
} from '@/services/api/quotaSnapshots';

export type ForecastWindow = QuotaHistoryWindow;

export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FIVE_HOURS = 5 * HOUR;
const EPSILON = 1e-9;

/** "Next" horizon choices per window, seconds. */
export const FORECAST_HORIZONS: Record<ForecastWindow, readonly number[]> = {
  weekly: [1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY],
  '5h': [12 * HOUR, 24 * HOUR, 48 * HOUR],
};

export const DEFAULT_FORECAST_HORIZON: Record<ForecastWindow, number> = {
  weekly: 7 * DAY,
  '5h': 24 * HOUR,
};

/** Drain-rate lookback choices, seconds. */
export const FORECAST_LOOKBACKS: readonly number[] = [6 * HOUR, 24 * HOUR, 3 * DAY, 7 * DAY];
export const DEFAULT_FORECAST_LOOKBACK = 24 * HOUR;

const PAST_STEP: Record<ForecastWindow, number> = { weekly: 30 * MINUTE, '5h': 5 * MINUTE };
const PROJECTION_STEP: Record<ForecastWindow, number> = { weekly: 15 * MINUTE, '5h': 5 * MINUTE };
const DRAIN_BUCKET: Record<ForecastWindow, number> = { weekly: HOUR, '5h': 15 * MINUTE };

/** The history shown before "now" is a quarter of the forward horizon. */
export const pastSpanFor = (horizon: number): number => Math.round(horizon / 4);

export const drainBucketFor = (window: ForecastWindow): number => DRAIN_BUCKET[window];

/** How much history to request: the past span or lookback, plus a day to anchor the first point. */
export const historySpanFor = (horizon: number, lookback: number): number =>
  Math.max(pastSpanFor(horizon), lookback) + DAY;

export interface ForecastAccountInfo {
  authIndex: string;
  label: string;
  priority: number;
}

export interface ForecastPoint {
  t: number;
  /** Sum over accounts that have data; null when none has. */
  total: number | null;
  /** Remaining per account (only accounts that have data). */
  byAccount: Record<string, number>;
}

export interface ForecastReset {
  t: number;
  /** Percentage points regained: 100 − remaining just before the reset, summed. */
  gain: number;
  authIndexes: string[];
}

export interface DrainBar {
  start: number;
  end: number;
  /** Drain in this bucket, expressed per hour. */
  ratePerHour: number;
}

export interface DrainEvent {
  authIndex: string;
  from: number;
  to: number;
  amount: number;
}

/** A running burst, in routing order. */
export interface ForecastBurst {
  authIndex: string;
  /** Unix seconds; the account is used first until then. */
  endsAt: number;
}

export interface ForecastInput {
  window: ForecastWindow;
  samples: readonly QuotaHistorySample[];
  accounts: Record<string, QuotaHistoryAccount>;
  now: number;
  horizon: number;
  lookback: number;
  /** Running bursts in routing order; accounts not charted here are ignored. */
  bursts?: readonly ForecastBurst[];
}

export interface QuotaForecast {
  window: ForecastWindow;
  now: number;
  start: number;
  end: number;
  /** Enabled accounts, highest priority first. */
  accounts: ForecastAccountInfo[];
  /** Enabled accounts × 100. */
  max: number;
  /** Total remaining now; null when no account has a sample yet. */
  current: number | null;
  /** Headline drain, percentage points per hour over the lookback. */
  ratePerHour: number;
  past: ForecastPoint[];
  /** Starts at `now`; resets appear as two points at the same instant. */
  projection: ForecastPoint[];
  resets: ForecastReset[];
  nextReset: ForecastReset | null;
  drainBars: DrainBar[];
  /** Average drain over the past span, per hour. */
  drainAverage: number;
  hasData: boolean;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** Samples per account, oldest first. */
export function groupSamples(
  samples: readonly QuotaHistorySample[]
): Map<string, QuotaHistorySample[]> {
  const byAccount = new Map<string, QuotaHistorySample[]>();
  for (const sample of samples) {
    const list = byAccount.get(sample.authIndex) ?? [];
    list.push(sample);
    byAccount.set(sample.authIndex, list);
  }
  byAccount.forEach((list) => list.sort((left, right) => left.t - right.t));
  return byAccount;
}

function latestAtOrBefore(
  series: readonly QuotaHistorySample[],
  t: number
): QuotaHistorySample | null {
  let found: QuotaHistorySample | null = null;
  for (const sample of series) {
    if (sample.t > t) break;
    found = sample;
  }
  return found;
}

/** Remaining (0..100) of one account at `t`; null before its first sample. */
export function remainingAt(series: readonly QuotaHistorySample[], t: number): number | null {
  const sample = latestAtOrBefore(series, t);
  if (!sample) return null;
  if (sample.resetsAt > 0 && sample.resetsAt <= t) return 100;
  return clampPercent(100 - sample.used);
}

/** Positive drops between consecutive samples with no reset in between. */
export function drainEvents(
  authIndex: string,
  series: readonly QuotaHistorySample[]
): DrainEvent[] {
  const events: DrainEvent[] = [];
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];
    if (previous.resetsAt > 0 && previous.resetsAt <= current.t) continue;
    const amount = current.used - previous.used;
    if (amount > EPSILON) {
      events.push({ authIndex, from: previous.t, to: current.t, amount });
    }
  }
  return events;
}

/** The part of an event that falls inside [start, end), assuming an even spread. */
function overlapAmount(event: DrainEvent, start: number, end: number): number {
  if (event.to <= event.from) {
    return event.to >= start && event.to < end ? event.amount : 0;
  }
  const overlap = Math.min(event.to, end) - Math.max(event.from, start);
  return overlap > 0 ? (event.amount * overlap) / (event.to - event.from) : 0;
}

const sumInRange = (events: readonly DrainEvent[], start: number, end: number) =>
  events.reduce((sum, event) => sum + overlapAmount(event, start, end), 0);

/**
 * Enabled accounts, highest priority first (falls back to sampled indexes for
 * old proxies). API-key credentials are listed with an empty label and are
 * never polled, so an account counts only once it has a label or a sample —
 * otherwise it would hold an empty 100 % in the max forever.
 */
export function enabledAccounts(
  accounts: Record<string, QuotaHistoryAccount>,
  samples: readonly QuotaHistorySample[]
): ForecastAccountInfo[] {
  const entries = Object.entries(accounts);
  const sampled = new Set(samples.map((sample) => sample.authIndex));
  const list: ForecastAccountInfo[] =
    entries.length > 0
      ? entries
          .filter(([, account]) => !account.disabled)
          .filter(([authIndex, account]) => account.label !== '' || sampled.has(authIndex))
          .map(([authIndex, account]) => ({
            authIndex,
            label: account.label,
            priority: account.priority,
          }))
      : Array.from(sampled).map((authIndex) => ({
          authIndex,
          label: '',
          priority: 0,
        }));
  return list.sort(
    (left, right) =>
      right.priority - left.priority ||
      left.label.localeCompare(right.label) ||
      left.authIndex.localeCompare(right.authIndex)
  );
}

interface ProjectedAccount {
  authIndex: string;
  priority: number;
  remaining: number;
  /** Next reset, unix s; 0 = none projected. */
  resetAt: number;
  /** 5-hour window not running: it starts on the next drain. */
  idle: boolean;
}

function initialProjection(
  window: ForecastWindow,
  info: ForecastAccountInfo,
  series: readonly QuotaHistorySample[],
  now: number
): ProjectedAccount | null {
  const sample = latestAtOrBefore(series, now);
  const remaining = remainingAt(series, now);
  if (!sample || remaining === null) return null;
  const base = { authIndex: info.authIndex, priority: info.priority, remaining };
  if (window === 'weekly') {
    let resetAt = sample.resetsAt;
    if (resetAt > 0) {
      while (resetAt <= now) resetAt += WEEK;
    }
    return { ...base, resetAt, idle: false };
  }
  if (sample.resetsAt > 0 && sample.resetsAt <= now) {
    return { ...base, remaining: 100, resetAt: 0, idle: true };
  }
  if (sample.resetsAt > 0) return { ...base, resetAt: sample.resetsAt, idle: false };
  // Unknown reset: a full account is treated as not yet started, otherwise no reset is projected.
  return { ...base, resetAt: 0, idle: remaining >= 100 - EPSILON };
}

/** Spread `amount` over priority groups (highest first), evenly within a group. */
function drainGroups(groups: ProjectedAccount[][], amount: number, at: number) {
  let left = amount;
  for (const group of groups) {
    while (left > EPSILON) {
      const active = group.filter((account) => account.remaining > EPSILON);
      if (active.length === 0) break;
      const share = left / active.length;
      for (const account of active) {
        const take = Math.min(share, account.remaining);
        account.remaining -= take;
        left -= take;
        if (take > 0 && account.idle) {
          account.idle = false;
          account.resetAt = at + FIVE_HOURS;
        }
      }
    }
    if (left <= EPSILON) return;
  }
}

function projectionPoint(t: number, states: readonly ProjectedAccount[]): ForecastPoint {
  const byAccount: Record<string, number> = {};
  let total = 0;
  for (const state of states) {
    byAccount[state.authIndex] = state.remaining;
    total += state.remaining;
  }
  return { t, total: states.length > 0 ? total : null, byAccount };
}

function project(
  window: ForecastWindow,
  states: ProjectedAccount[],
  now: number,
  horizon: number,
  ratePerHour: number,
  bursts: readonly ForecastBurst[]
): { points: ForecastPoint[]; resets: ForecastReset[] } {
  const priorities = Array.from(new Set(states.map((state) => state.priority))).sort(
    (left, right) => right - left
  );
  const groups = priorities.map((priority) =>
    states.filter((state) => state.priority === priority)
  );
  const byIndex = new Map(states.map((state) => [state.authIndex, state]));
  const burstStates = bursts
    .filter((burst) => burst.endsAt > now)
    .flatMap((burst) => {
      const state = byIndex.get(burst.authIndex);
      return state ? [{ state, endsAt: burst.endsAt }] : [];
    });
  /** Bursts still running at `t` lead, each on its own; a drained one overflows to the next. */
  const groupsAt = (t: number): ProjectedAccount[][] => {
    const leading = burstStates.filter((burst) => burst.endsAt > t).map((burst) => [burst.state]);
    return leading.length > 0 ? [...leading, ...groups] : groups;
  };
  const step = PROJECTION_STEP[window];
  const end = now + horizon;
  const points: ForecastPoint[] = [projectionPoint(now, states)];
  const resets: ForecastReset[] = [];

  let t = now;
  while (t < end) {
    const stepEnd = Math.min(t + step, end);
    let cursor = t;
    for (;;) {
      let nextReset = Infinity;
      for (const state of states) {
        if (state.resetAt > cursor && state.resetAt <= stepEnd && state.resetAt < nextReset) {
          nextReset = state.resetAt;
        }
      }
      // A burst ending mid-step hands the drain back to the priority groups right then.
      let nextBurstEnd = Infinity;
      for (const burst of burstStates) {
        if (burst.endsAt > cursor && burst.endsAt < nextBurstEnd) nextBurstEnd = burst.endsAt;
      }
      const segmentEnd = Math.min(nextReset, nextBurstEnd, stepEnd);
      if (ratePerHour > 0 && segmentEnd > cursor) {
        drainGroups(groupsAt(cursor), (ratePerHour * (segmentEnd - cursor)) / HOUR, cursor);
      }
      cursor = segmentEnd;
      if (segmentEnd !== nextReset) {
        if (cursor >= stepEnd) break;
        continue;
      }

      points.push(projectionPoint(nextReset, states));
      const resetting = states.filter((state) => state.resetAt === nextReset);
      let gain = 0;
      for (const state of resetting) {
        gain += 100 - state.remaining;
        state.remaining = 100;
        if (window === 'weekly') {
          state.resetAt = nextReset + WEEK;
        } else {
          state.resetAt = 0;
          state.idle = true;
        }
      }
      resets.push({ t: nextReset, gain, authIndexes: resetting.map((state) => state.authIndex) });
      points.push(projectionPoint(nextReset, states));
    }
    if (points[points.length - 1].t !== stepEnd) points.push(projectionPoint(stepEnd, states));
    t = stepEnd;
  }
  return { points, resets };
}

export function buildQuotaForecast(input: ForecastInput): QuotaForecast {
  const { window, now, horizon, lookback } = input;
  const accounts = enabledAccounts(input.accounts, input.samples);
  const enabled = new Set(accounts.map((account) => account.authIndex));
  const series = groupSamples(input.samples.filter((sample) => enabled.has(sample.authIndex)));
  const pastSpan = pastSpanFor(horizon);
  const start = now - pastSpan;

  /* ---------- past ---------- */
  const pastPoint = (t: number): ForecastPoint => {
    const byAccount: Record<string, number> = {};
    let total = 0;
    let any = false;
    for (const account of accounts) {
      const value = remainingAt(series.get(account.authIndex) ?? [], t);
      if (value === null) continue;
      byAccount[account.authIndex] = value;
      total += value;
      any = true;
    }
    return { t, total: any ? total : null, byAccount };
  };
  const past: ForecastPoint[] = [];
  for (let t = start; t < now; t += PAST_STEP[window]) past.push(pastPoint(t));
  past.push(pastPoint(now));
  const current = past[past.length - 1].total;

  /* ---------- drain ---------- */
  const events = accounts.flatMap((account) =>
    drainEvents(account.authIndex, series.get(account.authIndex) ?? [])
  );
  let firstSampleAt = Infinity;
  series.forEach((list) => {
    if (list.length > 0 && list[0].t < firstSampleAt) firstSampleAt = list[0].t;
  });
  // A lookback longer than the recording would dilute the rate: divide by what was observed.
  const coveredHours = (span: number) => {
    const from = Math.max(now - span, Number.isFinite(firstSampleAt) ? firstSampleAt : now);
    return Math.max(1, (now - from) / HOUR);
  };
  const ratePerHour = sumInRange(events, now - lookback, now) / coveredHours(lookback);
  const drainAverage = sumInRange(events, start, now) / coveredHours(pastSpan);

  const bucket = DRAIN_BUCKET[window];
  const drainBars: DrainBar[] = [];
  for (let barStart = Math.floor(start / bucket) * bucket; barStart < now; barStart += bucket) {
    const barEnd = barStart + bucket;
    const from = Math.max(barStart, start);
    const to = Math.min(barEnd, now);
    const hours = Math.max(MINUTE, to - from) / HOUR;
    drainBars.push({
      start: barStart,
      end: barEnd,
      ratePerHour: sumInRange(events, from, to) / hours,
    });
  }

  /* ---------- projection ---------- */
  const states = accounts
    .map((account) => initialProjection(window, account, series.get(account.authIndex) ?? [], now))
    .filter((state): state is ProjectedAccount => state !== null);
  const { points: projection, resets } = project(
    window,
    states,
    now,
    horizon,
    ratePerHour,
    input.bursts ?? []
  );

  return {
    window,
    now,
    start,
    end: now + horizon,
    accounts,
    max: accounts.length * 100,
    current,
    ratePerHour,
    past,
    projection,
    resets,
    nextReset: resets.find((reset) => reset.gain > EPSILON) ?? null,
    drainBars,
    drainAverage,
    hasData: current !== null,
  };
}

/** "+100%" and "Thu 2:59 AM" for the next-reset line. */
export function formatNextReset(
  reset: ForecastReset,
  locale?: string,
  timeZone?: string
): { gain: string; when: string } {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, options);
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', options);
  }
  return { gain: `+${Math.round(reset.gain)}%`, when: formatter.format(reset.t * 1000) };
}

/** Nearest point to `t` (past and projection together). */
export function nearestPoint(points: readonly ForecastPoint[], t: number): ForecastPoint | null {
  let best: ForecastPoint | null = null;
  for (const point of points) {
    if (!best || Math.abs(point.t - t) < Math.abs(best.t - t)) best = point;
  }
  return best;
}
