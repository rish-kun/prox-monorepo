/**
 * API-equivalent pricing. React-free; consumed by tests/usagePricing.test.ts.
 *
 * Every figure is USD per 1M tokens at public Standard-tier API prices
 * (fetched 2026-10-11). The accounts behind the proxy are subscriptions, so a
 * cost computed here is "what this would have cost on the API", not a bill.
 *
 * Unmatched models are *unpriced*: they never count as $0.
 */

export interface PriceSet {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface LongContextPrice extends PriceSet {
  /** Applies to rows whose prompt_tier is at least this (1: > 100K, 2: > 272K). */
  minTier: 1 | 2;
}

export interface ModelPrice extends PriceSet {
  longContext?: LongContextPrice;
}

/** Keyed by normalised model id (exact or prefix). */
export type PriceTable = Record<string, ModelPrice>;

export const PRICE_FIELDS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

/** Spec column order: input, cache write, cache read, output. */
const p = (input: number, cacheWrite: number, cacheRead: number, output: number): PriceSet => ({
  input,
  cacheWrite,
  cacheRead,
  output,
});

const withLong = (base: PriceSet, minTier: 1 | 2, long: PriceSet): ModelPrice => ({
  ...base,
  longContext: { minTier, ...long },
});

const same = (keys: string[], price: ModelPrice): PriceTable =>
  Object.fromEntries(keys.map((key) => [key, price]));

/** Long context for OpenAI GPT-5.5+ / 5.6 / 6 = prompt > 272K. */
const OPENAI_LONG = 2;

export const DEFAULT_PRICES: PriceTable = {
  // Claude — platform.claude.com pricing, 5-minute cache-write column.
  ...same(['claude-fable-5-1', 'claude-mythos-5-1'], p(10, 12.5, 0.25, 50)),
  ...same(['claude-fable-5', 'claude-mythos-5'], p(10, 12.5, 1, 50)),
  'claude-opus-5-5': p(4, 5, 0.2, 20),
  ...same(
    ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    p(5, 6.25, 0.5, 25)
  ),
  ...same(['claude-opus-4-1', 'claude-opus-4'], p(15, 18.75, 1.5, 75)),
  'claude-sonnet-5-5': p(2, 2.5, 0.1, 10),
  'claude-sonnet-5': p(2, 2.5, 0.2, 10),
  ...same(
    ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-3-7-sonnet'],
    p(3, 3.75, 0.3, 15)
  ),
  'claude-haiku-5-5': withLong(p(0.1, 0.125, 0.01, 0.5), 1, p(0.5, 0.625, 0.05, 2.5)),
  'claude-haiku-4-5': p(1, 1.25, 0.1, 5),
  'claude-3-5-haiku': p(0.8, 1, 0.08, 4),

  // OpenAI — developers.openai.com pricing, Standard tier.
  'gpt-6-astra': withLong(p(10, 12.5, 1, 50), OPENAI_LONG, p(20, 25, 2, 75)),
  'gpt-6.1-sol': withLong(p(2, 2.5, 0.1, 10), OPENAI_LONG, p(4, 5, 0.2, 15)),
  'gpt-6-sol': withLong(p(2, 2.5, 0.2, 10), OPENAI_LONG, p(4, 5, 0.4, 15)),
  'gpt-6-luna': withLong(p(0.1, 0.125, 0.01, 0.5), OPENAI_LONG, p(0.2, 0.25, 0.02, 0.75)),
  // Promotional price through 2026-11-21.
  'gpt-5.6-sol': withLong(p(4, 5, 0.4, 20), OPENAI_LONG, p(8, 10, 0.8, 30)),
  'gpt-5.6-terra': withLong(p(2, 2.5, 0.2, 12), OPENAI_LONG, p(4, 5, 0.4, 18)),
  'gpt-5.6-luna': withLong(p(0.2, 0.25, 0.02, 1.2), OPENAI_LONG, p(0.4, 0.5, 0.04, 1.8)),
  'gpt-5.5': withLong(p(5, 5, 0.5, 30), OPENAI_LONG, p(10, 10, 1, 45)),
  ...same(['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2'], p(1.75, 1.75, 0.175, 14)),
  ...same(['gpt-5.1', 'gpt-5'], p(1.25, 1.25, 0.125, 10)),
  'gpt-5-mini': p(0.25, 0.25, 0.025, 2),
  'gpt-5-nano': p(0.05, 0.05, 0.005, 0.4),
};

const SUFFIX_PATTERNS = [
  /-thinking$/,
  /-(?:xhigh|high|medium|low|max)$/,
  /-\d{8}$/, // -YYYYMMDD snapshot date
];

/**
 * Lowercase, drop a `(...)` thinking suffix, then peel trailing `-thinking`,
 * reasoning-effort (`-high`, `-xhigh`, `-max`, …) and `-YYYYMMDD` suffixes in
 * any order until none is left.
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  id = id.replace(/\s*\([^)]*\)\s*$/, '').trim();
  let changed = true;
  while (changed && id) {
    changed = false;
    for (const pattern of SUFFIX_PATTERNS) {
      const next = id.replace(pattern, '');
      if (next !== id && next) {
        id = next;
        changed = true;
      }
    }
  }
  return id;
}

export interface PriceMatch {
  key: string;
  price: ModelPrice;
}

/**
 * Exact match on the normalised id, else the longest table key that is a
 * prefix ending on a `-` boundary (`gpt-5` covers `gpt-5-codex` but not
 * `gpt-5.4`, `claude-opus-4` does not swallow an unknown `claude-opus-40`).
 */
export function matchModelPrice(model: string, table: PriceTable): PriceMatch | null {
  const id = normalizeModelId(model);
  if (!id) return null;
  const exact = table[id];
  if (exact) return { key: id, price: exact };
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (!key || key.length >= id.length) continue;
    if (!id.startsWith(key) || id.charAt(key.length) !== '-') continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best === null ? null : { key: best, price: table[best] };
}

/** Memoised matcher for one table (the same few models repeat across many rows). */
export function createPriceResolver(table: PriceTable): (model: string) => PriceMatch | null {
  const cache = new Map<string, PriceMatch | null>();
  return (model) => {
    const hit = cache.get(model);
    if (hit !== undefined) return hit;
    const match = matchModelPrice(model, table);
    cache.set(model, match);
    return match;
  };
}

export interface CostableRow {
  promptTier: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  unclassifiedTokens: number;
}

/** Long-context prices when the row's prompt tier reaches the model's threshold. */
export function effectivePrices(price: ModelPrice, promptTier: number): PriceSet {
  return price.longContext && promptTier >= price.longContext.minTier ? price.longContext : price;
}

/**
 * USD for one row. Reasoning is part of output; unclassified tokens are billed
 * at the input price.
 */
export function rowCost(row: CostableRow, price: ModelPrice): number {
  const rates = effectivePrices(price, row.promptTier);
  return (
    (row.inputTokens * rates.input +
      row.cacheReadTokens * rates.cacheRead +
      row.cacheWriteTokens * rates.cacheWrite +
      row.outputTokens * rates.output +
      row.unclassifiedTokens * rates.input) /
    1_000_000
  );
}

/* ---------- overrides ---------- */

const isPrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function sanitizePriceSet(raw: unknown): PriceSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!PRICE_FIELDS.every((field) => isPrice(record[field]))) return null;
  return {
    input: record.input as number,
    cacheRead: record.cacheRead as number,
    cacheWrite: record.cacheWrite as number,
    output: record.output as number,
  };
}

export function sanitizeModelPrice(raw: unknown): ModelPrice | null {
  const base = sanitizePriceSet(raw);
  if (!base) return null;
  const longRaw = (raw as Record<string, unknown>).longContext;
  if (longRaw === undefined || longRaw === null) return base;
  const long = sanitizePriceSet(longRaw);
  const minTier = (longRaw as Record<string, unknown>).minTier;
  if (!long || (minTier !== 1 && minTier !== 2)) return base;
  return { ...base, longContext: { minTier, ...long } };
}

/** Drop anything malformed from stored overrides; keys are normalised. */
export function sanitizePriceOverrides(raw: unknown): PriceTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PriceTable = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = normalizeModelId(key);
    const price = sanitizeModelPrice(value);
    if (id && price) out[id] = price;
  }
  return out;
}

export function mergePrices(defaults: PriceTable, overrides: PriceTable): PriceTable {
  return { ...defaults, ...overrides };
}

const sameSet = (left: PriceSet, right: PriceSet): boolean =>
  PRICE_FIELDS.every((field) => left[field] === right[field]);

export function samePrice(left: ModelPrice, right: ModelPrice): boolean {
  if (!sameSet(left, right)) return false;
  if (!left.longContext || !right.longContext) return !left.longContext && !right.longContext;
  return left.longContext.minTier === right.longContext.minTier
    ? sameSet(left.longContext, right.longContext)
    : false;
}

/**
 * Apply one edit to the override map. An entry equal to its default is
 * removed, so overrides only ever hold real differences and custom models.
 */
export function applyPriceOverride(
  overrides: PriceTable,
  key: string,
  price: ModelPrice | null,
  defaults: PriceTable = DEFAULT_PRICES
): PriceTable {
  const id = normalizeModelId(key);
  if (!id) return overrides;
  const next = { ...overrides };
  const fallback = defaults[id];
  if (price === null || (fallback && samePrice(price, fallback))) {
    delete next[id];
  } else {
    next[id] = price;
  }
  return next;
}
