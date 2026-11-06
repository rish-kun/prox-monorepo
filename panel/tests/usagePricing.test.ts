import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRICES,
  applyPriceOverride,
  createPriceResolver,
  matchModelPrice,
  mergePrices,
  normalizeModelId,
  rowCost,
  sanitizePriceOverrides,
  type CostableRow,
} from '@/features/usage/pricing';
import { readPriceOverrides, writePriceOverrides } from '@/features/usage/usePrices';

const row = (extra: Partial<CostableRow> = {}): CostableRow => ({
  promptTier: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  unclassifiedTokens: 0,
  ...extra,
});

const keyOf = (model: string) => matchModelPrice(model, DEFAULT_PRICES)?.key ?? null;

describe('model id normalisation', () => {
  test('lowercases and strips thinking, effort and date suffixes in any order', () => {
    expect(normalizeModelId('Claude-Opus-4-5')).toBe('claude-opus-4-5');
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('claude-opus-4-5-thinking')).toBe('claude-opus-4-5');
    expect(normalizeModelId('claude-opus-4-5-20251101-thinking')).toBe('claude-opus-4-5');
    expect(normalizeModelId('gpt-5.5-xhigh')).toBe('gpt-5.5');
    expect(normalizeModelId('gpt-5.1-codex-max')).toBe('gpt-5.1-codex');
    expect(normalizeModelId('gpt-5-high')).toBe('gpt-5');
    expect(normalizeModelId('gpt-5-medium')).toBe('gpt-5');
    expect(normalizeModelId('gpt-5-low')).toBe('gpt-5');
  });

  test('drops a trailing (...) thinking suffix', () => {
    expect(normalizeModelId('claude-opus-5-5(high)')).toBe('claude-opus-5-5');
    expect(normalizeModelId('gpt-5.5 (xhigh)')).toBe('gpt-5.5');
    expect(normalizeModelId('claude-sonnet-4-5(32768)')).toBe('claude-sonnet-4-5');
  });

  test('keeps meaningful segments such as -mini, -codex and version numbers', () => {
    expect(normalizeModelId('gpt-5-mini')).toBe('gpt-5-mini');
    expect(normalizeModelId('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(normalizeModelId('  GPT-6-Luna  ')).toBe('gpt-6-luna');
  });
});

describe('price matching', () => {
  test('exact match wins over shorter prefixes', () => {
    expect(keyOf('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(keyOf('claude-opus-5')).toBe('claude-opus-5');
    expect(keyOf('claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(keyOf('claude-fable-5')).toBe('claude-fable-5');
    expect(keyOf('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(keyOf('gpt-5-mini')).toBe('gpt-5-mini');
  });

  test('dated and suffixed ids resolve through normalisation', () => {
    expect(keyOf('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
    expect(keyOf('claude-opus-4-20250514')).toBe('claude-opus-4');
    expect(keyOf('claude-3-5-haiku-20241022')).toBe('claude-3-5-haiku');
    expect(keyOf('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(keyOf('claude-sonnet-4-6-thinking')).toBe('claude-sonnet-4-6');
  });

  test('longest prefix on a "-" boundary', () => {
    expect(keyOf('gpt-5-codex')).toBe('gpt-5');
    expect(keyOf('gpt-5.1-codex-mini')).toBe('gpt-5.1');
    expect(keyOf('gpt-5.2-codex')).toBe('gpt-5.2-codex');
    expect(keyOf('gpt-5.3-codex-spark')).toBe('gpt-5.3-codex');
    expect(keyOf('gpt-5-mini-2025-08-07')).toBe('gpt-5-mini');
    expect(keyOf('claude-opus-5-5-preview')).toBe('claude-opus-5-5');
  });

  test('a prefix never crosses into another version number', () => {
    expect(keyOf('gpt-5.4')).toBeNull();
    expect(keyOf('gpt-50')).toBeNull();
    expect(keyOf('claude-opus-45')).toBeNull();
  });

  test('models without an API price are unpriced', () => {
    expect(keyOf('gpt-oss-120b')).toBeNull();
    expect(keyOf('gpt-oss-20b')).toBeNull();
    expect(keyOf('unknown')).toBeNull();
    expect(keyOf('')).toBeNull();
    expect(keyOf('gemini-3-pro')).toBeNull();
  });

  test('default figures match the spec tables', () => {
    expect(DEFAULT_PRICES['claude-opus-5-5']).toEqual({
      input: 4,
      cacheWrite: 5,
      cacheRead: 0.2,
      output: 20,
    });
    expect(DEFAULT_PRICES['claude-mythos-5-1']).toEqual(DEFAULT_PRICES['claude-fable-5-1']);
    expect(DEFAULT_PRICES['claude-opus-4-8']).toEqual(DEFAULT_PRICES['claude-opus-5']);
    expect(DEFAULT_PRICES['claude-3-7-sonnet'].input).toBe(3);
    expect(DEFAULT_PRICES['claude-haiku-5-5'].longContext).toEqual({
      minTier: 1,
      input: 0.5,
      cacheWrite: 0.625,
      cacheRead: 0.05,
      output: 2.5,
    });
    expect(DEFAULT_PRICES['gpt-5.5']).toEqual({
      input: 5,
      cacheWrite: 5,
      cacheRead: 0.5,
      output: 30,
      longContext: { minTier: 2, input: 10, cacheWrite: 10, cacheRead: 1, output: 45 },
    });
    expect(DEFAULT_PRICES['gpt-5.6-sol'].longContext?.output).toBe(30);
    expect(DEFAULT_PRICES['gpt-5.2'].longContext).toBeUndefined();
    expect(DEFAULT_PRICES['gpt-5-nano']).toEqual({
      input: 0.05,
      cacheWrite: 0.05,
      cacheRead: 0.005,
      output: 0.4,
    });
  });

  test('the memoised resolver agrees with matchModelPrice', () => {
    const resolve = createPriceResolver(DEFAULT_PRICES);
    expect(resolve('gpt-5-codex')?.key).toBe('gpt-5');
    expect(resolve('gpt-5-codex')?.key).toBe('gpt-5');
    expect(resolve('gpt-oss-120b')).toBeNull();
  });
});

describe('row cost', () => {
  test('sums each token class at its rate per million', () => {
    const cost = rowCost(
      row({
        inputTokens: 1_000_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 1_000_000,
        outputTokens: 500_000,
      }),
      DEFAULT_PRICES['claude-opus-5-5']
    );
    // 4 + 2×0.2 + 5 + 0.5×20
    expect(cost).toBeCloseTo(19.4, 10);
  });

  test('unclassified tokens are billed at the input price; reasoning is inside output', () => {
    const cost = rowCost(
      row({ unclassifiedTokens: 1_000_000, outputTokens: 1_000_000 }),
      DEFAULT_PRICES['gpt-5']
    );
    expect(cost).toBeCloseTo(1.25 + 10, 10);
  });

  test('Haiku 5.5 switches to long-context prices from tier 1', () => {
    const price = DEFAULT_PRICES['claude-haiku-5-5'];
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
    expect(rowCost(row({ ...usage, promptTier: 0 }), price)).toBeCloseTo(0.1 + 0.5 + 0.01, 10);
    expect(rowCost(row({ ...usage, promptTier: 1 }), price)).toBeCloseTo(0.5 + 2.5 + 0.05, 10);
    expect(rowCost(row({ ...usage, promptTier: 2 }), price)).toBeCloseTo(0.5 + 2.5 + 0.05, 10);
  });

  test('OpenAI long context applies only above 272K (tier 2)', () => {
    const price = DEFAULT_PRICES['gpt-6-astra'];
    const usage = { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(rowCost(row({ ...usage, promptTier: 0 }), price)).toBeCloseTo(10 + 12.5 + 50, 10);
    expect(rowCost(row({ ...usage, promptTier: 1 }), price)).toBeCloseTo(10 + 12.5 + 50, 10);
    expect(rowCost(row({ ...usage, promptTier: 2 }), price)).toBeCloseTo(20 + 25 + 75, 10);
  });

  test('models without long-context prices ignore the tier', () => {
    const price = DEFAULT_PRICES['claude-opus-5-5'];
    const usage = row({ inputTokens: 1_000_000 });
    expect(rowCost({ ...usage, promptTier: 2 }, price)).toBe(rowCost(usage, price));
  });
});

describe('overrides', () => {
  test('sanitize drops malformed entries and normalises keys', () => {
    const clean = sanitizePriceOverrides({
      'GPT-OSS-120B': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.1, output: 0.5 },
      bad: { input: -1, cacheRead: 0, cacheWrite: 0, output: 0 },
      partial: { input: 1 },
      'claude-haiku-5-5': {
        input: 0.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
        output: 1,
        longContext: { minTier: 3, input: 1, cacheRead: 1, cacheWrite: 1, output: 1 },
      },
    });
    expect(Object.keys(clean).sort()).toEqual(['claude-haiku-5-5', 'gpt-oss-120b']);
    expect(clean['claude-haiku-5-5'].longContext).toBeUndefined();
    expect(sanitizePriceOverrides(null)).toEqual({});
    expect(sanitizePriceOverrides([1, 2])).toEqual({});
  });

  test('overrides merge over defaults and can price a previously unpriced model', () => {
    const overrides = applyPriceOverride({}, 'gpt-oss-120b', {
      input: 0.1,
      cacheRead: 0.01,
      cacheWrite: 0.1,
      output: 0.5,
    });
    const table = mergePrices(DEFAULT_PRICES, overrides);
    expect(matchModelPrice('gpt-oss-120b', table)?.key).toBe('gpt-oss-120b');
    expect(matchModelPrice('gpt-oss-120b', DEFAULT_PRICES)).toBeNull();
  });

  test('an edit equal to the default removes the override; null reverts', () => {
    const edited = applyPriceOverride({}, 'claude-opus-5-5', {
      ...DEFAULT_PRICES['claude-opus-5-5'],
      output: 25,
    });
    expect(edited['claude-opus-5-5'].output).toBe(25);
    expect(
      applyPriceOverride(edited, 'claude-opus-5-5', DEFAULT_PRICES['claude-opus-5-5'])
    ).toEqual({});
    expect(applyPriceOverride(edited, 'claude-opus-5-5', null)).toEqual({});
  });

  test('persistence round-trips through storage and clears when empty', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage;
    const overrides = { 'gpt-oss-120b': { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 2 } };
    writePriceOverrides(overrides, storage);
    expect(store.has('usagePage.prices.v1')).toBe(true);
    expect(readPriceOverrides(storage)).toEqual(overrides);
    writePriceOverrides({}, storage);
    expect(store.has('usagePage.prices.v1')).toBe(false);
    store.set('usagePage.prices.v1', '{not json');
    expect(readPriceOverrides(storage)).toEqual({});
  });
});
