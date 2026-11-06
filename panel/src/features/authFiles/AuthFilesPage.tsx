/**
 * 认证文件页：按提供商分组的紧凑凭证行（与额度页同一视觉语汇）。
 *
 * - 不做搜索/筛选/排序/分页：全部凭证可见，每个提供商一组；
 *   超过 50 行的组先显示前 50 行，「显示全部」展开。
 * - 组头「N 个问题」只做选择（非破坏性），批量动作交给 BatchActionBar。
 * - OAuth 排除模型 / 模型别名收进页尾默认折叠的「OAuth 规则」。
 * - 首载前台（骨架屏），此后一律后台刷新（不清空列表）；4 分钟轮询。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { RowGroups } from '@/components/common/GroupedRows';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconChevronDown } from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboard';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { AuthFileItem } from '@/types';
import { isRuntimeOnlyAuthFile, type ResolvedTheme } from '@/features/authFiles/constants';
import { AuthFileDetailsSheet } from '@/features/authFiles/components/AuthFileDetailsSheet';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFileProviderGroup } from '@/features/authFiles/components/AuthFileProviderGroup';
import { AuthFileRefreshResults } from '@/features/authFiles/components/AuthFileRefreshResults';
import { AuthFileRow } from '@/features/authFiles/components/AuthFileRow';
import { AuthFilesHeader } from '@/features/authFiles/components/AuthFilesHeader';
import { BatchActionBar } from '@/features/authFiles/components/BatchActionBar';
import { OAuthExcludedCard } from '@/features/authFiles/components/OAuthExcludedCard';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import { invalidateAuthFileDerivedCaches } from '@/features/authFiles/cacheInvalidation';
import {
  AUTH_FILE_GROUP_ROW_LIMIT,
  countByProviderKey,
  groupAuthFilesByProvider,
  resolveAuthFileHealth,
  summarizeAuthFileGroup,
  type AuthFileHealth,
} from '@/features/authFiles/logic';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { clearLegacyAuthFilesUiState } from '@/features/authFiles/uiState';
import { useProxyQuotaHydration } from '@/features/quota/hooks/useProxyQuotaHydration';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import styles from './AuthFilesPage.module.scss';

const SKELETON_GROUP_COUNT = 3;

const toggleInSet = (set: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

export function AuthFilesPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();
  const now = useNow();

  const [viewMode, setViewMode] = useState<'diagram' | 'list'>('list');
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [rulesOpen, setRulesOpen] = useState(false);

  useEffect(() => {
    clearLegacyAuthFilesUiState();
  }, []);

  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
    closeModelsModal,
    invalidateModels,
  } = useAuthFilesModels();

  const invalidateDerivedCaches = useCallback(
    (names?: string[]) => invalidateAuthFileDerivedCaches(invalidateModels, names),
    [invalidateModels]
  );

  const {
    files,
    selectedFiles,
    selectionCount,
    loading,
    refreshing,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    manualRefreshing,
    refreshingAllCredentials,
    refreshResults,
    closeRefreshResults,
    handleRefreshAllCredentials,
    cooldownResetting,
    batchStatusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleManualRefresh,
    handleCooldownReset,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchDelete,
  } = useAuthFilesData({ onFilesMutated: invalidateDerivedCaches });

  const {
    excluded,
    excludedError,
    modelAlias,
    modelAliasError,
    allProviderModels,
    loadExcluded,
    loadModelAlias,
    deleteExcluded,
    deleteModelAlias,
    handleMappingUpdate,
    handleDeleteLink,
    handleToggleFork,
    handleRenameAlias,
    handleDeleteAlias,
  } = useAuthFilesOauth({ viewMode, files });

  const disableControls = connectionStatus !== 'connected' || refreshingAllCredentials;

  // Claude / Codex quota rows show the proxy's latest snapshot; no upstream call.
  useProxyQuotaHydration(files, connectionStatus === 'connected' && !loading);

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls,
    loadFiles,
    onFilesMutated: invalidateDerivedCaches,
  });

  /* ---------- 数据加载：首载前台（骨架屏），此后一律后台 ---------- */

  const initialLoadDoneRef = useRef(false);

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadFiles({ background: true }), loadExcluded(), loadModelAlias()]);
  }, [loadFiles, loadExcluded, loadModelAlias]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    if (!isCurrentLayer) return;
    void loadFiles(initialLoadDoneRef.current ? { background: true } : undefined);
    initialLoadDoneRef.current = true;
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadExcluded, loadModelAlias]);

  useInterval(
    () => {
      void loadFiles({ background: true }).catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );

  /* ---------- 分组与健康度 ---------- */

  const healthByKey = useMemo(() => {
    const map = new Map<string, AuthFileHealth>();
    files.forEach((file) => map.set(getQuotaCacheKey(file), resolveAuthFileHealth(file, now)));
    return map;
  }, [files, now]);

  const healthOf = useCallback(
    (file: AuthFileItem): AuthFileHealth =>
      healthByKey.get(getQuotaCacheKey(file)) ?? { kind: 'ok' },
    [healthByKey]
  );

  const groups = useMemo(
    () =>
      groupAuthFilesByProvider(files).map((group) => {
        const selectable = group.files.filter((file) => !isRuntimeOnlyAuthFile(file));
        return {
          ...group,
          selectable,
          summary: summarizeAuthFileGroup(group.files, healthOf),
          healths: group.files.map((file) => healthOf(file).kind),
        };
      }),
    [files, healthOf]
  );

  const excludedCounts = useMemo(() => countByProviderKey(excluded), [excluded]);
  const aliasCounts = useMemo(() => countByProviderKey(modelAlias), [modelAlias]);

  const problemCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.summary.problemCount, 0),
    [groups]
  );
  const selectableFiles = useMemo(
    () => files.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [files]
  );

  /* ---------- 选择与批量 ---------- */

  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);
  const selectedHasStatusUpdating = useMemo(
    () =>
      files.some(
        (file) =>
          selectedFiles.has(file.name) && statusUpdating[getAuthFileRefreshKey(file)] === true
      ),
    [files, selectedFiles, statusUpdating]
  );
  const batchStatusButtonsDisabled =
    disableControls ||
    selectedNames.length === 0 ||
    batchStatusUpdating ||
    selectedHasStatusUpdating;

  const toggleGroupSelection = useCallback(
    (selectable: AuthFileItem[], allSelected: boolean) => {
      // 全选时反选即取消该组；否则补齐该组（不影响其他组的选择）
      if (allSelected) invertVisibleSelection(selectable);
      else selectAllVisible(selectable);
    },
    [invertVisibleSelection, selectAllVisible]
  );

  /* ---------- 杂项 ---------- */

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied
          ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
          : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const openOAuthEditor = useCallback(
    (path: 'oauth-excluded' | 'oauth-model-alias', provider?: string) => {
      const providerValue = (provider ?? '').trim();
      const query = providerValue ? `?${new URLSearchParams({ provider: providerValue })}` : '';
      navigate(`/auth-files/${path}${query}`, { state: { fromAuthFiles: true } });
    },
    [navigate]
  );

  const isEmpty = !loading && files.length === 0 && !error;

  return (
    <div className={styles.page}>
      <AuthFilesHeader
        totalCount={files.length}
        problemCount={problemCount}
        loading={loading}
        refreshing={refreshing}
        uploading={uploading}
        disableControls={disableControls}
        refreshingCredentials={refreshingAllCredentials}
        credentialRefreshDisabled={Object.keys(manualRefreshing).length > 0}
        onRefreshCredentials={handleRefreshAllCredentials}
        onRefresh={() => void handleHeaderRefresh()}
        onUpload={handleUploadClick}
      />
      <AuthFileRefreshResults results={refreshResults} onClose={closeRefreshResults} />
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <section className={styles.workbench} aria-label={t('auth_files.title')}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {loading && files.length === 0 ? (
          <RowGroups>
            {Array.from({ length: SKELETON_GROUP_COUNT }, (_, index) => (
              <Skeleton key={index} height={64} rounded={12} />
            ))}
          </RowGroups>
        ) : isEmpty ? (
          <EmptyState
            title={t('auth_files.empty_title')}
            description={t('auth_files.empty_desc')}
            action={
              <div className={styles.emptyActions}>
                <Button
                  size="sm"
                  onClick={handleUploadClick}
                  disabled={disableControls || uploading}
                >
                  {t('auth_files.upload_button')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => navigate('/oauth')}>
                  {t('auth_files.empty_oauth_link')}
                </Button>
              </div>
            }
          />
        ) : (
          <RowGroups>
            {groups.map((group) => {
              const allSelected =
                group.selectable.length > 0 &&
                group.selectable.every((file) => selectedFiles.has(file.name));
              const showAll = expandedGroups.has(group.type);
              const visibleFiles =
                showAll || group.files.length <= AUTH_FILE_GROUP_ROW_LIMIT
                  ? group.files
                  : group.files.slice(0, AUTH_FILE_GROUP_ROW_LIMIT);
              return (
                <AuthFileProviderGroup
                  key={group.type}
                  type={group.type}
                  healths={group.healths}
                  summary={group.summary}
                  resolvedTheme={resolvedTheme}
                  selectableCount={group.selectable.length}
                  allSelected={allSelected}
                  excludedCount={excludedCounts.get(group.type) ?? 0}
                  aliasCount={aliasCounts.get(group.type) ?? 0}
                  onToggleSelectGroup={() => toggleGroupSelection(group.selectable, allSelected)}
                  onSelectProblems={selectAllVisible}
                >
                  {visibleFiles.map((file) => {
                    const key = getQuotaCacheKey(file);
                    return (
                      <AuthFileRow
                        key={key}
                        file={file}
                        health={healthOf(file)}
                        expanded={expandedRows.has(key)}
                        selected={selectedFiles.has(file.name)}
                        disableControls={disableControls}
                        deleting={deleting}
                        statusUpdating={statusUpdating}
                        manualRefreshing={manualRefreshing}
                        cooldownResetting={cooldownResetting}
                        onToggleExpanded={() => setExpandedRows((prev) => toggleInSet(prev, key))}
                        onShowModels={showModels}
                        onDownload={handleDownload}
                        onManualRefresh={handleManualRefresh}
                        onCooldownReset={handleCooldownReset}
                        onOpenPrefixProxyEditor={openPrefixProxyEditor}
                        onDelete={handleDelete}
                        onToggleStatus={handleStatusToggle}
                        onToggleSelect={toggleSelect}
                      />
                    );
                  })}
                  {visibleFiles.length < group.files.length && (
                    <div className={styles.showAllRow}>
                      <button
                        type="button"
                        className={styles.quietButton}
                        onClick={() => setExpandedGroups((prev) => toggleInSet(prev, group.type))}
                      >
                        {t('auth_files.group_show_all', { count: group.files.length })}
                      </button>
                    </div>
                  )}
                </AuthFileProviderGroup>
              );
            })}
          </RowGroups>
        )}
      </section>

      {!loading && (
        <section className={styles.rulesSection}>
          <div className={styles.footerBar}>
            <button
              type="button"
              className={styles.quietButton}
              aria-expanded={rulesOpen}
              aria-controls="auth-files-oauth-rules"
              onClick={() => setRulesOpen((open) => !open)}
            >
              <IconChevronDown
                size={14}
                aria-hidden="true"
                className={`${styles.chevron} ${rulesOpen ? styles.chevronOpen : ''}`}
              />
              {t('auth_files.oauth_rules_toggle')}
            </button>
            {selectableFiles.length > 0 && (
              <button
                type="button"
                className={`${styles.quietButton} ${styles.dangerText}`}
                onClick={handleDeleteAll}
                disabled={disableControls || deletingAll}
              >
                {t('auth_files.delete_all_credentials')}
              </button>
            )}
          </div>
          {rulesOpen && (
            <div id="auth-files-oauth-rules" className={styles.rulesGrid}>
              <OAuthExcludedCard
                disableControls={disableControls}
                excludedError={excludedError}
                excluded={excluded}
                onRetry={loadExcluded}
                onAdd={() => openOAuthEditor('oauth-excluded')}
                onEdit={(provider) => openOAuthEditor('oauth-excluded', provider)}
                onDelete={deleteExcluded}
              />
              <OAuthModelAliasCard
                disableControls={disableControls}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                onRetry={loadModelAlias}
                onAdd={() => openOAuthEditor('oauth-model-alias')}
                onEditProvider={(provider) => openOAuthEditor('oauth-model-alias', provider)}
                onDeleteProvider={deleteModelAlias}
                modelAliasError={modelAliasError}
                modelAlias={modelAlias}
                allProviderModels={allProviderModels}
                onUpdate={handleMappingUpdate}
                onDeleteLink={handleDeleteLink}
                onToggleFork={handleToggleFork}
                onRenameAlias={handleRenameAlias}
                onDeleteAlias={handleDeleteAlias}
              />
            </div>
          )}
        </section>
      )}

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={excluded}
        onClose={closeModelsModal}
        onCopyText={copyTextWithNotification}
      />

      <AuthFileDetailsSheet
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onCopyText={copyTextWithNotification}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />

      <BatchActionBar
        selectionCount={selectionCount}
        selectableCount={selectableFiles.length}
        disableControls={disableControls}
        batchStatusDisabled={batchStatusButtonsDisabled}
        onSelectAll={() => selectAllVisible(files)}
        onInvert={() => invertVisibleSelection(files)}
        onDeselectAll={deselectAll}
        onDownload={() => void batchDownload(selectedNames)}
        onEnable={() => batchSetStatus(selectedNames, true)}
        onDisable={() => batchSetStatus(selectedNames, false)}
        onDelete={() => batchDelete(selectedNames)}
      />
    </div>
  );
}
