import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RowGroups } from '@/components/common/GroupedRows';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { useProviderRecentRequests } from '@/components/providers/hooks/useProviderRecentRequests';
import { ProviderBrandGroup } from './components/ProviderBrandGroup';
import { ProviderResourceRow } from './components/ProviderResourceRow';
import { getResourceLabel } from './components/providerDisplay';
import { ProvidersHeader } from './components/ProvidersHeader';
import {
  ProviderSheet,
  type ProviderSheetHandle,
  type ProviderSheetState,
} from './sheets/ProviderSheet';
import { isSponsorPartialMutationError } from './sponsorMutationRecovery';
import { useProviderWorkbench } from './useProviderWorkbench';
import type { ProviderBrand, ProviderResource } from './types';
import styles from './ProvidersWorkbenchPage.module.scss';

/** Filter/sort state from the old single-brand table; no longer read. */
const LEGACY_UI_STATE_KEY = 'providersPage.uiState';
const SKELETON_GROUP_COUNT = 3;

export function ProvidersWorkbenchPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const { showNotification, showConfirmation } = useNotificationStore();

  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const workbench = useProviderWorkbench();
  const [sheetState, setSheetState] = useState<ProviderSheetState>({
    open: false,
    brand: 'gemini',
    mode: 'create',
    resource: null,
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const sheetRef = useRef<ProviderSheetHandle>(null);

  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_UI_STATE_KEY);
    } catch {
      // storage unavailable
    }
  }, []);

  const connected = connectionStatus === 'connected';
  const { usageByProvider, refreshRecentRequests } = useProviderRecentRequests({
    enabled: connected,
  });

  const handleRefresh = useCallback(async () => {
    await Promise.allSettled([workbench.refetch(), refreshRecentRequests().catch(() => undefined)]);
  }, [refreshRecentRequests, workbench]);

  useHeaderRefresh(handleRefresh, isCurrentLayer);

  const disableMutations =
    !connected || workbench.mutating || workbench.isFetching || workbench.isError;

  const allGroups = useMemo(() => workbench.snapshot?.groups ?? [], [workbench.snapshot]);
  const configuredGroups = useMemo(
    () => allGroups.filter((group) => group.resources.length > 0),
    [allGroups]
  );
  const unconfiguredBrands = useMemo(
    () => allGroups.filter((group) => group.resources.length === 0).map((group) => group.id),
    [allGroups]
  );
  const totals = useMemo(() => {
    let total = 0;
    let active = 0;
    configuredGroups.forEach((group) => {
      total += group.resources.length;
      active += group.resources.filter((resource) => !resource.disabled).length;
    });
    return { total, active };
  }, [configuredGroups]);

  /** Opens the sheet, guarding unsaved edits when switching targets. */
  const openSheet = useCallback(
    (next: Omit<ProviderSheetState, 'open'>) => {
      const switching =
        sheetState.open &&
        (sheetState.brand !== next.brand ||
          sheetState.mode !== next.mode ||
          sheetState.resource?.id !== next.resource?.id);
      const proceed =
        switching && sheetRef.current
          ? sheetRef.current.confirmDiscardIfDirty()
          : Promise.resolve(true);
      void proceed.then((ok) => {
        if (ok) setSheetState({ ...next, open: true });
      });
    },
    [sheetState]
  );

  const openCreate = useCallback(
    (brand: ProviderBrand) => openSheet({ brand, mode: 'create', resource: null }),
    [openSheet]
  );

  const openEdit = useCallback(
    (resource: ProviderResource) => openSheet({ brand: resource.brand, mode: 'edit', resource }),
    [openSheet]
  );

  const closeSheet = useCallback(() => {
    setSheetState((s) => ({ ...s, open: false }));
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = useCallback(
    (resource: ProviderResource) => {
      const name = getResourceLabel(resource);
      showConfirmation({
        title: t('providersPage.delete.title'),
        message: t('providersPage.delete.confirm', { name }),
        variant: 'danger',
        confirmText: t('providersPage.actions.delete'),
        onConfirm: async () => {
          try {
            await workbench.deleteProvider(resource);
            showNotification(t('providersPage.toast.deleted'), 'success');
          } catch (err) {
            if (isSponsorPartialMutationError(err)) {
              showNotification(t('providersPage.sponsor.partialMutationWarning'), 'warning');
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            showNotification(`${t('notification.delete_failed')}: ${msg}`, 'error');
          }
        },
      });
    },
    [showConfirmation, showNotification, t, workbench]
  );

  const handleToggleDisabled = useCallback(
    async (resource: ProviderResource, disabled: boolean) => {
      try {
        await workbench.toggleDisabled(resource, disabled);
        showNotification(
          disabled ? t('providersPage.toast.disabled') : t('providersPage.toast.enabled'),
          'success'
        );
      } catch (err) {
        if (isSponsorPartialMutationError(err)) {
          showNotification(t('providersPage.sponsor.partialMutationWarning'), 'warning');
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('providersPage.toast.toggleFailed')}: ${msg}`, 'error');
      }
    },
    [showNotification, t, workbench]
  );

  const handleCreated = useCallback(() => {
    showNotification(t('providersPage.toast.created'), 'success');
    closeSheet();
  }, [closeSheet, showNotification, t]);

  const handleUpdated = useCallback(() => {
    showNotification(t('providersPage.toast.updated'), 'success');
    closeSheet();
  }, [closeSheet, showNotification, t]);

  const loading = !workbench.snapshot && workbench.isPending;

  const addLine =
    unconfiguredBrands.length > 0 ? (
      <nav className={styles.addLine} aria-label={t('providersPage.addLine.title')}>
        <span className={styles.addLabel}>{t('providersPage.addLine.label')}</span>
        {unconfiguredBrands.map((brand, index) => {
          const name = t(`providersPage.providerNames.${brand}`);
          return (
            <span key={brand} className={styles.addItem}>
              {index > 0 && (
                <span className={styles.addDot} aria-hidden="true">
                  ·
                </span>
              )}
              <button
                type="button"
                className={styles.addButton}
                onClick={() => openCreate(brand)}
                disabled={disableMutations}
                aria-label={t('providersPage.group.add', { provider: name })}
              >
                {name}
              </button>
            </span>
          );
        })}
      </nav>
    ) : null;

  return (
    <div className={styles.page}>
      <ProvidersHeader
        activeCount={totals.active}
        totalCount={totals.total}
        refreshing={workbench.isFetching}
        onRefresh={() => void handleRefresh()}
      />

      <section className={styles.workbench}>
        {workbench.errorMessage && (
          <div className={styles.errorBanner} role="alert">
            {workbench.errorMessage}
          </div>
        )}

        {loading ? (
          <div className={styles.skeletons} aria-hidden="true">
            {Array.from({ length: SKELETON_GROUP_COUNT }, (_, index) => (
              <Skeleton key={index} height={88} rounded={12} />
            ))}
          </div>
        ) : configuredGroups.length === 0 ? (
          workbench.snapshot ? (
            <EmptyState
              title={t('providersPage.empty.title')}
              description={t('providersPage.empty.description')}
            />
          ) : null
        ) : (
          <RowGroups>
            {configuredGroups.map((group) => (
              <ProviderBrandGroup
                key={group.id}
                group={group}
                resolvedTheme={resolvedTheme}
                addDisabled={disableMutations}
                onAdd={openCreate}
              >
                {group.resources.map((resource) => (
                  <ProviderResourceRow
                    key={resource.id}
                    resource={resource}
                    usageByProvider={usageByProvider}
                    expanded={expanded.has(resource.id)}
                    disableMutations={disableMutations}
                    onToggleExpanded={() => toggleExpanded(resource.id)}
                    onToggleDisabled={handleToggleDisabled}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                ))}
              </ProviderBrandGroup>
            ))}
          </RowGroups>
        )}

        {!loading && addLine}
      </section>

      <ProviderSheet
        ref={sheetRef}
        state={sheetState}
        onClose={closeSheet}
        workbench={workbench}
        onCreated={handleCreated}
        onUpdated={handleUpdated}
        mutationDisabled={disableMutations}
      />
    </div>
  );
}
