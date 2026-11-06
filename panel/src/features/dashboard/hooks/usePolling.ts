import { useEffect, useEffectEvent } from 'react';

/** Visibility/focus can fire together; collapse them into one refetch. */
const MIN_REFETCH_GAP_MS = 3_000;

/**
 * Run `task` now, then every `intervalMs` while the tab is visible. Hidden
 * tabs skip ticks; returning to the tab (visibilitychange / focus) refetches
 * at once. `scopeKey` restarts the cycle — pass the connection identity so a
 * new connection loads immediately.
 */
export function usePolling(
  task: () => void,
  intervalMs: number,
  enabled: boolean,
  scopeKey: string
) {
  const runTask = useEffectEvent(task);

  useEffect(() => {
    if (!enabled) return;
    let lastRun = 0;
    const run = () => {
      lastRun = Date.now();
      runTask();
    };
    const tick = () => {
      if (document.hidden) return;
      if (Date.now() - lastRun < intervalMs / 2) return;
      run();
    };
    const resume = () => {
      if (document.hidden) return;
      if (Date.now() - lastRun < MIN_REFETCH_GAP_MS) return;
      run();
    };

    run();
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [enabled, intervalMs, scopeKey]);
}
