import { useTranslation } from 'react-i18next';
import { PageToolbarSlot } from '@/components/layout/PageToolbar';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconRefreshCw, IconUpload } from '@/components/ui/icons';
import { groupedRowStyles as rowStyles } from '@/components/common/GroupedRows';
import styles from './AuthFilesHeader.module.scss';

export type AuthFilesHeaderProps = {
  totalCount: number;
  problemCount: number;
  loading: boolean;
  refreshing: boolean;
  uploading: boolean;
  disableControls: boolean;
  refreshingCredentials: boolean;
  credentialRefreshDisabled: boolean;
  onRefreshCredentials: () => void;
  onRefresh: () => void;
  onUpload: () => void;
};

/**
 * Auth-files header in the quota page's language: title, one mono meta line
 * ("42 credentials · 3 problems"), and quiet actions on the right.
 */
export function AuthFilesHeader({
  totalCount,
  problemCount,
  loading,
  refreshing,
  uploading,
  disableControls,
  refreshingCredentials,
  credentialRefreshDisabled,
  onRefreshCredentials,
  onRefresh,
  onUpload,
}: AuthFilesHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <h1 className={styles.title}>{t('auth_files.title')}</h1>
        <p className={styles.meta}>
          <span>{t('auth_files.meta_total', { count: totalCount })}</span>
          {problemCount > 0 && (
            <>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span className={styles.metaProblem}>
                {t('auth_files.problem_count', { count: problemCount })}
              </span>
            </>
          )}
        </p>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.textAction}
          onClick={onRefreshCredentials}
          disabled={
            disableControls || loading || refreshingCredentials || credentialRefreshDisabled
          }
        >
          {refreshingCredentials ? <LoadingSpinner size={14} /> : <IconRefreshCw size={14} />}
          {t('auth_files.refresh_all_button')}
        </button>
        <button
          type="button"
          className={rowStyles.iconButton}
          onClick={onRefresh}
          disabled={loading || refreshing}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
        >
          <IconRefreshCw size={15} className={refreshing ? styles.spinning : undefined} />
        </button>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={onUpload}
          disabled={disableControls || uploading}
        >
          {uploading ? <LoadingSpinner size={14} /> : <IconUpload size={14} />}
          {t('auth_files.upload_button')}
        </button>
        <PageToolbarSlot />
      </div>
    </header>
  );
}
