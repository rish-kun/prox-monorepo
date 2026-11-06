/**
 * 混合提供商批量额度加载（原 useQuotaLoader 的跨分区泛化）。
 *
 * 保留的三道守卫与旧实现逐一对应：
 * - loadingRef：并发批量加载去重；
 * - requestIdRef：被超越的响应直接丢弃；
 * - cacheGeneration：断线重连后过期请求不得写入新会话缓存。
 * 提交按 provider 分组进行 —— 快的提供商先落地，不等慢的。
 *
 * Claude / Codex never fetch upstream themselves: every such credential in the
 * batch goes to the proxy in ONE `POST /quota/refresh`, whose results are then
 * committed per provider group like any other fetch.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaMap, getQuotaSetter, type QuotaCardState } from '../providers';
import { enrichQuotaInBackground } from '../quotaEnrichment';
import { isProxyQuotaType, refreshProxyQuotaEntries } from '../proxyQuota';
import type { QuotaProviderType } from '../providers/types';

/**
 * Upper bound on simultaneous upstream quota requests across one batch. The
 * page now loads every credential rather than a page of 20, so without a cap a
 * large pool would fire them all at once.
 */
export const MAX_CONCURRENT_QUOTA_FETCHES = 6;

/**
 * A credential fetched this recently is skipped by batch refreshes: repeated
 * "refresh all" clicks would otherwise hammer the strictly rate-limited usage
 * endpoints (Anthropic /api/oauth/usage answers 429 quickly).
 */
export const BATCH_REFETCH_MIN_INTERVAL_MS = 30_000;

/**
 * Upstream rate limiting says nothing about the account: keep the last good
 * data instead of replacing it with an error row.
 */
export const isRateLimitStatus = (status: number | undefined) => status === 429;

/** Promise-returning task runner that keeps at most `limit` tasks in flight. */
export function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

interface BatchFetchResult {
  name: string;
  cacheKey: string;
  status: 'success' | 'error';
  data?: unknown;
  error?: string;
  errorStatus?: number;
}

export function useQuotaBatchLoader() {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (requested: QuotaFileEntry[]) => {
      if (loadingRef.current) return;
      const nowMs = Date.now();
      const targets = requested.filter(({ type, file }) => {
        const state = getQuotaMap(QUOTA_ADAPTERS[type])[getQuotaCacheKey(file)];
        const fetchedAtMs = state?.status === 'success' ? state.fetchedAtMs : undefined;
        return !fetchedAtMs || nowMs - fetchedAtMs >= BATCH_REFETCH_MIN_INTERVAL_MS;
      });
      if (targets.length === 0) return;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      const cacheGeneration = captureQuotaCacheGeneration();
      const limited = createConcurrencyLimiter(MAX_CONCURRENT_QUOTA_FETCHES);
      setBatchLoading(true);

      try {
        const groups = new Map<QuotaProviderType, QuotaFileEntry[]>();
        targets.forEach((entry) => {
          const group = groups.get(entry.type) ?? [];
          group.push(entry);
          groups.set(entry.type, group);
        });

        const proxyEntries = targets.filter(({ type }) => isProxyQuotaType(type));
        const proxyResults =
          proxyEntries.length > 0 ? refreshProxyQuotaEntries(proxyEntries, t) : null;

        await Promise.all(
          Array.from(groups.entries()).map(async ([type, entries]) => {
            const adapter = QUOTA_ADAPTERS[type];
            const setQuota = getQuotaSetter(adapter);
            const previous = getQuotaMap(adapter);

            commitIfQuotaCacheCurrent(cacheGeneration, () => {
              setQuota((prev) => {
                const nextState = { ...prev };
                entries.forEach(({ file }) => {
                  nextState[getQuotaCacheKey(file)] = adapter.buildLoadingState();
                });
                return nextState;
              });
            });

            const proxied = isProxyQuotaType(type) && proxyResults ? await proxyResults : null;
            const results = await Promise.all(
              entries.map((entry) => {
                const { file } = entry;
                if (proxied) {
                  const result = proxied.get(entry) ?? {
                    status: 'error' as const,
                    error: t('common.unknown_error'),
                  };
                  return { name: file.name, cacheKey: getQuotaCacheKey(file), ...result };
                }
                return limited(async (): Promise<BatchFetchResult> => {
                  const cacheKey = getQuotaCacheKey(file);
                  try {
                    const data = await adapter.fetchQuota(file, t);
                    return { name: file.name, cacheKey, status: 'success', data };
                  } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : t('common.unknown_error');
                    return {
                      name: file.name,
                      cacheKey,
                      status: 'error',
                      error: message,
                      errorStatus: getStatusFromError(err),
                    };
                  }
                });
              })
            );

            if (requestId !== requestIdRef.current) return;

            const committedStates = new Map<string, QuotaCardState>();
            setQuota((prev) => {
              const nextState = { ...prev };
              results.forEach((result) => {
                commitIfQuotaCacheCurrent(
                  cacheGeneration,
                  () => {
                    const prior = previous[result.cacheKey];
                    nextState[result.cacheKey] =
                      result.status === 'success'
                        ? adapter.buildSuccessState(result.data)
                        : isRateLimitStatus(result.errorStatus) && prior?.status === 'success'
                          ? prior
                          : adapter.buildErrorState(
                              result.error || t('common.unknown_error'),
                              result.errorStatus
                            );
                    committedStates.set(result.cacheKey, nextState[result.cacheKey]);
                  },
                  result.name
                );
              });
              return nextState;
            });
            results.forEach((result, index) => {
              const state = committedStates.get(result.cacheKey);
              if (result.status === 'success' && state) {
                void enrichQuotaInBackground(adapter, entries[index].file, result.data, state, t);
              }
            });
          })
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setBatchLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [t]
  );

  return { batchLoading, loadQuota };
}
