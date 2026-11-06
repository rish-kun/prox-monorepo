/**
 * Price table = built-in defaults merged with the user's overrides, which
 * live in localStorage (`usagePage.prices.v1`). Prices are not tied to a
 * connection, so the overrides are not scoped by API base.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_PRICES,
  applyPriceOverride,
  mergePrices,
  sanitizePriceOverrides,
  type ModelPrice,
  type PriceTable,
} from './pricing';

export const PRICES_STORAGE_KEY = 'usagePage.prices.v1';

const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

export function readPriceOverrides(storage: Storage | null = getStorage()): PriceTable {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PRICES_STORAGE_KEY);
    return raw ? sanitizePriceOverrides(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function writePriceOverrides(
  overrides: PriceTable,
  storage: Storage | null = getStorage()
): void {
  if (!storage) return;
  try {
    if (Object.keys(overrides).length === 0) storage.removeItem(PRICES_STORAGE_KEY);
    else storage.setItem(PRICES_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Storage full or disabled: the edit still applies for this session.
  }
}

export function usePrices() {
  const [overrides, setOverrides] = useState<PriceTable>(() => readPriceOverrides());
  const table = useMemo(() => mergePrices(DEFAULT_PRICES, overrides), [overrides]);

  const update = useCallback((next: (current: PriceTable) => PriceTable) => {
    setOverrides((current) => {
      const value = next(current);
      writePriceOverrides(value);
      return value;
    });
  }, []);

  /** Set a model's price; equal-to-default entries are dropped from overrides. */
  const setPrice = useCallback(
    (key: string, price: ModelPrice) =>
      update((current) => applyPriceOverride(current, key, price)),
    [update]
  );

  /** Revert a default model or delete a custom one. */
  const removePrice = useCallback(
    (key: string) => update((current) => applyPriceOverride(current, key, null)),
    [update]
  );

  const reset = useCallback(() => update(() => ({})), [update]);

  return { table, overrides, setPrice, removePrice, reset };
}
