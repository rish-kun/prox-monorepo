/**
 * Dashboard model: pure functions, no React, no clock of their own.
 *
 * Every figure here comes from local Management API reads — the credential
 * list (`/credentials`, which carries each credential's 20 × 10-minute request
 * buckets and the proxy's passive quota observations), config-backed API-key
 * usage (`/observability/usage/api-keys`) and the tail of the request log.
 * Nothing here ever triggers an upstream provider request.
 *
 * Window totals (sums of buckets) and lifetime counters (the backend's
 * `success`/`failed`, reset when the proxy restarts) are kept strictly apart:
 * they cover different spans and must never be added together.
 *
 * Consumed by DashboardPage and tests/dashboardModel.test.ts.
 */

import type { AuthFileItem } from '@/types';
import { maskApiKey } from '@/utils/format';
import {
  mergeRecentRequestBucketGroups,
  normalizeRecentRequestBuckets,
  normalizeUsageTotal,
  type RecentRequestBucket,
  type RecentRequestUsageEntry,
} from '@/utils/recentRequests';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import {
  getAuthFileStatusMessage,
  isProblemAuthFile,
  summarizeAuthFileStatusMessage,
} from '@/features/authFiles/constants';
import { readPassiveQuota, rollOverLimits } from '@/features/quota/passiveQuota';
import {
  orderQuotaLimits,
  resolveQuotaRowStatus,
  type QuotaLimitSummary,
} from '@/features/quota/quotaRowSummary';
import { parseLogLine } from '@/features/logs/model/logParsing';

/** Each backend bucket spans 10 minutes; the backend keeps 20 of them (3h20m). */
export const BUCKET_MINUTES = 10;
/** The last hour is the newest six buckets. */
export const HOUR_BUCKETS = 60 / BUCKET_MINUTES;
/** Buckets the backend keeps per credential. */
export const WINDOW_BUCKETS = 20;

/* ------------------------------------------------------------------ */
/* Window sums                                                        */
/* ------------------------------------------------------------------ */

export interface BucketTotals {
  success: number;
  failure: number;
  total: number;
}

/** Sum the newest `lastN` buckets (all of them when omitted). */
export function sumBuckets(buckets: readonly RecentRequestBucket[], lastN?: number): BucketTotals {
  const slice = lastN === undefined ? buckets : lastN <= 0 ? [] : buckets.slice(-lastN);
  let success = 0;
  let failure = 0;
  for (const bucket of slice) {
    success += bucket.success;
    failure += bucket.failed;
  }
  return { success, failure, total: success + failure };
}

/** 0–100, or null when nothing was requested. */
export function successRateOf(totals: BucketTotals): number | null {
  return totals.total > 0 ? (totals.success / totals.total) * 100 : null;
}

/**
 * Buckets since the newest non-empty one: 0 = the current (partial) bucket,
 * 1 = the one before it, …; null when the whole window is empty.
 */
export function lastUsedBucketsAgo(buckets: readonly RecentRequestBucket[]): number | null {
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    const bucket = buckets[index];
    if (bucket.success + bucket.failed > 0) return buckets.length - 1 - index;
  }
  return null;
}

export interface TrafficSummary {
  /** Merged buckets, oldest first; the last one is the current bucket. */
  buckets: RecentRequestBucket[];
  window: BucketTotals;
  lastHour: BucketTotals;
  successRate: number | null;
  /** Busiest single bucket in the window. */
  peak: number;
  /** The current (newest) bucket. */
  current: number;
  windowMinutes: number;
}

export function summarizeTraffic(groups: RecentRequestBucket[][]): TrafficSummary {
  const buckets = mergeRecentRequestBucketGroups(groups);
  const window = sumBuckets(buckets);
  const totals = buckets.map((bucket) => bucket.success + bucket.failed);
  return {
    buckets,
    window,
    lastHour: sumBuckets(buckets, HOUR_BUCKETS),
    successRate: successRateOf(window),
    peak: totals.length > 0 ? Math.max(...totals) : 0,
    current: totals.length > 0 ? totals[totals.length - 1] : 0,
    windowMinutes: buckets.length * BUCKET_MINUTES,
  };
}

/* ------------------------------------------------------------------ */
/* Credential rows                                                    */
/* ------------------------------------------------------------------ */

/** What the Status cell says. `ok` renders nothing. */
export type CredentialStatus =
  | { kind: 'ok' }
  | { kind: 'disabled' }
  /** A primary quota window is at 0%; `backAtMs` is when all exhausted ones reset. */
  | { kind: 'exhausted'; backAtMs: number | null }
  | { kind: 'cooldown'; seconds: number; credentialWide: boolean; models: number }
  | { kind: 'error'; message: string; httpStatus?: number };

export interface CredentialRow {
  key: string;
  source: 'credential' | 'api-key';
  /** Normalised provider id (`claude`, `codex`, …; `unknown` when absent). */
  provider: string;
  /** Primary identity (email, project, file name, or a masked API key). */
  name: string;
  /** Mono when the identity is a file name or key rather than an account. */
  mono: boolean;
  /** Hover text: the full file name or the API base URL. */
  title: string;
  buckets: RecentRequestBucket[];
  window: BucketTotals;
  lastUsedBucketsAgo: number | null;
  /** Requests counted since the proxy last restarted — never mixed with `window`. */
  lifetime: number;
  fiveHour: QuotaLimitSummary | null;
  weekly: QuotaLimitSummary | null;
  status: CredentialStatus;
}

export type ApiKeyUsage = ReadonlyMap<string, ReadonlyMap<string, RecentRequestUsageEntry>>;

const providerOf = (file: AuthFileItem): string => {
  const raw = String(file.type ?? file.provider ?? '')
    .trim()
    .toLowerCase();
  return raw && raw !== 'empty' ? raw : 'unknown';
};

const isDisabledFile = (file: AuthFileItem): boolean =>
  file.disabled === true ||
  (typeof file.status === 'string' && file.status.trim().toLowerCase() === 'disabled');

/** Live account-level windows from passive observations (Claude and Codex report them). */
export function liveQuotaLimits(file: AuthFileItem, nowMs: number): QuotaLimitSummary[] {
  const provider = providerOf(file);
  if (provider !== 'claude' && provider !== 'codex') return [];
  return orderQuotaLimits(rollOverLimits(readPassiveQuota(provider, file).limits, nowMs));
}

const WEEKLY_IDS = new Set(['seven-day', 'weekly']);

export function pickQuotaWindows(limits: readonly QuotaLimitSummary[]): {
  fiveHour: QuotaLimitSummary | null;
  weekly: QuotaLimitSummary | null;
} {
  return {
    fiveHour: limits.find((limit) => limit.id === 'five-hour') ?? null,
    weekly: limits.find((limit) => WEEKLY_IDS.has(limit.id)) ?? null,
  };
}

/**
 * Status precedence: disabled → exhausted → active cooldown → reported error →
 * healthy. A healthy credential says nothing.
 */
export function resolveCredentialStatus(
  file: AuthFileItem,
  limits: readonly QuotaLimitSummary[],
  nowMs: number
): CredentialStatus {
  const quotaStatus = resolveQuotaRowStatus(undefined, isDisabledFile(file), limits);
  if (quotaStatus.kind === 'disabled') return { kind: 'disabled' };
  if (quotaStatus.kind === 'exhausted') {
    return { kind: 'exhausted', backAtMs: quotaStatus.backAtMs };
  }

  const snapshot = file.cooldownSnapshot;
  const records = snapshot?.records ?? [];
  if (snapshot && records.length > 0) {
    const { rows, credentialWide, modelCount } = summarizeCooldowns(snapshot, nowMs);
    const active = rows.filter((row) => row.remainingSeconds > 0);
    if (active.length > 0) {
      const relevant = credentialWide
        ? active.filter((row) => row.record.scope === 'credential')
        : active;
      return {
        kind: 'cooldown',
        seconds: Math.min(...relevant.map((row) => row.remainingSeconds)),
        credentialWide,
        models: modelCount,
      };
    }
  }

  if (isProblemAuthFile(file)) {
    const httpStatus = records.find((record) => record.httpStatus !== undefined)?.httpStatus;
    return {
      kind: 'error',
      message: summarizeAuthFileStatusMessage(getAuthFileStatusMessage(file)),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  }
  return { kind: 'ok' };
}

/** A credential the router can pick right now (a per-model cooldown leaves the rest usable). */
export function isUsableStatus(status: CredentialStatus): boolean {
  return status.kind === 'ok' || (status.kind === 'cooldown' && !status.credentialWide);
}

const bucketsOf = (file: AuthFileItem): RecentRequestBucket[] =>
  file.recentRequests && file.recentRequests.length > 0
    ? file.recentRequests
    : normalizeRecentRequestBuckets(file.recent_requests);

function credentialRow(file: AuthFileItem, nowMs: number): CredentialRow {
  const identity = deriveAuthFileIdentity(file);
  const buckets = bucketsOf(file);
  const limits = liveQuotaLimits(file, nowMs);
  const lifetime =
    (file.successCount ?? normalizeUsageTotal(file.success)) +
    (file.failureCount ?? normalizeUsageTotal(file.failed));
  return {
    key: `file:${identity.fullName}:${String(file.authIndex ?? '')}`,
    source: 'credential',
    provider: providerOf(file),
    name: identity.primary || identity.fullName,
    mono: identity.kind === 'fileName',
    title: identity.fullName,
    buckets,
    window: sumBuckets(buckets),
    lastUsedBucketsAgo: lastUsedBucketsAgo(buckets),
    lifetime,
    ...pickQuotaWindows(limits),
    status: resolveCredentialStatus(file, limits, nowMs),
  };
}

/** `api-key-usage` keys are `<baseUrl>|<apiKey>`. */
export function splitCompositeKey(compositeKey: string): { baseUrl: string; apiKey: string } {
  const separator = compositeKey.indexOf('|');
  if (separator < 0) return { baseUrl: '', apiKey: compositeKey.trim() };
  return {
    baseUrl: compositeKey.slice(0, separator).trim(),
    apiKey: compositeKey.slice(separator + 1).trim(),
  };
}

const hostOf = (baseUrl: string): string => {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
};

/**
 * One row per credential: every listed credential, plus config-backed API keys
 * that only `api-key-usage` reports. A key the credential list already carries
 * (`account_type: api_key`) keeps its credential row — richer status — and its
 * usage entry is dropped so traffic is never counted twice.
 *
 * The raw API key is only used for that match; rows carry a masked form.
 */
export function buildCredentialRows(
  files: readonly AuthFileItem[],
  apiKeyUsage: ApiKeyUsage,
  nowMs: number
): CredentialRow[] {
  const listedKeys = new Set<string>();
  for (const file of files) {
    const accountType = String(file['account_type'] ?? '')
      .trim()
      .toLowerCase();
    const account = String(file['account'] ?? '').trim();
    if (accountType === 'api_key' && account) listedKeys.add(account);
  }

  const rows = files.map((file) => credentialRow(file, nowMs));

  apiKeyUsage.forEach((entries, provider) => {
    let index = 0;
    entries.forEach((entry, compositeKey) => {
      const { baseUrl, apiKey } = splitCompositeKey(compositeKey);
      if (!apiKey || listedKeys.has(apiKey)) return;
      const masked = maskApiKey(apiKey);
      const host = hostOf(baseUrl);
      const buckets = normalizeRecentRequestBuckets(entry.recentRequests);
      rows.push({
        key: `key:${provider}:${host}:${masked}:${index}`,
        source: 'api-key',
        provider: provider || 'unknown',
        name: host ? `${masked} · ${host}` : masked,
        mono: true,
        title: baseUrl || masked,
        buckets,
        window: sumBuckets(buckets),
        lastUsedBucketsAgo: lastUsedBucketsAgo(buckets),
        lifetime: entry.success + entry.failed,
        fiveHour: null,
        weekly: null,
        status: { kind: 'ok' },
      });
      index += 1;
    });
  });

  return sortCredentialRows(rows);
}

const statusRank = (status: CredentialStatus): number =>
  status.kind === 'disabled' ? 2 : status.kind === 'ok' ? 1 : 0;

/** Problems first, then busiest first; disabled credentials sink to the bottom. */
export function sortCredentialRows(rows: readonly CredentialRow[]): CredentialRow[] {
  return [...rows].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      b.window.total - a.window.total ||
      b.window.failure - a.window.failure ||
      a.name.localeCompare(b.name)
  );
}

export interface CredentialCounts {
  total: number;
  usable: number;
}

export function countCredentials(rows: readonly CredentialRow[]): CredentialCounts {
  return {
    total: rows.length,
    usable: rows.filter((row) => isUsableStatus(row.status)).length,
  };
}

/** Requests since the proxy last restarted, across every row. Not a window figure. */
export function lifetimeTotal(rows: readonly CredentialRow[]): number {
  return rows.reduce((sum, row) => sum + row.lifetime, 0);
}

/* ------------------------------------------------------------------ */
/* Recent errors                                                      */
/* ------------------------------------------------------------------ */

export interface ErrorLogEntry {
  key: string;
  /** Time of day (`HH:MM:SS`) when the line carries a timestamp. */
  time: string;
  status: number;
  method: string;
  /** Request path without its query string (it can carry `?key=` secrets). */
  path: string;
  latency: string | null;
}

/**
 * Only model traffic counts: the proxy's inference API lives under /v1 and
 * /v1beta. That excludes the dashboard's own Management API calls and
 * health probes such as `HEAD /api/hello` (404 on every poll).
 */
const MODEL_TRAFFIC_PATH = /^\/v1(?:beta)?(?:\/|$)/;

/**
 * The newest `limit` model-traffic request lines with an HTTP status ≥ 400, newest first.
 * Lines without a method and path (plain log messages that merely mention a
 * code) are ignored.
 */
export function recentErrorLines(lines: readonly string[], limit = 8): ErrorLogEntry[] {
  const entries: ErrorLogEntry[] = [];
  for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const parsed = parseLogLine(lines[index]);
    if (parsed.statusCode === undefined || parsed.statusCode < 400) continue;
    if (!parsed.method || !parsed.path) continue;
    const path = parsed.path.split('?')[0] || '/';
    if (!MODEL_TRAFFIC_PATH.test(path)) continue;
    const timestamp = parsed.timestamp ?? '';
    entries.push({
      key: `${index}:${timestamp}:${parsed.requestId ?? ''}`,
      time: timestamp.includes(' ') ? timestamp.slice(timestamp.indexOf(' ') + 1) : timestamp,
      status: parsed.statusCode,
      method: parsed.method,
      path,
      latency: parsed.latency ?? null,
    });
  }
  return entries;
}
