/**
 * Token usage summary (`GET /usage/summary`).
 *
 * The proxy aggregates every generate call into hourly rows keyed by
 * (hour, provider, auth_index, model, prompt_tier) and merges them into hour
 * or day buckets on read. Field names are normalised here; the UI never sees
 * the snake_case payload.
 */

import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

export const USAGE_SUMMARY_PATH = '/usage/summary';

export type UsageBucket = 'hour' | 'day';

/** 0 = prompt ≤ 100K, 1 = ≤ 272K, 2 = > 272K (per request, before aggregation). */
export type PromptTier = 0 | 1 | 2;

export interface UsageSummaryRow {
  /** Bucket start, unix seconds. */
  start: number;
  provider: string;
  authIndex: string;
  model: string;
  promptTier: PromptTier;
  requests: number;
  failed: number;
  /** Uncached input only. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** All output, reasoning included. */
  outputTokens: number;
  /** Subset of output. */
  reasoningTokens: number;
  unclassifiedTokens: number;
}

export interface UsageAccount {
  provider: string;
  /** OAuth account label (e-mail); never an API key. */
  label: string;
}

export interface UsageSummary {
  from: number;
  to: number;
  bucket: UsageBucket;
  tzOffsetMinutes: number;
  /** Unix seconds of the first recorded request; null before anything was recorded. */
  firstRecordedAt: number | null;
  rows: UsageSummaryRow[];
  accounts: Record<string, UsageAccount>;
}

export interface UsageSummaryQuery {
  from?: number;
  to?: number;
  bucket?: UsageBucket;
  tzOffsetMinutes?: number;
}

const readInt = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed)
    ? Math.max(0, Math.trunc(parsed))
    : 0;
};

const readSignedInt = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const readText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

const readTier = (value: unknown): PromptTier => {
  const tier = readInt(value);
  return tier >= 2 ? 2 : tier === 1 ? 1 : 0;
};

function normalizeRow(raw: unknown): UsageSummaryRow | null {
  if (!isRecord(raw)) return null;
  const start = readInt(raw.start);
  if (!start) return null;
  return {
    start,
    provider: readText(raw.provider).toLowerCase() || 'unknown',
    authIndex: readText(raw.auth_index),
    model: readText(raw.model) || 'unknown',
    promptTier: readTier(raw.prompt_tier),
    requests: readInt(raw.requests),
    failed: readInt(raw.failed),
    inputTokens: readInt(raw.input_tokens),
    cacheReadTokens: readInt(raw.cache_read_tokens),
    cacheWriteTokens: readInt(raw.cache_write_tokens),
    outputTokens: readInt(raw.output_tokens),
    reasoningTokens: readInt(raw.reasoning_tokens),
    unclassifiedTokens: readInt(raw.unclassified_tokens),
  };
}

function normalizeAccounts(raw: unknown): Record<string, UsageAccount> {
  if (!isRecord(raw)) return {};
  const out: Record<string, UsageAccount> = {};
  for (const [index, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    out[index] = {
      provider: readText(value.provider).toLowerCase(),
      label: readText(value.label),
    };
  }
  return out;
}

export function normalizeUsageSummary(raw: unknown): UsageSummary {
  const body = isRecord(raw) ? raw : {};
  const rows = Array.isArray(body.rows)
    ? body.rows.map(normalizeRow).filter((row): row is UsageSummaryRow => row !== null)
    : [];
  rows.sort((left, right) => left.start - right.start);
  const firstRecordedAt = readInt(body.first_recorded_at);
  return {
    from: readInt(body.from),
    to: readInt(body.to),
    bucket: body.bucket === 'day' ? 'day' : 'hour',
    tzOffsetMinutes: readSignedInt(body.tz_offset_minutes),
    firstRecordedAt: firstRecordedAt > 0 ? firstRecordedAt : null,
    rows,
    accounts: normalizeAccounts(body.accounts),
  };
}

export const usageApi = {
  async summary(query: UsageSummaryQuery = {}): Promise<UsageSummary> {
    const params: Record<string, string | number> = {};
    if (query.from !== undefined) params.from = Math.floor(query.from);
    if (query.to !== undefined) params.to = Math.floor(query.to);
    if (query.bucket) params.bucket = query.bucket;
    if (query.tzOffsetMinutes !== undefined) {
      params.tz_offset_minutes = Math.round(query.tzOffsetMinutes);
    }
    const payload = await apiClient.get<unknown>(USAGE_SUMMARY_PATH, { params });
    return normalizeUsageSummary(payload);
  },
};
