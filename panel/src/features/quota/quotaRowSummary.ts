/**
 * Compact quota rows: every provider's limits in one shape.
 *
 * Pure functions — no React, no clock of their own — consumed by the account
 * rows and the provider group headers, and directly by
 * tests/quotaRowSummary.test.ts.
 *
 * The provider states disagree about where a limit lives and what its number
 * means (percent used, percent remaining, a 0..1 fraction, raw counts). This is
 * the one place that reconciles them, so the row never has to know.
 */

import type { QuotaProviderType } from './providers/types';

export interface QuotaLimitSummary {
  id: string;
  /** Display text when the provider supplied no translation key. */
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  /** Percent remaining, 0..100; null when the payload carried no figure. */
  remaining: number | null;
  resetAtMs: number | null;
  /** Provider-baked absolute reset label, preferred over formatting `resetAtMs`. */
  resetLabel?: string;
  periodHours: number | null;
  /**
   * Account-wide window (5-hour, weekly…). Exhausting one blocks the whole
   * account; a model-scoped window only blocks that model.
   */
  primary: boolean;
  /** Raw counts, for providers that report them. */
  usage?: { used: number; limit: number };
}

export type QuotaRowStatus =
  | { kind: 'disabled' }
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'logged_out' }
  | { kind: 'error'; message: string; status?: number }
  /** A primary window is at 0%. `backAtMs` is when *every* exhausted one has reset. */
  | { kind: 'exhausted'; backAtMs: number | null }
  | { kind: 'ok' };

interface QuotaLike {
  status?: string;
  error?: string;
  errorStatus?: number;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const remainingFromUsed = (used: unknown): number | null => {
  const value = finiteOrNull(used);
  return value === null ? null : clampPercent(100 - value);
};

/** Account-wide window ids; anything else from these providers is model-scoped. */
const PRIMARY_WINDOW_IDS: Partial<Record<QuotaProviderType, ReadonlySet<string>>> = {
  claude: new Set(['five-hour', 'seven-day']),
  codex: new Set(['five-hour', 'weekly', 'monthly']),
};

interface WindowLike {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  resetLabel?: string;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

function readClaudeCodexLimits(provider: 'claude' | 'codex', quota: unknown): QuotaLimitSummary[] {
  const primaryIds = PRIMARY_WINDOW_IDS[provider] ?? new Set<string>();
  return ((quota as { windows?: WindowLike[] }).windows ?? []).map((window, index) => {
    const id = window.id ?? `window-${index}`;
    return {
      id,
      label: window.label ?? id,
      labelKey: window.labelKey,
      labelParams: window.labelParams,
      // Claude and Codex store percent USED.
      remaining: remainingFromUsed(window.usedPercent),
      resetAtMs: finiteOrNull(window.resetAtMs),
      resetLabel: window.resetLabel,
      periodHours: finiteOrNull(window.periodHours),
      primary: primaryIds.has(id),
    };
  });
}

function readDevinLimits(quota: unknown): QuotaLimitSummary[] {
  const windows =
    (
      quota as {
        windows?: {
          id: string;
          label?: string;
          remainingPercent: number | null;
          resetAtMs: number | null;
          periodHours: number;
        }[];
      }
    ).windows ?? [];
  return windows.map((window) => ({
    id: window.id,
    label: window.label ?? window.id,
    labelKey: `devin_quota.${window.id}`,
    // Devin reports percent REMAINING.
    remaining: finiteOrNull(window.remainingPercent),
    resetAtMs: finiteOrNull(window.resetAtMs),
    periodHours: finiteOrNull(window.periodHours),
    primary: true,
  }));
}

function readXaiLimits(quota: unknown): QuotaLimitSummary[] {
  const billing = (
    quota as {
      billing?: {
        periodType?: string;
        usagePercent?: number | null;
        resetAtMs?: number | null;
        periodHours?: number | null;
      } | null;
    }
  ).billing;
  // Only the weekly figure is a quota window; monthly is a billing cycle.
  if (!billing || billing.periodType !== 'weekly') return [];
  return [
    {
      id: 'weekly',
      label: 'weekly',
      labelKey: 'xai_quota.weekly_limit',
      remaining: remainingFromUsed(billing.usagePercent),
      resetAtMs: finiteOrNull(billing.resetAtMs),
      periodHours: finiteOrNull(billing.periodHours) ?? 24 * 7,
      primary: true,
    },
  ];
}

function readAntigravityLimits(quota: unknown): QuotaLimitSummary[] {
  const groups =
    (
      quota as {
        groups?: {
          buckets?: {
            id?: string;
            label?: string;
            remainingFraction?: number | null;
            resetAtMs?: number | null;
            periodHours?: number | null;
          }[];
        }[];
      }
    ).groups ?? [];
  return groups
    .flatMap((group) => group.buckets ?? [])
    .map((bucket, index) => {
      const fraction = finiteOrNull(bucket.remainingFraction);
      return {
        id: bucket.id ?? `bucket-${index}`,
        label: bucket.label ?? bucket.id ?? `#${index + 1}`,
        // Antigravity reports a 0..1 fraction REMAINING.
        remaining: fraction === null ? null : clampPercent(Math.round(fraction * 100)),
        resetAtMs: finiteOrNull(bucket.resetAtMs),
        periodHours: finiteOrNull(bucket.periodHours),
        // Every bucket is per-model; none blocks the whole account.
        primary: false,
      };
    });
}

function readKimiLimits(quota: unknown): QuotaLimitSummary[] {
  const rows =
    (
      quota as {
        rows?: {
          id?: string;
          label?: string;
          labelKey?: string;
          labelParams?: Record<string, string | number>;
          used: number;
          limit: number;
          resetAtMs?: number | null;
          periodHours?: number | null;
        }[];
      }
    ).rows ?? [];
  return rows.map((row, index) => ({
    id: row.id ?? `row-${index}`,
    label: row.label ?? row.id ?? `#${index + 1}`,
    labelKey: row.labelKey,
    labelParams: row.labelParams,
    // Kimi reports raw counts; remaining is derived.
    remaining:
      row.limit > 0 ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100)) : null,
    resetAtMs: finiteOrNull(row.resetAtMs),
    periodHours: finiteOrNull(row.periodHours),
    primary: true,
    usage: { used: row.used, limit: row.limit },
  }));
}

function readMetaLimits(quota: unknown): QuotaLimitSummary[] {
  const windows =
    (
      quota as {
        data?: {
          windows?: {
            id: 'window' | 'weekly';
            usedPercent: number | null;
            /** Unix seconds from the upstream Meta contract. */
            resetAt?: number;
            durationMinutes?: number;
          }[];
        };
      }
    ).data?.windows ?? [];
  return windows.map((window) => {
    const resetAt = finiteOrNull(window.resetAt);
    const minutes = window.id === 'weekly' ? 7 * 24 * 60 : finiteOrNull(window.durationMinutes);
    return {
      id: window.id,
      label: window.id,
      labelKey: `meta_quota.${window.id}`,
      remaining: remainingFromUsed(window.usedPercent),
      resetAtMs: resetAt === null ? null : resetAt * 1000,
      periodHours: minutes === null ? null : minutes / 60,
      primary: true,
    };
  });
}

/**
 * Every limit a loaded credential reports, account-wide windows first (shortest
 * period first), then model-scoped ones in provider order.
 */
export function summarizeQuotaLimits(
  provider: QuotaProviderType,
  quota: QuotaLike | undefined
): QuotaLimitSummary[] {
  if (!quota || quota.status !== 'success') return [];

  const limits = (() => {
    switch (provider) {
      case 'claude':
      case 'codex':
        return readClaudeCodexLimits(provider, quota);
      case 'devin':
        return readDevinLimits(quota);
      case 'xai':
        return readXaiLimits(quota);
      case 'antigravity':
        return readAntigravityLimits(quota);
      case 'kimi':
        return readKimiLimits(quota);
      case 'meta':
        return readMetaLimits(quota);
      default:
        return [];
    }
  })();

  return orderQuotaLimits(limits);
}

/** Account-wide windows first (shortest period first), then model-scoped ones in given order. */
export function orderQuotaLimits(limits: readonly QuotaLimitSummary[]): QuotaLimitSummary[] {
  const period = (limit: QuotaLimitSummary) => limit.periodHours ?? Number.POSITIVE_INFINITY;
  const primary = limits
    .map((limit, index) => ({ limit, index }))
    .filter(({ limit }) => limit.primary)
    .sort((a, b) => period(a.limit) - period(b.limit) || a.index - b.index)
    .map(({ limit }) => limit);
  return [...primary, ...limits.filter((limit) => !limit.primary)];
}

/** HTTP statuses that mean the stored login no longer works. */
const LOGGED_OUT_STATUSES = new Set([401]);

/**
 * What the row's status column says. Healthy accounts say nothing (`ok`) —
 * the column only speaks for an exhausted window or a broken login.
 *
 * `limits` may come from live traffic even when nothing was fetched, so they
 * are judged regardless of the fetch state. A failed fetch only surfaces when
 * there is nothing else to show — except an expired login, which always does.
 *
 * An account at 0% on both its 5-hour and weekly windows is unusable until the
 * *later* of the two resets, not the sooner one.
 */
export function resolveQuotaRowStatus(
  quota: QuotaLike | undefined,
  disabled: boolean,
  limits: readonly QuotaLimitSummary[]
): QuotaRowStatus {
  if (disabled) return { kind: 'disabled' };
  const status = quota?.status ?? 'idle';
  if (status === 'error') {
    if (quota?.errorStatus !== undefined && LOGGED_OUT_STATUSES.has(quota.errorStatus)) {
      return { kind: 'logged_out' };
    }
    if (limits.length === 0) {
      return { kind: 'error', message: quota?.error ?? '', status: quota?.errorStatus };
    }
  }

  const exhausted = limits.filter((limit) => limit.primary && limit.remaining === 0);
  if (exhausted.length > 0) {
    const resets = exhausted.map((limit) => limit.resetAtMs);
    const backAtMs = resets.every((value): value is number => value !== null)
      ? Math.max(...resets)
      : null;
    return { kind: 'exhausted', backAtMs };
  }
  if (status === 'loading') return { kind: 'loading' };
  if (limits.length === 0) return { kind: 'idle' };
  return { kind: 'ok' };
}

export interface ProviderGroupSummary {
  total: number;
  /** Loaded and not blocked. */
  available: number;
  /** Earliest instant an exhausted account comes back, if any. */
  nextBackAtMs: number | null;
}

export function summarizeProviderGroup(statuses: readonly QuotaRowStatus[]): ProviderGroupSummary {
  let available = 0;
  let nextBackAtMs: number | null = null;
  for (const status of statuses) {
    if (status.kind === 'ok') available += 1;
    if (status.kind === 'exhausted' && status.backAtMs !== null) {
      nextBackAtMs =
        nextBackAtMs === null ? status.backAtMs : Math.min(nextBackAtMs, status.backAtMs);
    }
  }
  return { total: statuses.length, available, nextBackAtMs };
}

/** Widest a row's limit grid gets; more limits continue on a second, aligned line. */
export const MAX_LIMIT_COLUMNS = 3;

/**
 * Limit columns every row of a provider group lays out: its widest row (Claude
 * 3, Codex 2), capped at `MAX_LIMIT_COLUMNS` so columns stay readable on a
 * laptop. A row with fewer limits leaves the remaining slots empty, so the
 * same limit lines up across rows. At least 2, so a loading or empty group
 * keeps sensible widths.
 */
export function limitColumnCount(limitCounts: readonly number[]): number {
  const widest = limitCounts.reduce((max, count) => Math.max(max, count), 0);
  return Math.min(MAX_LIMIT_COLUMNS, Math.max(2, widest));
}

/** Providers whose rolling 5-hour window the proxy can open on demand. */
const WINDOW_STARTABLE: ReadonlySet<QuotaProviderType> = new Set(['claude', 'codex']);

/**
 * Slack for "the reset sits a whole period ahead": an unused Codex window
 * reports a reset that slides along with the clock instead of a fixed instant.
 */
const SLIDING_RESET_SLACK_MS = 2 * 60_000;

/**
 * Whether the row offers to start its 5-hour window: the account is usable and
 * its 5-hour window is not running — no reset instant (rolled over, or never
 * started), a reset still a full period away (unused, sliding), or no data yet.
 */
export function canStartQuotaWindow(
  type: QuotaProviderType,
  status: QuotaRowStatus,
  limits: readonly QuotaLimitSummary[],
  now: number
): boolean {
  if (!WINDOW_STARTABLE.has(type)) return false;
  if (status.kind !== 'ok' && status.kind !== 'idle') return false;
  const fiveHour = limits.find((limit) => limit.id === 'five-hour');
  if (!fiveHour) return true;
  if (fiveHour.resetAtMs === null) return true;
  if (fiveHour.remaining !== 100 || fiveHour.periodHours === null) return false;
  return isSlidingReset(fiveHour, now);
}

/** An unused window whose reported reset is still a whole period away. */
function isSlidingReset(limit: QuotaLimitSummary, now: number): boolean {
  if (limit.resetAtMs === null || limit.periodHours === null) return false;
  return limit.resetAtMs - now >= limit.periodHours * 3_600_000 - SLIDING_RESET_SLACK_MS;
}

/**
 * Whether the row offers "Prioritise": a usable Claude / Codex account whose
 * 5-hour window is running (a fixed reset still ahead) and has quota left.
 */
export function canPrioritiseQuotaRow(
  type: QuotaProviderType,
  status: QuotaRowStatus,
  limits: readonly QuotaLimitSummary[],
  now: number
): boolean {
  if (!WINDOW_STARTABLE.has(type)) return false;
  if (status.kind !== 'ok' && status.kind !== 'loading') return false;
  const fiveHour = limits.find((limit) => limit.id === 'five-hour');
  if (!fiveHour || fiveHour.resetAtMs === null || fiveHour.resetAtMs <= now) return false;
  if (fiveHour.remaining === null || fiveHour.remaining <= 0) return false;
  return !(fiveHour.remaining >= 100 && isSlidingReset(fiveHour, now));
}

/** Account-wide weekly windows: Claude "seven-day", Codex "weekly". */
const WEEKLY_WINDOW_IDS: ReadonlySet<string> = new Set(['seven-day', 'weekly']);

/**
 * Whether the row offers "Prioritise until weekly reset": a Claude / Codex
 * account whose weekly window is running with quota left. Unlike the 5-hour
 * action it stays available while only the 5-hour limit is used up — the
 * account then takes the top spot again when its 5-hour window resets.
 */
export function canPrioritiseWeeklyQuotaRow(
  type: QuotaProviderType,
  status: QuotaRowStatus,
  limits: readonly QuotaLimitSummary[],
  now: number
): boolean {
  if (!WINDOW_STARTABLE.has(type)) return false;
  if (status.kind !== 'ok' && status.kind !== 'loading' && status.kind !== 'exhausted') {
    return false;
  }
  const weekly = limits.find((limit) => WEEKLY_WINDOW_IDS.has(limit.id));
  if (!weekly || weekly.resetAtMs === null || weekly.resetAtMs <= now) return false;
  return weekly.remaining !== null && weekly.remaining > 0;
}
