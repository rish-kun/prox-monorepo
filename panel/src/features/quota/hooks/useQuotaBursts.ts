/**
 * "Prioritise plan" bursts for the Quota page (`/quota/burst`).
 *
 * Fetched on load, after every action (each call returns the list) and every
 * 60 s while the tab is visible. A burst disappears at its `ends_at` without
 * waiting for the next poll. Responses from another connection are dropped.
 * Until the list has loaded once (e.g. a proxy without the endpoint) no
 * Prioritise action is offered.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePolling } from '@/features/dashboard/hooks/usePolling';
import { quotaBurstApi, type QuotaBurst } from '@/services/api';
import type { QuotaBurstKind } from '@/services/api/quotaBurst';
import { useAuthStore, useNotificationStore } from '@/stores';
import { activeBursts, nextBurstExpiry } from '../quotaBurst';

const POLL_MS = 60_000;
/** setTimeout's ceiling (~24.8 days); a burst never lasts that long anyway. */
const MAX_TIMER_MS = 2_147_483_647;
const NO_BURSTS: QuotaBurst[] = [];

export type QuotaBurstAction = 'prioritise' | 'cancel';

export function useQuotaBursts(enabled: boolean, now: number) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = connectionStatus === 'connected';
  const scope = `${apiBase}\n${managementKey}`;

  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const [loaded, setLoaded] = useState<{ scope: string; bursts: QuotaBurst[] } | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const seqRef = useRef(0);

  const accept = useCallback((requestScope: string, seq: number, bursts: QuotaBurst[]) => {
    if (scopeRef.current !== requestScope || seq !== seqRef.current) return;
    setLoaded({ scope: requestScope, bursts });
  }, []);

  const load = useCallback(async () => {
    const requestScope = scope;
    const seq = ++seqRef.current;
    try {
      accept(requestScope, seq, await quotaBurstApi.list());
    } catch {
      // Keep the last list; the next poll retries quietly.
    }
  }, [accept, scope]);

  const poll = useCallback(() => void load(), [load]);
  usePolling(poll, POLL_MS, connected && enabled, scope);

  const run = useCallback(
    async (
      action: QuotaBurstAction,
      authIndex: string,
      name: string,
      kind: QuotaBurstKind = '5h'
    ) => {
      if (!connected || pending.has(authIndex)) return;
      const requestScope = scope;
      setPending((prev) => new Set(prev).add(authIndex));
      try {
        const bursts =
          action === 'prioritise'
            ? await quotaBurstApi.prioritise(authIndex, kind)
            : await quotaBurstApi.cancel(authIndex);
        accept(requestScope, ++seqRef.current, bursts);
      } catch (err: unknown) {
        if (scopeRef.current !== requestScope) return;
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        showNotification(
          t(
            action === 'prioritise'
              ? 'quota_management.burst_failed'
              : 'quota_management.burst_stop_failed',
            { name, message }
          ),
          'error'
        );
        void load();
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(authIndex);
          return next;
        });
      }
    },
    [accept, connected, load, pending, scope, showNotification, t]
  );

  // Hide a burst at its end instant rather than at the next minute tick or poll.
  const [expiryClock, setExpiryClock] = useState(0);
  const all = connected && loaded?.scope === scope ? loaded.bursts : NO_BURSTS;
  const clock = Math.max(now, expiryClock);
  const active = useMemo(() => activeBursts(all, clock), [all, clock]);
  const nextExpiry = nextBurstExpiry(active);
  useEffect(() => {
    if (nextExpiry === null) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, nextExpiry - Date.now()) + 250);
    const timer = window.setTimeout(() => setExpiryClock(Math.max(Date.now(), nextExpiry)), delay);
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);

  return {
    /** Running bursts in routing order. */
    bursts: active,
    /** The proxy answered the list call on this connection. */
    supported: connected && loaded?.scope === scope,
    pending,
    run,
  };
}
