import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { groupedRowStyles as rowStyles } from '@/components/common/GroupedRows';
import type { OAuthConfigLoadError } from '@/features/authFiles/constants';
import styles from './OAuthConfigPanels.module.scss';

export type OAuthExcludedCardProps = {
  disableControls: boolean;
  excludedError: OAuthConfigLoadError;
  excluded: Record<string, string[]>;
  onRetry: () => void | Promise<void>;
  onAdd: () => void;
  onEdit: (provider: string) => void;
  onDelete: (provider: string) => void;
};

export function OAuthExcludedCard(props: OAuthExcludedCardProps) {
  const { t } = useTranslation();
  const { disableControls, excludedError, excluded, onRetry, onAdd, onEdit, onDelete } = props;

  return (
    <section className={styles.panel}>
      <header className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{t('oauth_excluded.title')}</h3>
        <div className={styles.panelExtra}>
          <button
            type="button"
            className={rowStyles.textButton}
            onClick={onAdd}
            disabled={disableControls || excludedError !== null}
          >
            {t('oauth_excluded.add')}
          </button>
        </div>
      </header>
      <div className={styles.panelBody}>
        {excludedError === 'unsupported' ? (
          <EmptyState
            title={t('oauth_excluded.upgrade_required_title')}
            description={t('oauth_excluded.upgrade_required_desc')}
          />
        ) : excludedError === 'load' ? (
          <EmptyState
            title={t('notification.refresh_failed')}
            action={
              <Button variant="secondary" size="sm" onClick={() => void onRetry()}>
                {t('common.refresh')}
              </Button>
            }
          />
        ) : excludedError === 'loading' ? (
          <EmptyState title={t('common.loading')} />
        ) : Object.keys(excluded).length === 0 ? (
          <EmptyState title={t('oauth_excluded.list_empty_all')} />
        ) : (
          <div className={styles.list}>
            {Object.entries(excluded).map(([provider, models]) => (
              <div key={provider} className={styles.item}>
                <div className={styles.itemInfo}>
                  <div className={styles.itemProvider}>{provider}</div>
                  <div className={styles.itemCount}>
                    {models?.length
                      ? t('oauth_excluded.model_count', { count: models.length })
                      : t('oauth_excluded.no_models')}
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={rowStyles.textButton}
                    onClick={() => onEdit(provider)}
                    disabled={disableControls}
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    className={`${rowStyles.textButton} ${rowStyles.danger}`}
                    onClick={() => onDelete(provider)}
                    disabled={disableControls}
                  >
                    {t('oauth_excluded.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
