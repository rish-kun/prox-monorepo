/**
 * Usage page data: `GET /usage/summary` for the selected range plus the
 * credential list (names joined by auth_index). Polls every 60 s while the tab
 * is visible; responses requested under another connection or range are
 * dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFilesApi, usageApi, type UsageSummary } from '@/services/api';
import { usePolling } from '@/features/dashboard/hooks/usePolling';
import { useAuthStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { localTzOffsetMinutes, rangeQuery, type RangeQuery, type UsageRange } from './model';

const POLL_MS = 60_000;

interface Loaded {
  scope: string;
  query: RangeQuery;
  summary: UsageSummary;
}

interface Failed {
  scope: string;
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

export function useUsageData(range: UsageRange) {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = connectionStatus === 'connected';
  const connection = `${apiBase}\n${managementKey}`;
  const scope = `${connection}\n${range}`;

  const scopeRef = useRef(scope);
  const connectionRef = useRef(connection);
  useEffect(() => {
    scopeRef.current = scope;
    connectionRef.current = connection;
  }, [scope, connection]);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [files, setFiles] = useState<{ connection: string; value: AuthFileItem[] } | null>(null);
  const summarySeq = useRef(0);
  const filesSeq = useRef(0);

  const loadSummary = useCallback(async () => {
    const requestScope = scope;
    const seq = ++summarySeq.current;
    const now = Date.now();
    const query = rangeQuery(range, now, localTzOffsetMinutes(now));
    try {
      const summary = await usageApi.summary(query);
      if (scopeRef.current !== requestScope || seq !== summarySeq.current) return;
      setLoaded({ scope: requestScope, query, summary });
      setFailed(null);
    } catch (error: unknown) {
      if (scopeRef.current !== requestScope || seq !== summarySeq.current) return;
      setFailed({ scope: requestScope, status: errorStatus(error), message: errorMessage(error) });
    }
  }, [range, scope]);

  const loadFiles = useCallback(async () => {
    const requestConnection = connection;
    const seq = ++filesSeq.current;
    try {
      const response = await authFilesApi.list();
      if (connectionRef.current !== requestConnection || seq !== filesSeq.current) return;
      setFiles({ connection: requestConnection, value: response.files });
    } catch {
      // Names fall back to recorded labels / masked indexes.
    }
  }, [connection]);

  const poll = useCallback(() => {
    void loadSummary();
    void loadFiles();
  }, [loadSummary, loadFiles]);

  usePolling(poll, POLL_MS, connected, scope);

  const refresh = useCallback(async () => {
    if (!connected) return;
    await Promise.allSettled([loadSummary(), loadFiles()]);
  }, [connected, loadSummary, loadFiles]);

  const current = connected && loaded?.scope === scope ? loaded : null;
  const currentError = connected && failed?.scope === scope ? failed : null;
  const currentFiles = connected && files?.connection === connection ? files.value : null;

  return useMemo(
    () => ({
      connected,
      summary: current?.summary ?? null,
      query: current?.query ?? null,
      error: currentError,
      files: currentFiles,
      refresh,
    }),
    [connected, current, currentError, currentFiles, refresh]
  );
}
