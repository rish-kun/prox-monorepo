/**
 * "Prioritise plan" bursts as the Quota page shows them. Pure functions, no
 * clock of their own; covered by tests/quotaBurst.test.ts.
 *
 * The proxy drops a burst within ~30 s of its `ends_at`; the page hides it at
 * `ends_at` already, so an expired tag never lingers until the next poll.
 */

import type { QuotaBurst, QuotaBurstKind } from '@/services/api/quotaBurst';
import { formatCompactInstant } from '@/utils/quota/relativeTime';
import type { ForecastBurst } from './quotaForecastModel';

export interface RowBurst {
  /** 1-based position among the provider's active bursts — the order they are used in. */
  rank: number;
  endsAtMs: number;
  kind: QuotaBurstKind;
}

/** Bursts still running at `nowMs`, in routing order. */
export function activeBursts(bursts: readonly QuotaBurst[], nowMs: number): QuotaBurst[] {
  return bursts
    .filter((burst) => burst.endsAtMs > nowMs)
    .sort((left, right) => left.order - right.order);
}

/**
 * Auth index → its tag data. Ranks count per provider: Claude and Codex bursts
 * never compete for the same request, so each provider's first burst is #1.
 */
export function rowBurstsByIndex(
  active: readonly QuotaBurst[],
  /** Provider of a credential, for bursts the proxy listed without one. */
  providerOf: (authIndex: string) => string = () => ''
): Map<string, RowBurst> {
  const counts = new Map<string, number>();
  const out = new Map<string, RowBurst>();
  for (const burst of active) {
    const provider = burst.provider || providerOf(burst.authIndex);
    const rank = (counts.get(provider) ?? 0) + 1;
    counts.set(provider, rank);
    out.set(burst.authIndex, { rank, endsAtMs: burst.endsAtMs, kind: burst.kind });
  }
  return out;
}

/** The next instant a running burst ends, or null when none runs. */
export function nextBurstExpiry(active: readonly QuotaBurst[]): number | null {
  return active.reduce<number | null>(
    (soonest, burst) => (soonest === null ? burst.endsAtMs : Math.min(soonest, burst.endsAtMs)),
    null
  );
}

/**
 * Running bursts for the forecast, in routing order (unix seconds). Auth
 * indexes are unique across providers, so the model simply ignores bursts of
 * accounts outside the charted provider.
 */
export function toForecastBursts(active: readonly QuotaBurst[]): ForecastBurst[] {
  return active.map((burst) => ({
    authIndex: burst.authIndex,
    endsAt: Math.floor(burst.endsAtMs / 1000),
  }));
}

/**
 * "3:39 PM" — a 5-hour burst ends within five hours, so the time alone is
 * unambiguous. A weekly burst can end days away: `withDay` gives "Sat 3:39 PM".
 */
export function formatBurstEnd(
  endsAtMs: number,
  locale?: string,
  timeZone?: string,
  withDay = false
): string {
  const options: Intl.DateTimeFormatOptions = {
    ...(withDay ? { weekday: 'short' as const } : {}),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(endsAtMs);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(endsAtMs);
  }
}

/**
 * End time for the compact tag ("#1 · 11:30 PM", "⇈ #2 · Sat 07:30"): a
 * 5-hour burst keeps `formatBurstEnd`; a weekly one uses the 24-hour weekday
 * form of the reset lines, which is shorter and matches them.
 */
export function formatBurstEndShort(
  burst: Pick<RowBurst, 'endsAtMs' | 'kind'>,
  nowMs: number,
  locale?: string,
  timeZone?: string
): string {
  return burst.kind === 'weekly'
    ? formatCompactInstant(burst.endsAtMs, nowMs, locale, timeZone)
    : formatBurstEnd(burst.endsAtMs, locale, timeZone);
}
