import { useTranslation } from 'react-i18next';
import { PageToolbarSlot } from '@/components/layout/PageToolbar';
import { IconRefreshCw } from '@/components/ui/icons';
import { groupedRowStyles } from '@/components/common/GroupedRows';
import styles from './ProvidersHeader.module.scss';

export type ProvidersHeaderProps = {
  activeCount: number;
  totalCount: number;
  refreshing: boolean;
  onRefresh: () => void;
};

/** Page title, one mono meta line and a quiet refresh icon — the quota header's grammar. */
export function ProvidersHeader({
  activeCount,
  totalCount,
  refreshing,
  onRefresh,
}: ProvidersHeaderProps) {
  const { t } = useTranslation();
  const refreshLabel = t('providersPage.actions.refresh');

  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <h1 className={styles.title}>{t('providersPage.header.title')}</h1>
        {totalCount > 0 && (
          <p className={styles.meta}>
            <span className={activeCount > 0 ? styles.metaActive : styles.metaMuted}>
              {t('providersPage.header.activeMeta', { active: activeCount, total: totalCount })}
            </span>
          </p>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={groupedRowStyles.iconButton}
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshLabel}
          title={refreshLabel}
        >
          <IconRefreshCw size={15} className={refreshing ? styles.spinning : undefined} />
        </button>
        <PageToolbarSlot />
      </div>
    </header>
  );
}
