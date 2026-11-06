/**
 * Last successful explicit quota fetch per credential, kept in localStorage.
 *
 * The upstream usage endpoints (Anthropic /api/oauth/usage especially) are
 * strictly rate-limited, so a fetch the user paid for should not evaporate on
 * reload: its model-scoped windows and reset anchors keep feeding the rows and
 * the reset timeline until the next explicit refresh replaces them.
 *
 * Scoped by API base so two proxies never see each other's data. Only
 * `success` states are stored; they hold usage figures and plan metadata, no
 * credentials.
 */

import type { QuotaProviderType } from './providers/types';

const STORAGE_KEY = 'quotaPage.savedQuota.v1';

interface SavedEntry {
  state: unknown;
  savedAtMs: number;
}

interface SavedQuotaFile {
  apiBase: string;
  quota: Partial<Record<QuotaProviderType, Record<string, SavedEntry>>>;
}

const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

function readFile(apiBase: string): SavedQuotaFile {
  const empty: SavedQuotaFile = { apiBase, quota: {} };
  const storage = getStorage();
  if (!storage) return empty;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<SavedQuotaFile> | null;
    if (
      !parsed ||
      parsed.apiBase !== apiBase ||
      typeof parsed.quota !== 'object' ||
      !parsed.quota
    ) {
      return empty;
    }
    return { apiBase, quota: parsed.quota };
  } catch {
    return empty;
  }
}

function writeFile(file: SavedQuotaFile) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // Quota exceeded or storage disabled: persistence is best-effort.
  }
}

/** Saved success states for one provider, keyed by quota cache key. */
export function readSavedQuota(
  apiBase: string,
  type: QuotaProviderType
): Record<string, SavedEntry> {
  return readFile(apiBase).quota[type] ?? {};
}

const isSuccess = (state: unknown): boolean =>
  Boolean(state) && (state as { status?: unknown }).status === 'success';

/**
 * Replace the saved snapshot with the current success states, restricted to
 * credentials that still exist. States that are loading or failed leave the
 * previously saved success in place — a 429 must not erase good data.
 *
 * Returns true when anything changed (so callers can skip redundant writes).
 */
export function syncSavedQuota(
  apiBase: string,
  current: Partial<Record<QuotaProviderType, Record<string, unknown>>>,
  survivors: Partial<Record<QuotaProviderType, ReadonlySet<string>>>,
  nowMs: number
): boolean {
  const file = readFile(apiBase);
  let changed = false;
  const next: SavedQuotaFile['quota'] = {};

  for (const [type, keys] of Object.entries(survivors) as [
    QuotaProviderType,
    ReadonlySet<string>,
  ][]) {
    const saved = file.quota[type] ?? {};
    const live = current[type] ?? {};
    const out: Record<string, SavedEntry> = {};
    for (const key of keys) {
      const state = live[key];
      if (isSuccess(state)) {
        const previous = saved[key];
        if (previous && JSON.stringify(previous.state) === JSON.stringify(state)) {
          out[key] = previous;
        } else {
          out[key] = { state, savedAtMs: nowMs };
          changed = true;
        }
      } else if (saved[key]) {
        out[key] = saved[key];
      }
    }
    if (Object.keys(saved).some((key) => !keys.has(key))) changed = true;
    if (Object.keys(out).length > 0) next[type] = out;
  }

  if (changed) writeFile({ apiBase, quota: next });
  return changed;
}
