/**
 * Recorded quota history for the forecast chart (`GET /quota/history`).
 * Refetched every 60 s while the tab is visible and the chart is open;
 * responses requested under another connection, provider, window or span are
 * dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '@/features/dashboard/hooks/usePolling';
import {
  quotaSnapshotsApi,
  type ProxyQuotaProvider,
  type QuotaHistory,
  type QuotaHistoryWindow,
} from '@/services/api';
import { useAuthStore } from '@/stores';

const POLL_MS = 60_000;

export interface QuotaHistoryError {
  status: number | null;
  message: string;
}

const errorStatus = (error: unknown): number | null =>
  error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : null;

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : '';

export function useQuotaHistory(
  provider: ProxyQuotaProvider,
  windowKind: QuotaHistoryWindow,
  /** Seconds of history to request, ending now. */
  span: number,
  enabled: boolean
) {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = connectionStatus === 'connected';
  const scope = `${apiBase}\n${managementKey}\n${provider}\n${windowKind}\n${span}`;

  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const [loaded, setLoaded] = useState<{ scope: string; history: QuotaHistory } | null>(null);
  const [failed, setFailed] = useState<{ scope: string; error: QuotaHistoryError } | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const requestScope = scope;
    const seq = ++seqRef.current;
    const to = Math.floor(Date.now() / 1000);
    try {
      const history = await quotaSnapshotsApi.getHistory({
        provider,
        window: windowKind,
        from: to - span,
        to,
      });
      if (scopeRef.current !== requestScope || seq !== seqRef.current) return;
      setLoaded({ scope: requestScope, history });
      setFailed(null);
    } catch (error: unknown) {
      if (scopeRef.current !== requestScope || seq !== seqRef.current) return;
      setFailed({
        scope: requestScope,
        error: { status: errorStatus(error), message: errorMessage(error) },
      });
    }
  }, [provider, scope, span, windowKind]);

  const poll = useCallback(() => void load(), [load]);
  usePolling(poll, POLL_MS, connected && enabled, scope);

  return {
    history: connected && loaded?.scope === scope ? loaded.history : null,
    error: connected && failed?.scope === scope ? failed.error : null,
  };
}
