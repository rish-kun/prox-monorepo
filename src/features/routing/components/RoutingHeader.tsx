import { useTranslation } from 'react-i18next';
import { groupedRowStyles as g } from '@/components/common/GroupedRows';
import { PageToolbarSlot } from '@/components/layout/PageToolbar';
import { IconRefreshCw } from '@/components/ui/icons';
import type { RoutingStrategy } from '../logic';
import { STRATEGY_LABEL_KEYS } from '../labels';
import styles from './Routing.module.scss';

export type RoutingHeaderProps = {
  credentialCount: number;
  providerCount: number;
  strategy: RoutingStrategy | null;
  sticky: boolean | null;
  loading: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
};

/** Title + one mono telemetry line, the quota header's vocabulary. */
export function RoutingHeader({
  credentialCount,
  providerCount,
  strategy,
  sticky,
  loading,
  refreshDisabled,
  onRefresh,
}: RoutingHeaderProps) {
  const { t } = useTranslation();
  const dot = (
    <span className={styles.metaDot} aria-hidden="true">
      ·
    </span>
  );
  return (
    <header className={styles.header}>
      <div className={styles.headerCopy}>
        <h1 className={styles.title}>{t('routing.title')}</h1>
        <p className={styles.meta}>
          <span>{t('routing.meta_credentials', { count: credentialCount })}</span>
          {dot}
          <span>{t('routing.meta_providers', { count: providerCount })}</span>
          {strategy && (
            <>
              {dot}
              <span className={styles.metaStrong}>{t(STRATEGY_LABEL_KEYS[strategy])}</span>
            </>
          )}
          {sticky !== null && (
            <>
              {dot}
              <span className={sticky ? styles.metaStrong : styles.metaMuted}>
                {t(sticky ? 'routing.meta_sticky_on' : 'routing.meta_sticky_off')}
              </span>
            </>
          )}
        </p>
      </div>
      <div className={styles.headerActions}>
        <button
          type="button"
          className={g.iconButton}
          onClick={onRefresh}
          disabled={refreshDisabled || loading}
          aria-label={t('routing.refresh')}
          title={t('routing.refresh')}
        >
          <IconRefreshCw
            size={14}
            aria-hidden="true"
            className={loading ? styles.spinning : undefined}
          />
        </button>
        <PageToolbarSlot />
      </div>
    </header>
  );
}
