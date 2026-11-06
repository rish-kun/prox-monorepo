/**
 * Quota read from the proxy's passive observations — the rate-limit headers
 * upstream already returns on every real request — instead of polling the
 * providers' usage endpoints.
 *
 * The backend records them per credential (`quota.signals`, plus per-model
 * snapshots in `model_quotas`) and ships them with the credential list, so
 * reading them costs no upstream request at all. That is what lets the page
 * stay current on load and tab focus without tripping Anthropic's strict rate
 * limit on /api/oauth/usage.
 *
 * Pure functions — consumed by QuotaPage and tests/passiveQuota.test.ts.
 */

import type { AuthFileItem } from '@/types';
import type { QuotaProviderType } from './providers/types';
import type { QuotaLimitSummary } from './quotaRowSummary';

export interface PassiveQuota {
  limits: QuotaLimitSummary[];
  observedAtMs: number | null;
  planType: string | null;
}

interface SignalSnapshot {
  observed_at?: unknown;
  signals?: unknown;
}

const EMPTY: PassiveQuota = { limits: [], observedAtMs: null, planType: null };

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** Header names arrive canonicalised (`Anthropic-Ratelimit-…`); compare lowercase. */
function readSnapshot(
  snapshot: unknown
): { signals: Map<string, string>; observedAtMs: number | null } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { observed_at: observedAt, signals } = snapshot as SignalSnapshot;
  if (!signals || typeof signals !== 'object') return null;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(signals as Record<string, unknown>)) {
    if (typeof value === 'string') map.set(key.toLowerCase(), value);
  }
  if (map.size === 0) return null;
  return { signals: map, observedAtMs: toMs(observedAt) };
}

/**
 * The freshest snapshot for a credential: the account-level `quota` when it has
 * signals, otherwise the newest per-model one.
 */
function latestSnapshot(file: AuthFileItem) {
  const candidates = [readSnapshot(file['quota'])];
  const models = file['model_quotas'];
  if (models && typeof models === 'object') {
    for (const snapshot of Object.values(models as Record<string, unknown>)) {
      candidates.push(readSnapshot(snapshot));
    }
  }
  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .reduce<ReturnType<typeof readSnapshot>>((best, candidate) => {
      if (!best) return candidate;
      return (candidate.observedAtMs ?? 0) > (best.observedAtMs ?? 0) ? candidate : best;
    }, null);
}

/**
 * A window whose reset instant has passed has rolled over since it was
 * observed or fetched: its usage is back to zero and the next reset is unknown
 * until the next request reports it.
 *
 * Applied for display only — the reset timeline still needs the original
 * instant as a projection anchor.
 */
export function rollOverLimits(
  limits: readonly QuotaLimitSummary[],
  now: number
): QuotaLimitSummary[] {
  return limits.map((limit) =>
    limit.resetAtMs === null || limit.resetAtMs > now
      ? limit
      : { ...limit, remaining: 100, resetAtMs: null, resetLabel: undefined }
  );
}

const CLAUDE_WINDOWS = [
  { prefix: '5h', id: 'five-hour', labelKey: 'claude_quota.five_hour', periodHours: 5 },
  { prefix: '7d', id: 'seven-day', labelKey: 'claude_quota.seven_day', periodHours: 168 },
] as const;

function readClaude(signals: Map<string, string>): QuotaLimitSummary[] {
  const limits: QuotaLimitSummary[] = [];
  for (const window of CLAUDE_WINDOWS) {
    const base = `anthropic-ratelimit-unified-${window.prefix}`;
    const utilization = toNumber(signals.get(`${base}-utilization`));
    const status = signals.get(`${base}-status`);
    if (utilization === null && status === undefined) continue;
    const resetSeconds = toNumber(signals.get(`${base}-reset`));
    limits.push({
      id: window.id,
      label: window.id,
      labelKey: window.labelKey,
      remaining:
        status === 'rejected'
          ? 0
          : utilization === null
            ? null
            : clampPercent(Math.round((1 - utilization) * 100)),
      resetAtMs: resetSeconds === null ? null : resetSeconds * 1000,
      periodHours: window.periodHours,
      primary: true,
    });
  }
  return limits;
}

const MONTH_MINUTES = 28 * 24 * 60;

function readCodexWindow(
  signals: Map<string, string>,
  slot: 'primary' | 'secondary'
): QuotaLimitSummary | null {
  const base = `x-codex-${slot}`;
  const used = toNumber(signals.get(`${base}-used-percent`));
  if (used === null) return null;
  const minutes = toNumber(signals.get(`${base}-window-minutes`));
  const resetSeconds = toNumber(signals.get(`${base}-reset-at`));
  const meta =
    minutes !== null && minutes <= 24 * 60
      ? { id: 'five-hour', labelKey: 'codex_quota.primary_window' }
      : minutes !== null && minutes >= MONTH_MINUTES
        ? { id: 'monthly', labelKey: 'codex_quota.team_secondary_window' }
        : slot === 'primary'
          ? { id: 'five-hour', labelKey: 'codex_quota.primary_window' }
          : { id: 'weekly', labelKey: 'codex_quota.secondary_window' };
  return {
    ...meta,
    label: meta.id,
    remaining: clampPercent(100 - used),
    resetAtMs: resetSeconds === null ? null : resetSeconds * 1000,
    periodHours: minutes === null ? null : minutes / 60,
    primary: true,
  };
}

function readCodex(signals: Map<string, string>): QuotaLimitSummary[] {
  return [readCodexWindow(signals, 'primary'), readCodexWindow(signals, 'secondary')].filter(
    (limit): limit is QuotaLimitSummary => limit !== null
  );
}

/** Live account-level windows for a credential, from the proxy's passive observation. */
export function readPassiveQuota(provider: QuotaProviderType, file: AuthFileItem): PassiveQuota {
  if (provider !== 'claude' && provider !== 'codex') return EMPTY;
  const snapshot = latestSnapshot(file);
  if (!snapshot) return EMPTY;

  const limits = (provider === 'claude' ? readClaude : readCodex)(snapshot.signals);
  const planType =
    provider === 'codex' ? (snapshot.signals.get('x-codex-plan-type') ?? null) : null;
  return { limits, observedAtMs: snapshot.observedAtMs, planType };
}

/**
 * Overlay live windows onto an actively fetched set. Whichever source is newer
 * wins a window both report: the passive one normally (it updates on every
 * proxied request), the fetched one when the user refreshed after the proxy
 * last saw the account — usage on claude.ai / ChatGPT or a manual weekly reset
 * never passes through the proxy, and a credential in cooldown gets no traffic
 * to refresh its headers. Windows only one side reports are always kept.
 */
export function mergeQuotaLimits(
  fetched: readonly QuotaLimitSummary[],
  live: readonly QuotaLimitSummary[],
  freshness: { fetchedAtMs?: number | null; liveObservedAtMs?: number | null } = {}
): QuotaLimitSummary[] {
  const { fetchedAtMs = null, liveObservedAtMs = null } = freshness;
  const fetchedIsNewer =
    fetchedAtMs !== null && (liveObservedAtMs === null || fetchedAtMs > liveObservedAtMs);
  const liveById = new Map(live.map((limit) => [limit.id, limit]));
  const merged = fetched.map((limit) => {
    const replacement = liveById.get(limit.id);
    if (!replacement) return limit;
    liveById.delete(limit.id);
    if (fetchedIsNewer) return limit;
    // Keep the fetched label (it may carry provider-specific params).
    return {
      ...replacement,
      label: limit.label,
      labelKey: limit.labelKey ?? replacement.labelKey,
      labelParams: limit.labelParams,
    };
  });
  return [...liveById.values(), ...merged];
}

/**
 * The proxy keeps routing around a credential until its cooldown expires,
 * even after the quota came back early (a manual reset). True when a fetch
 * newer than the proxy's last observation shows every primary window usable
 * while the proxy still holds the credential in cooldown.
 */
export function shouldClearStaleCooldown(
  file: AuthFileItem,
  limits: readonly QuotaLimitSummary[],
  fetchedAtMs: number | null | undefined,
  liveObservedAtMs: number | null,
  now: number
): boolean {
  if (file.disabled || !fetchedAtMs) return false;
  if (liveObservedAtMs !== null && fetchedAtMs <= liveObservedAtMs) return false;
  const retryAt = toMs(file['next_retry_after']);
  if (retryAt === null || retryAt <= now) return false;
  const primary = limits.filter((limit) => limit.primary);
  return primary.length > 0 && primary.every((limit) => (limit.remaining ?? 0) > 0);
}
