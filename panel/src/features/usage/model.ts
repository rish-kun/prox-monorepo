/**
 * Usage page model. React-free; consumed by tests/usageModel.test.ts.
 *
 * Rows arrive bucketed by the proxy (hour or local day). Here they are priced,
 * summed into totals, grouped by provider / account / model, and spread over
 * a gap-free bucket grid for the chart.
 *
 * Cost is only ever summed over priced rows; tokens of unpriced models are
 * tracked separately so the UI can say "partial" instead of pretending $0.
 */

import type { UsageAccount, UsageBucket, UsageSummaryRow } from '@/services/api/usage';
import type { AuthFileItem } from '@/types';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { niceCeil } from '@/features/dashboard/utils';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { createPriceResolver, rowCost, type PriceTable } from './pricing';

export const HOUR_SECONDS = 3_600;
export const DAY_SECONDS = 86_400;
/** Safety cap for the chart grid ("All" over years of day buckets). */
export const MAX_BUCKETS = 2_000;

/* ---------- ranges ---------- */

export const USAGE_RANGES = ['24h', '7d', '30d', '90d', 'all'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

const RANGE_DAYS: Record<Exclude<UsageRange, '24h' | 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export interface RangeQuery {
  from: number;
  to: number;
  bucket: UsageBucket;
  tzOffsetMinutes: number;
}

/** Minutes east of UTC for the browser's zone at `nowMs`. */
export const localTzOffsetMinutes = (nowMs: number): number => -new Date(nowMs).getTimezoneOffset();

const stepOf = (bucket: UsageBucket): number => (bucket === 'day' ? DAY_SECONDS : HOUR_SECONDS);

/** Start of the bucket containing `ts` (unix seconds); day buckets start at local midnight. */
export function alignBucketStart(ts: number, bucket: UsageBucket, tzOffsetMinutes: number): number {
  if (bucket === 'hour') return Math.floor(ts / HOUR_SECONDS) * HOUR_SECONDS;
  const shift = tzOffsetMinutes * 60;
  return Math.floor((ts + shift) / DAY_SECONDS) * DAY_SECONDS - shift;
}

/**
 * Query window for a range: 24 hour buckets ending with the current hour, or
 * N local days ending today. `to` is the end of the current bucket. "All"
 * starts at 0; the grid later starts at the first recorded bucket.
 */
export function rangeQuery(range: UsageRange, nowMs: number, tzOffsetMinutes: number): RangeQuery {
  const nowSec = Math.floor(nowMs / 1000);
  const bucket: UsageBucket = range === '24h' ? 'hour' : 'day';
  const step = stepOf(bucket);
  const current = alignBucketStart(nowSec, bucket, tzOffsetMinutes);
  const to = current + step;
  if (range === 'all') return { from: 0, to, bucket, tzOffsetMinutes };
  const count = range === '24h' ? 24 : RANGE_DAYS[range];
  return { from: current - (count - 1) * step, to, bucket, tzOffsetMinutes };
}

/* ---------- totals ---------- */

export interface UsageTotals {
  requests: number;
  failed: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  unclassified: number;
  /** input + cache read + cache write + output + unclassified (reasoning is inside output). */
  total: number;
  /** USD over priced rows only. */
  cost: number;
  pricedTokens: number;
  unpricedTokens: number;
}

/** full: everything priced · partial: some tokens unpriced · none: nothing priced. */
export type CostState = 'full' | 'partial' | 'none';

export interface PricedRow extends UsageSummaryRow {
  total: number;
  /** null = no price for this model. */
  cost: number | null;
  priceKey: string | null;
}

export const emptyTotals = (): UsageTotals => ({
  requests: 0,
  failed: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  unclassified: 0,
  total: 0,
  cost: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
});

export const rowTokenTotal = (row: UsageSummaryRow): number =>
  row.inputTokens +
  row.cacheReadTokens +
  row.cacheWriteTokens +
  row.outputTokens +
  row.unclassifiedTokens;

export function priceRows(rows: readonly UsageSummaryRow[], table: PriceTable): PricedRow[] {
  const resolve = createPriceResolver(table);
  return rows.map((row) => {
    const match = resolve(row.model);
    return {
      ...row,
      total: rowTokenTotal(row),
      cost: match ? rowCost(row, match.price) : null,
      priceKey: match?.key ?? null,
    };
  });
}

export function addRow(totals: UsageTotals, row: PricedRow): UsageTotals {
  totals.requests += row.requests;
  totals.failed += row.failed;
  totals.input += row.inputTokens;
  totals.cacheRead += row.cacheReadTokens;
  totals.cacheWrite += row.cacheWriteTokens;
  totals.output += row.outputTokens;
  totals.reasoning += row.reasoningTokens;
  totals.unclassified += row.unclassifiedTokens;
  totals.total += row.total;
  if (row.cost === null) {
    totals.unpricedTokens += row.total;
  } else {
    totals.cost += row.cost;
    totals.pricedTokens += row.total;
  }
  return totals;
}

export const sumRows = (rows: readonly PricedRow[]): UsageTotals =>
  rows.reduce(addRow, emptyTotals());

export function costState(totals: UsageTotals): CostState {
  if (totals.unpricedTokens === 0) return 'full';
  return totals.pricedTokens > 0 ? 'partial' : 'none';
}

/* ---------- groups ---------- */

export interface UsageGroup {
  key: string;
  totals: UsageTotals;
}

export interface ProviderGroup extends UsageGroup {
  provider: string;
}

export interface AccountGroup extends UsageGroup {
  provider: string;
  authIndex: string;
}

export interface ProviderAccounts extends ProviderGroup {
  accounts: AccountGroup[];
}

export interface ModelGroup extends UsageGroup {
  model: string;
  /** Matched price table key; null when unpriced. */
  priceKey: string | null;
}

function groupRows<G extends UsageGroup>(
  rows: readonly PricedRow[],
  keyOf: (row: PricedRow) => string,
  create: (row: PricedRow, key: string) => G
): G[] {
  const groups = new Map<string, G>();
  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);
    if (!group) {
      group = create(row, key);
      groups.set(key, group);
    }
    addRow(group.totals, row);
  }
  return [...groups.values()];
}

export const groupByProvider = (rows: readonly PricedRow[]): ProviderGroup[] =>
  groupRows(
    rows,
    (row) => row.provider,
    (row, key) => ({ key, provider: row.provider, totals: emptyTotals() })
  );

export const groupByModel = (rows: readonly PricedRow[]): ModelGroup[] =>
  groupRows(
    rows,
    (row) => row.model,
    (row, key) => ({ key, model: row.model, priceKey: row.priceKey, totals: emptyTotals() })
  );

/** Accounts nested under their provider; both levels sorted the same way. */
export function groupByAccount(
  rows: readonly PricedRow[],
  sort: UsageSort = DEFAULT_SORT
): ProviderAccounts[] {
  const providers = groupByProvider(rows);
  const accounts = groupRows(
    rows,
    (row) => `${row.provider}\n${row.authIndex}`,
    (row, key) => ({
      key,
      provider: row.provider,
      authIndex: row.authIndex,
      totals: emptyTotals(),
    })
  );
  return sortGroups(providers, sort).map((provider) => ({
    ...provider,
    accounts: sortGroups(
      accounts.filter((account) => account.provider === provider.provider),
      sort
    ),
  }));
}

/* ---------- sorting ---------- */

export const SORT_KEYS = [
  'requests',
  'input',
  'cacheRead',
  'cacheWrite',
  'output',
  'total',
  'cost',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface UsageSort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: UsageSort = { key: 'cost', dir: 'desc' };

/**
 * Cost of a fully unpriced group sorts below every priced group (it is
 * unknown, not zero); ties fall back to total tokens, then key.
 */
function sortValue(totals: UsageTotals, key: SortKey): number {
  if (key === 'cost') return costState(totals) === 'none' ? -1 : totals.cost;
  return totals[key];
}

export function sortGroups<G extends UsageGroup>(groups: readonly G[], sort: UsageSort): G[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...groups].sort((left, right) => {
    const primary = sortValue(left.totals, sort.key) - sortValue(right.totals, sort.key);
    if (primary !== 0) return primary * sign;
    const byTotal = right.totals.total - left.totals.total;
    if (byTotal !== 0) return byTotal;
    return left.key.localeCompare(right.key);
  });
}

/* ---------- chart buckets ---------- */

export interface ChartBucket {
  start: number;
  totals: UsageTotals;
}

/**
 * Gap-free grid of bucket starts covering [from, to). For "All" (from = 0)
 * the grid starts at the first recorded bucket instead. Capped at
 * MAX_BUCKETS, keeping the newest.
 */
export function bucketGrid(
  query: RangeQuery,
  firstSeen: number | null
): { starts: number[]; step: number } {
  const step = stepOf(query.bucket);
  let from = query.from;
  if (from <= 0) {
    if (firstSeen === null) return { starts: [], step };
    from = firstSeen;
  }
  const first = alignBucketStart(from, query.bucket, query.tzOffsetMinutes);
  const end = query.to;
  const count = Math.max(0, Math.ceil((end - first) / step));
  const kept = Math.min(count, MAX_BUCKETS);
  const offset = count - kept;
  return {
    starts: Array.from({ length: kept }, (_, index) => first + (offset + index) * step),
    step,
  };
}

/** Rows spread over the grid; empty buckets are kept so the chart has no gaps. */
export function fillBuckets(
  rows: readonly PricedRow[],
  query: RangeQuery,
  firstRecordedAt: number | null
): ChartBucket[] {
  const firstRow = rows.reduce<number | null>(
    (min, row) => (min === null || row.start < min ? row.start : min),
    null
  );
  const firstSeen =
    firstRow === null
      ? firstRecordedAt
      : firstRecordedAt === null
        ? firstRow
        : Math.min(firstRow, firstRecordedAt);
  const { starts, step } = bucketGrid(query, firstSeen);
  const buckets = starts.map((start) => ({ start, totals: emptyTotals() }));
  if (buckets.length === 0) return buckets;
  const origin = starts[0];
  for (const row of rows) {
    const index = Math.floor((row.start - origin) / step);
    const bucket = buckets[index];
    if (bucket) addRow(bucket.totals, row);
  }
  return buckets;
}

/** Axis ceiling with each gridline on a readable step; fractional for cost. */
export function chartScaleMax(peak: number, intervals: number, integer: boolean): number {
  if (peak <= 0 || intervals <= 0) return integer ? Math.max(1, intervals) : 0.01 * intervals;
  const raw = niceCeil(peak / intervals);
  const step = integer ? Math.max(1, Math.ceil(raw)) : raw;
  return step * intervals;
}

/* ---------- account names ---------- */

export interface AccountName {
  name: string;
  /** Rendered in mono (file name or masked index rather than an identity). */
  mono: boolean;
}

/** auth_index → display name from the live credential list. Never the `account` field. */
export function liveAccountNames(files: readonly AuthFileItem[]): Map<string, AccountName> {
  const out = new Map<string, AccountName>();
  for (const file of files) {
    const index = normalizeAuthIndex(file.authIndex ?? file['auth_index']);
    if (!index) continue;
    const identity = deriveAuthFileIdentity(file);
    const name = identity.primary || identity.fullName;
    if (name) out.set(index, { name, mono: identity.kind === 'fileName' });
  }
  return out;
}

export const maskAuthIndex = (authIndex: string): string =>
  authIndex.length <= 8 ? `#${authIndex}` : `#${authIndex.slice(0, 6)}…`;

/**
 * Live credential → recorded OAuth label → short masked index. Empty index
 * returns null so the caller can localise "unattributed".
 */
export function resolveAccountName(
  authIndex: string,
  live: ReadonlyMap<string, AccountName>,
  recorded: Readonly<Record<string, UsageAccount>>
): AccountName | null {
  if (!authIndex) return null;
  const current = live.get(authIndex);
  if (current) return current;
  const label = recorded[authIndex]?.label;
  if (label) return { name: label, mono: false };
  return { name: maskAuthIndex(authIndex), mono: true };
}

/* ---------- formatting ---------- */

const usdFormatters = new Map<string, Intl.NumberFormat>();

function usdFormatter(locale: string | undefined, minDigits: number, maxDigits = minDigits) {
  const cacheKey = `${locale ?? ''}|${minDigits}|${maxDigits}`;
  let formatter = usdFormatters.get(cacheKey);
  if (!formatter) {
    const options: Intl.NumberFormatOptions = {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    };
    try {
      formatter = new Intl.NumberFormat(locale, options);
    } catch {
      formatter = new Intl.NumberFormat('en-US', options);
    }
    usdFormatters.set(cacheKey, formatter);
  }
  return formatter;
}

/** $0 · <$0.01 · $12.34 · $1,234 — cents only while they matter. */
export function formatUsd(value: number, locale?: string): string {
  if (!Number.isFinite(value) || value <= 0) return usdFormatter(locale, 0).format(0);
  if (value < 0.01) return `<${usdFormatter(locale, 2).format(0.01)}`;
  return usdFormatter(locale, value >= 1000 ? 0 : 2).format(value);
}

/** Axis labels: as few digits as the tick needs ($0.05, $1.5, $20). */
export function formatUsdTick(value: number, locale?: string): string {
  if (!Number.isFinite(value) || value <= 0) return usdFormatter(locale, 0).format(0);
  const digits = value >= 10 ? 0 : value >= 1 ? 1 : value >= 0.1 ? 2 : 3;
  return usdFormatter(locale, 0, digits).format(value);
}
