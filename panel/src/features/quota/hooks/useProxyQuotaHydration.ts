import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { hydrateProxyQuota } from '../proxyQuota';

/**
 * Fill Claude / Codex quota rows from the proxy's stored snapshots whenever a
 * credential list arrives (page load, tab re-activation, refresh). Reads the
 * local `GET /quota/snapshots` only — never an upstream usage endpoint.
 */
export function useProxyQuotaHydration(files: readonly AuthFileItem[] | null, enabled: boolean) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!enabled || !files || files.length === 0) return;
    void hydrateProxyQuota(files, t);
  }, [enabled, files, t]);
}
