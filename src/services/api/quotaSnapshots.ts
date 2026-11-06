/**
 * Proxy-owned quota polling for Claude and Codex (`/quota/*`).
 *
 * The proxy is the only caller of the upstream usage endpoints: it polls each
 * account about once an hour, keeps the latest response bundle per credential
 * and records 5-hour / weekly history. The panel reads those snapshots, asks
 * the proxy to refresh (never upstream directly) and charts the history.
 *
 * Field names are normalised here; the UI never sees the snake_case payload.
 * Every field is read defensively — a missing or malformed value degrades to
 * an empty default instead of throwing.
 */

import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

export const QUOTA_SNAPSHOTS_PATH = '/quota/snapshots';
export const QUOTA_REFRESH_PATH = '/quota/refresh';
export const QUOTA_HISTORY_PATH = '/quota/history';

/** The refresh call waits for upstream fetches (three accounts at a time). */
const REFRESH_TIMEOUT_MS = 120_000;

export type ProxyQuotaProvider = 'claude' | 'codex';
export type QuotaHistoryWindow = '5h' | 'weekly';

/** One stored upstream response — the same shape `apiCallApi.request` returns, minus headers. */
export interface QuotaSnapshotResponse {
  statusCode: number;
  /** Parsed JSON when the body was JSON, the raw string otherwise, null when empty. */
  body: unknown;
  bodyText: string;
}

export interface QuotaSnapshot {
  authIndex: string;
  provider: string;
  /** Last successful fetch, epoch ms. */
  fetchedAtMs: number | null;
  /** Last attempt (successful or not), epoch ms. */
  attemptedAtMs: number | null;
  /** Named upstream responses: `usage`, `profile`, `subscription`, `reset_credits`. */
  responses: Record<string, QuotaSnapshotResponse>;
  /** Error of the last attempt; empty when it succeeded. */
  error: string;
  errorStatus: number | null;
  nextPollAtMs: number | null;
}

export interface QuotaSnapshotSet {
  pollIntervalSeconds: number;
  snapshots: Record<string, QuotaSnapshot>;
}

export interface QuotaHistorySample {
  /** Unix seconds. */
  t: number;
  authIndex: string;
  /** Percent used, 0..100. */
  used: number;
  /** Unix seconds; 0 when unknown. */
  resetsAt: number;
}

export interface QuotaHistoryAccount {
  /** OAuth e-mail / account label; empty for non-OAuth credentials. */
  label: string;
  /** Routing priority; higher is used first. */
  priority: number;
  disabled: boolean;
}

export interface QuotaHistory {
  provider: string;
  window: QuotaHistoryWindow;
  from: number;
  to: number;
  /** Unix seconds of the first recorded sample; null before anything was recorded. */
  firstRecordedAt: number | null;
  samples: QuotaHistorySample[];
  accounts: Record<string, QuotaHistoryAccount>;
}

export interface QuotaHistoryQuery {
  provider: ProxyQuotaProvider;
  window: QuotaHistoryWindow;
  from?: number;
  to?: number;
}

const readNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

const readText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

const readUnixSeconds = (value: unknown): number => {
  const parsed = readNumber(value);
  return parsed !== null && parsed > 0 ? Math.trunc(parsed) : 0;
};

/** RFC3339 (or unix seconds / ms) → epoch ms; null for missing, zero or unparsable. */
export const readInstantMs = (value: unknown): number | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return readInstantMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    // Go's zero time ("0001-01-01T00:00:00Z") means "never".
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds until the year 5138; anything larger is already milliseconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  return null;
};

const stringifyBody = (input: unknown): string => {
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
};

export function normalizeSnapshotResponse(raw: unknown): QuotaSnapshotResponse {
  const record = isRecord(raw) ? raw : {};
  const statusCode = readNumber(record.status_code ?? record.statusCode) ?? 0;
  const input = record.body;
  if (input === undefined || input === null) return { statusCode, body: null, bodyText: '' };
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { statusCode, body: null, bodyText: input };
    try {
      return { statusCode, body: JSON.parse(trimmed), bodyText: input };
    } catch {
      return { statusCode, body: input, bodyText: input };
    }
  }
  return { statusCode, body: input, bodyText: stringifyBody(input) };
}

export function normalizeSnapshot(raw: unknown, fallbackIndex = ''): QuotaSnapshot {
  const record = isRecord(raw) ? raw : {};
  const responses: Record<string, QuotaSnapshotResponse> = {};
  if (isRecord(record.responses)) {
    for (const [name, value] of Object.entries(record.responses)) {
      if (isRecord(value)) responses[name] = normalizeSnapshotResponse(value);
    }
  }
  const errorStatus = readNumber(record.error_status ?? record.errorStatus);
  return {
    authIndex: readText(record.auth_index ?? record.authIndex) || fallbackIndex,
    provider: readText(record.provider).toLowerCase(),
    fetchedAtMs: readInstantMs(record.fetched_at ?? record.fetchedAt),
    attemptedAtMs: readInstantMs(record.attempted_at ?? record.attemptedAt),
    responses,
    error: readText(record.error),
    errorStatus: errorStatus !== null && errorStatus > 0 ? Math.trunc(errorStatus) : null,
    nextPollAtMs: readInstantMs(record.next_poll_at ?? record.nextPollAt),
  };
}

function normalizeSnapshotMap(raw: unknown): Record<string, QuotaSnapshot> {
  const out: Record<string, QuotaSnapshot> = {};
  if (!isRecord(raw)) return out;
  for (const [index, value] of Object.entries(raw)) {
    out[index] = normalizeSnapshot(value, index);
  }
  return out;
}

export function normalizeSnapshotSet(raw: unknown): QuotaSnapshotSet {
  const body = isRecord(raw) ? raw : {};
  const interval = readNumber(body.poll_interval_seconds);
  return {
    pollIntervalSeconds: interval !== null && interval > 0 ? interval : 0,
    snapshots: normalizeSnapshotMap(body.snapshots),
  };
}

function normalizeSample(raw: unknown): QuotaHistorySample | null {
  if (!isRecord(raw)) return null;
  const t = readUnixSeconds(raw.t);
  const authIndex = readText(raw.auth_index ?? raw.authIndex);
  const used = readNumber(raw.used);
  if (!t || !authIndex || used === null) return null;
  return {
    t,
    authIndex,
    used: Math.min(100, Math.max(0, used)),
    resetsAt: readUnixSeconds(raw.resets_at ?? raw.resetsAt),
  };
}

function normalizeAccounts(raw: unknown): Record<string, QuotaHistoryAccount> {
  if (!isRecord(raw)) return {};
  const out: Record<string, QuotaHistoryAccount> = {};
  for (const [index, value] of Object.entries(raw)) {
    const record = isRecord(value) ? value : {};
    const priority = readNumber(record.priority);
    out[index] = {
      label: readText(record.label),
      priority: priority !== null ? Math.trunc(priority) : 0,
      disabled: record.disabled === true,
    };
  }
  return out;
}

export function normalizeQuotaHistory(raw: unknown): QuotaHistory {
  const body = isRecord(raw) ? raw : {};
  const samples = Array.isArray(body.samples)
    ? body.samples
        .map(normalizeSample)
        .filter((sample): sample is QuotaHistorySample => sample !== null)
    : [];
  samples.sort((left, right) => left.t - right.t);
  const firstRecordedAt = readUnixSeconds(body.first_recorded_at);
  return {
    provider: readText(body.provider).toLowerCase(),
    window: body.window === '5h' ? '5h' : 'weekly',
    from: readUnixSeconds(body.from),
    to: readUnixSeconds(body.to),
    firstRecordedAt: firstRecordedAt > 0 ? firstRecordedAt : null,
    samples,
    accounts: normalizeAccounts(body.accounts),
  };
}

export const quotaSnapshotsApi = {
  /** Latest stored snapshots — never triggers an upstream call. */
  async getSnapshots(provider?: ProxyQuotaProvider): Promise<QuotaSnapshotSet> {
    const payload = await apiClient.get<unknown>(QUOTA_SNAPSHOTS_PATH, {
      params: provider ? { provider } : undefined,
    });
    return normalizeSnapshotSet(payload);
  },

  /**
   * Ask the proxy to refresh these credentials (all eligible when omitted) and
   * wait for the result. Per-account failures come back inside the snapshot.
   * `force` skips the proxy's 60 s minimum interval (after a reset-credit consume).
   */
  async refresh(
    authIndexes?: readonly string[],
    options: { force?: boolean } = {}
  ): Promise<QuotaSnapshotSet> {
    const body: { auth_indexes?: string[]; force?: boolean } = {};
    if (authIndexes && authIndexes.length > 0) body.auth_indexes = [...authIndexes];
    if (options.force) body.force = true;
    const payload = await apiClient.post<unknown>(QUOTA_REFRESH_PATH, body, {
      timeout: REFRESH_TIMEOUT_MS,
    });
    return normalizeSnapshotSet(payload);
  },

  async getHistory(query: QuotaHistoryQuery): Promise<QuotaHistory> {
    const params: Record<string, string | number> = {
      provider: query.provider,
      window: query.window,
    };
    if (query.from !== undefined) params.from = Math.floor(query.from);
    if (query.to !== undefined) params.to = Math.floor(query.to);
    const payload = await apiClient.get<unknown>(QUOTA_HISTORY_PATH, { params });
    return normalizeQuotaHistory(payload);
  },
};
