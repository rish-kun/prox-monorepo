/**
 * Claude / Codex quota comes only from the proxy, which polls each account
 * about once an hour and shares one fetch with every screen.
 *
 * - `refreshProxyQuotaEntries`: one `POST /quota/refresh` for any number of
 *   credentials (refresh-all, provider-group refresh), results per entry.
 * - `hydrateProxyQuota`: fill the shared quota store from
 *   `GET /quota/snapshots` on load — no upstream call at all. Replaces the
 *   localStorage persistence for these two providers.
 *
 * React-free; covered by tests/quotaProxySnapshots.test.ts.
 */

import type { TFunction } from 'i18next';
import { apiClient, quotaSnapshotsApi, type QuotaSnapshotSet } from '@/services/api';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores/useQuotaStore';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from './logic';
import {
  QUOTA_ADAPTERS,
  getQuotaMap,
  getQuotaSetter,
  type QuotaAdapter,
  type QuotaCardState,
} from './providers';
import type { QuotaProviderType } from './providers/types';
import { snapshotHasContent } from './snapshotBundle';

export const PROXY_QUOTA_TYPES: readonly QuotaProviderType[] = ['claude', 'codex'];

export const isProxyQuotaType = (type: QuotaProviderType): boolean =>
  PROXY_QUOTA_TYPES.includes(type);

export type ProxyFetchResult =
  { status: 'success'; data: unknown } | { status: 'error'; error: string; errorStatus?: number };

const entryAuthIndex = (file: AuthFileItem): string | null =>
  normalizeAuthIndex(file['auth_index'] ?? file.authIndex);

const errorResult = (err: unknown, fallback: string): ProxyFetchResult => ({
  status: 'error',
  error: err instanceof Error && err.message ? err.message : fallback,
  errorStatus: getStatusFromError(err),
});

/**
 * Refresh every given Claude / Codex credential with a single proxy request.
 * A transport failure fails every entry; a per-account failure is reported by
 * its own snapshot.
 */
export async function refreshProxyQuotaEntries(
  entries: readonly QuotaFileEntry[],
  t: TFunction
): Promise<Map<QuotaFileEntry, ProxyFetchResult>> {
  const results = new Map<QuotaFileEntry, ProxyFetchResult>();
  const indexed: Array<{ entry: QuotaFileEntry; authIndex: string }> = [];
  for (const entry of entries) {
    const authIndex = entryAuthIndex(entry.file);
    if (authIndex) {
      indexed.push({ entry, authIndex });
    } else {
      const prefix = QUOTA_ADAPTERS[entry.type].i18nPrefix;
      results.set(entry, { status: 'error', error: t(`${prefix}.missing_auth_index`) });
    }
  }
  if (indexed.length === 0) return results;

  let set: QuotaSnapshotSet;
  try {
    set = await quotaSnapshotsApi.refresh(Array.from(new Set(indexed.map((i) => i.authIndex))));
  } catch (err: unknown) {
    const failure = errorResult(err, t('common.unknown_error'));
    indexed.forEach(({ entry }) => results.set(entry, failure));
    return results;
  }

  for (const { entry, authIndex } of indexed) {
    const adapter = QUOTA_ADAPTERS[entry.type];
    const snapshot = set.snapshots[authIndex];
    if (!snapshot || !adapter.fromSnapshot) {
      results.set(entry, { status: 'error', error: t('common.unknown_error') });
      continue;
    }
    try {
      results.set(entry, {
        status: 'success',
        data: adapter.fromSnapshot(snapshot, entry.file, t),
      });
    } catch (err: unknown) {
      results.set(entry, errorResult(err, t('common.unknown_error')));
    }
  }
  return results;
}

/** The state a snapshot should show, or null when it holds nothing yet. */
export function stateFromSnapshot(
  adapter: QuotaAdapter,
  file: AuthFileItem,
  snapshots: QuotaSnapshotSet['snapshots'],
  t: TFunction
): QuotaCardState | null {
  const authIndex = entryAuthIndex(file);
  const snapshot = authIndex ? snapshots[authIndex] : undefined;
  if (!snapshot || !adapter.fromSnapshot || !snapshotHasContent(snapshot)) return null;
  try {
    return adapter.buildSuccessState(adapter.fromSnapshot(snapshot, file, t));
  } catch (err: unknown) {
    const failure = errorResult(err, t('common.unknown_error'));
    return failure.status === 'error'
      ? adapter.buildErrorState(failure.error, failure.errorStatus)
      : null;
  }
}

/**
 * Whether a hydrated state should replace what the store holds: never an
 * in-flight load, always an empty slot, otherwise only newer proxy data.
 */
export function shouldHydrate(
  prev: QuotaCardState | undefined,
  next: QuotaCardState,
  attemptedAtMs: number
): boolean {
  if (!prev || prev.status === 'idle') return true;
  if (prev.status === 'loading') return false;
  if (prev.status === 'error' && next.status === 'error') {
    return prev.error !== next.error || prev.errorStatus !== next.errorStatus;
  }
  // A success carries the proxy's fetch time; a failure is as new as its attempt.
  const instant = next.status === 'success' ? (next.fetchedAtMs ?? 0) : attemptedAtMs;
  return instant > (prev.fetchedAtMs ?? 0);
}

/** Concurrent callers (Quota page + Auth Files rows) share one snapshot read. */
let inflight: { revision: number; promise: Promise<QuotaSnapshotSet> } | null = null;

const readSnapshots = (): Promise<QuotaSnapshotSet> => {
  const revision = apiClient.getConnectionRevision();
  if (inflight && inflight.revision === revision) return inflight.promise;
  const promise = quotaSnapshotsApi.getSnapshots().finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { revision, promise };
  return promise;
};

/** Fill Claude / Codex quota states for these credentials from the proxy's stored snapshots. */
export async function hydrateProxyQuota(files: readonly AuthFileItem[], t: TFunction) {
  const targets: Array<{ file: AuthFileItem; adapter: QuotaAdapter }> = [];
  for (const file of files) {
    const type = PROXY_QUOTA_TYPES.find((candidate) => QUOTA_ADAPTERS[candidate].filterFn(file));
    if (type && entryAuthIndex(file)) targets.push({ file, adapter: QUOTA_ADAPTERS[type] });
  }
  if (targets.length === 0) return;

  const generation = captureQuotaCacheGeneration();
  let set: QuotaSnapshotSet;
  try {
    set = await readSnapshots();
  } catch {
    // Older proxies without the endpoint, or the service not running: rows stay idle.
    return;
  }

  for (const { file, adapter } of targets) {
    const next = stateFromSnapshot(adapter, file, set.snapshots, t);
    if (!next) continue;
    const snapshot = set.snapshots[entryAuthIndex(file) as string];
    const instant = snapshot.attemptedAtMs ?? snapshot.fetchedAtMs ?? 0;
    const cacheKey = getQuotaCacheKey(file);
    if (!shouldHydrate(getQuotaMap(adapter)[cacheKey], next, instant)) continue;
    commitIfQuotaCacheCurrent(
      generation,
      () =>
        getQuotaSetter(adapter)((prev) =>
          shouldHydrate(prev[cacheKey], next, instant) ? { ...prev, [cacheKey]: next } : prev
        ),
      file.name
    );
  }
}
