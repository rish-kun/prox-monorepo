/**
 * Dashboard data. Local Management API reads only:
 *
 * - `GET /credentials` — every credential with its request buckets, lifetime
 *   counters, cooldowns and the proxy's passive quota observations;
 * - `GET /observability/usage/api-keys` — config-backed API keys, which the
 *   credential list does not include (deduplicated in the model);
 * - `GET /observability/logs` (tail) — only while logging-to-file is on;
 * - the cached config.
 *
 * Never an upstream provider usage endpoint, never the usage queue (reading it
 * consumes it). Polls every 15s (logs 20s), paused while the tab is hidden.
 * Responses are tagged with the connection they were requested under and
 * dropped if the connection changed meanwhile.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFilesApi, logsApi } from '@/services/api';
import { useAuthStore, useConfigStore } from '@/stores';
import { useProviderRecentRequests } from '@/components/providers/hooks/useProviderRecentRequests';
import type { AuthFileItem } from '@/types';
import { recentErrorLines, type ErrorLogEntry } from '../model';
import { usePolling } from './usePolling';

const DATA_POLL_MS = 15_000;
const LOGS_POLL_MS = 20_000;
/** Enough tail to find recent errors without pulling the whole log. */
const LOG_TAIL_LINES = 400;
const ERROR_ROWS = 8;

interface Scoped<T> {
  scope: string;
  value: T;
  at: number;
}

export function useDashboardData() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);

  const connected = connectionStatus === 'connected';
  const scope = `${apiBase}\n${managementKey}`;
  const loggingToFile = connected && config?.loggingToFile === true;

  const { usageByProvider, refreshRecentRequests } = useProviderRecentRequests({
    enabled: connected,
  });

  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const [files, setFiles] = useState<Scoped<AuthFileItem[]> | null>(null);
  const [errors, setErrors] = useState<Scoped<ErrorLogEntry[]> | null>(null);
  const filesSeq = useRef(0);
  const logsSeq = useRef(0);

  const loadFiles = useCallback(async () => {
    const requestScope = scope;
    const seq = ++filesSeq.current;
    try {
      const response = await authFilesApi.list();
      if (scopeRef.current !== requestScope || seq !== filesSeq.current) return;
      setFiles({ scope: requestScope, value: response.files, at: Date.now() });
    } catch {
      // Keep the last good list; the next poll retries.
    }
  }, [scope]);

  const loadErrors = useCallback(async () => {
    const requestScope = scope;
    const seq = ++logsSeq.current;
    try {
      const response = await logsApi.fetchLogs({ limit: LOG_TAIL_LINES });
      if (scopeRef.current !== requestScope || seq !== logsSeq.current) return;
      setErrors({
        scope: requestScope,
        value: recentErrorLines(response.lines, ERROR_ROWS),
        at: Date.now(),
      });
    } catch {
      // Logging may have just been switched off; leave the section as it was.
    }
  }, [scope]);

  const pollData = useCallback(() => {
    void fetchConfig().catch(() => undefined);
    void loadFiles();
    void refreshRecentRequests().catch(() => undefined);
  }, [fetchConfig, loadFiles, refreshRecentRequests]);

  usePolling(pollData, DATA_POLL_MS, connected, scope);
  usePolling(() => void loadErrors(), LOGS_POLL_MS, loggingToFile, scope);

  const refresh = useCallback(async () => {
    if (!connected) return;
    await Promise.allSettled([
      fetchConfig(true),
      loadFiles(),
      refreshRecentRequests(),
      ...(loggingToFile ? [loadErrors()] : []),
    ]);
  }, [connected, fetchConfig, loadFiles, refreshRecentRequests, loggingToFile, loadErrors]);

  const currentFiles = files && files.scope === scope ? files : null;
  const currentErrors = errors && errors.scope === scope ? errors.value : null;

  return useMemo(
    () => ({
      connectionStatus,
      connected,
      config: connected ? config : null,
      files: connected ? (currentFiles?.value ?? null) : null,
      filesFetchedAt: currentFiles?.at ?? 0,
      apiKeyUsage: usageByProvider,
      loggingToFile,
      recentErrors: loggingToFile ? currentErrors : null,
      refresh,
    }),
    [
      connectionStatus,
      connected,
      config,
      currentFiles,
      usageByProvider,
      loggingToFile,
      currentErrors,
      refresh,
    ]
  );
}
