import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { groupedRowStyles as rowStyles } from '@/components/common/GroupedRows';
import { ModelMappingDiagram, type ModelMappingDiagramRef } from '@/components/modelAlias';
import { IconChevronUp } from '@/components/ui/icons';
import type { OAuthModelAliasEntry } from '@/types';
import type { AuthFileModelItem, OAuthConfigLoadError } from '@/features/authFiles/constants';
import styles from './OAuthConfigPanels.module.scss';

type ViewMode = 'diagram' | 'list';

export type OAuthModelAliasCardProps = {
  disableControls: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onRetry: () => void | Promise<void>;
  onAdd: () => void;
  onEditProvider: (provider?: string) => void;
  onDeleteProvider: (provider: string) => void;
  modelAliasError: OAuthConfigLoadError;
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  allProviderModels: Record<string, AuthFileModelItem[]>;
  onUpdate: (provider: string, sourceModel: string, newAlias: string) => Promise<void>;
  onDeleteLink: (provider: string, sourceModel: string, alias: string) => void;
  onToggleFork: (
    provider: string,
    sourceModel: string,
    alias: string,
    fork: boolean
  ) => Promise<void>;
  onRenameAlias: (oldAlias: string, newAlias: string) => Promise<void>;
  onDeleteAlias: (aliasName: string) => void;
};

export function OAuthModelAliasCard(props: OAuthModelAliasCardProps) {
  const { t } = useTranslation();
  const diagramRef = useRef<ModelMappingDiagramRef | null>(null);
  const {
    disableControls,
    viewMode,
    onViewModeChange,
    onRetry,
    onAdd,
    onEditProvider,
    onDeleteProvider,
    modelAliasError,
    modelAlias,
    allProviderModels,
    onUpdate,
    onDeleteLink,
    onToggleFork,
    onRenameAlias,
    onDeleteAlias,
  } = props;

  return (
    <section className={styles.panel}>
      <header className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{t('oauth_model_alias.title')}</h3>
        <div className={styles.panelExtra}>
          <div className={styles.viewModeSwitch} role="group">
            {(['list', 'diagram'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`${styles.viewModeButton} ${viewMode === mode ? styles.viewModeActive : ''}`}
                onClick={() => onViewModeChange(mode)}
                disabled={disableControls || modelAliasError !== null}
                aria-pressed={viewMode === mode}
              >
                {t(`oauth_model_alias.view_mode_${mode}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={rowStyles.textButton}
            onClick={onAdd}
            disabled={disableControls || modelAliasError !== null}
          >
            {t('oauth_model_alias.add')}
          </button>
        </div>
      </header>
      <div className={styles.panelBody}>
        {modelAliasError === 'unsupported' ? (
          <EmptyState
            title={t('oauth_model_alias.upgrade_required_title')}
            description={t('oauth_model_alias.upgrade_required_desc')}
          />
        ) : modelAliasError === 'load' ? (
          <EmptyState
            title={t('notification.refresh_failed')}
            action={
              <Button variant="secondary" size="sm" onClick={() => void onRetry()}>
                {t('common.refresh')}
              </Button>
            }
          />
        ) : modelAliasError === 'loading' ? (
          <EmptyState title={t('common.loading')} />
        ) : viewMode === 'diagram' ? (
          Object.keys(modelAlias).length === 0 ? (
            <EmptyState title={t('oauth_model_alias.list_empty_all')} />
          ) : (
            <div className={styles.aliasChartSection}>
              <div className={styles.aliasChartHeader}>
                <h4 className={styles.aliasChartTitle}>{t('oauth_model_alias.chart_title')}</h4>
                <button
                  type="button"
                  className={rowStyles.iconButton}
                  onClick={() => diagramRef.current?.collapseAll()}
                  disabled={disableControls || modelAliasError !== null}
                  title={t('oauth_model_alias.diagram_collapse')}
                  aria-label={t('oauth_model_alias.diagram_collapse')}
                >
                  <IconChevronUp size={16} />
                </button>
              </div>
              <ModelMappingDiagram
                ref={diagramRef}
                modelAlias={modelAlias}
                allProviderModels={allProviderModels}
                onUpdate={onUpdate}
                onDeleteLink={onDeleteLink}
                onToggleFork={onToggleFork}
                onRenameAlias={onRenameAlias}
                onDeleteAlias={onDeleteAlias}
                onEditProvider={onEditProvider}
                onDeleteProvider={onDeleteProvider}
                className={styles.aliasChart}
              />
            </div>
          )
        ) : Object.keys(modelAlias).length === 0 ? (
          <EmptyState title={t('oauth_model_alias.list_empty_all')} />
        ) : (
          <div className={styles.list}>
            {Object.entries(modelAlias).map(([provider, mappings]) => (
              <div key={provider} className={styles.item}>
                <div className={styles.itemInfo}>
                  <div className={styles.itemProvider}>{provider}</div>
                  <div className={styles.itemCount}>
                    {mappings?.length
                      ? t('oauth_model_alias.model_count', { count: mappings.length })
                      : t('oauth_model_alias.no_models')}
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={rowStyles.textButton}
                    onClick={() => onEditProvider(provider)}
                    disabled={disableControls}
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    className={`${rowStyles.textButton} ${rowStyles.danger}`}
                    onClick={() => onDeleteProvider(provider)}
                    disabled={disableControls}
                  >
                    {t('oauth_model_alias.delete')}
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
