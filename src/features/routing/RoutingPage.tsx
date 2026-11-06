/**
 * Routing page: global routing policy (strategy, sticky sessions, retry,
 * cooldown, per-model cooling) over per-provider credential pools grouped into
 * priority tiers.
 *
 * - Policy and per-credential priority/weight/excluded-model edits are drafts,
 *   saved together from the floating save bar: config first (PATCH
 *   /config/routing + /config/upstream, DELETE for cleared fields), then each
 *   credential sequentially via PATCH /credentials/fields, reporting partial
 *   failures and keeping only the failed drafts.
 * - Enable toggles and cooldown resets apply immediately.
 * - Every response is checked against the connection revision it was issued
 *   under, so a connection switch never lets stale data land.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { RowGroups } from '@/components/common/GroupedRows';
import { UnsavedChangesGuard } from '@/components/common/UnsavedChangesGuard';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { FloatingSaveBar } from '@/features/config/components/FloatingSaveBar';
import type { ConfigStatusTone } from '@/features/config/uiState';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { readPassiveQuota } from '@/features/quota/passiveQuota';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { apiClient, authFilesApi, routingApi } from '@/services/api';
import {
  useAuthStore,
  useConfigStore,
  useNotificationStore,
  useQuotaStore,
  useThemeStore,
} from '@/stores';
import type { AuthFileItem } from '@/types';
import { getErrorMessage } from '@/utils/helpers';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { createSharedClock } from '@/utils/time/sharedClock';
import {
  applyFlatPreset,
  applyPlanPreset,
  buildRoutingSavePlan,
  groupByProvider,
  groupIntoTiers,
  hasConfigChanges,
  pruneSavedDrafts,
  readExcludedBaseline,
  readRoutingSettings,
  stickyResetRisk,
  changedSettingKeys,
  toRoutingCredentials,
  updateCredentialDraft,
  validateRoutingDraft,
  type CredentialDraft,
  type ExcludedBaseline,
  type RoutingCredential,
  type RoutingSettings,
} from './logic';
import { RoutingHeader } from './components/RoutingHeader';
import { RoutingSettingsGroup } from './components/RoutingSettingsGroup';
import { RoutingPoolGroup, type PresetKind } from './components/RoutingPoolGroup';
import type { CredentialRowHandlers, ExcludedLoadState } from './components/RoutingCredentialRow';
import styles from './components/Routing.module.scss';

// One 1s ticker for cooldown countdowns, subscribed only while something cools.
const cooldownClock = createSharedClock({ intervalMs: 1000 });
const noopSubscribe = () => () => {};

type Policy = { baseline: RoutingSettings; settings: RoutingSettings };

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function RoutingPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.isCurrentLayer : true;
  const connected = connectionStatus === 'connected';

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CredentialDraft>>({});
  const [excluded, setExcluded] = useState<Record<string, ExcludedLoadState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  /* ---------- loading ---------- */

  const requestRef = useRef(0);
  const sessionRef = useRef<string | null>(null);

  const loadAll = useCallback(
    async (options: { resetPolicy?: boolean } = {}) => {
      const requestId = ++requestRef.current;
      const revision = apiClient.getConnectionRevision();
      const isCurrent = () =>
        requestId === requestRef.current && revision === apiClient.getConnectionRevision();
      // A new connection starts from a clean slate: no drafts from another server.
      const session = `${apiBase}\n${revision}`;
      const newSession = sessionRef.current !== session;
      if (newSession) {
        sessionRef.current = session;
        setPolicy(null);
        setFiles([]);
        setDrafts({});
        setExcluded({});
        setExpanded(new Set());
      }
      if (!connected) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError('');
      try {
        const [routing, upstream, list] = await Promise.all([
          routingApi.getRouting(),
          routingApi.getUpstreamCooling(),
          authFilesApi.list(),
        ]);
        if (!isCurrent()) return;
        const next = readRoutingSettings(routing, upstream);
        setPolicy((prev) => {
          const keepDraft =
            !options.resetPolicy &&
            prev !== null &&
            changedSettingKeys(prev.baseline, prev.settings).length > 0;
          return { baseline: next, settings: keepDraft ? prev.settings : next };
        });
        setFiles(list?.files ?? []);
      } catch (err: unknown) {
        if (!isCurrent()) return;
        setError(getErrorMessage(err, t('routing.load_failed')));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [apiBase, connected, t]
  );

  useEffect(() => {
    void loadAll();
    return () => {
      requestRef.current += 1;
    };
  }, [loadAll]);

  useHeaderRefresh(loadAll);

  /* ---------- derived ---------- */

  const cachedPlan = useCallback(
    (provider: string, file: AuthFileItem): string | null => {
      const key = getQuotaCacheKey(file);
      if (provider === 'codex') {
        const quota = codexQuota[key];
        const fetched = quota?.status === 'success' ? (quota.planType ?? null) : null;
        return fetched ?? readPassiveQuota('codex', file).planType;
      }
      if (provider === 'claude') {
        const quota = claudeQuota[key];
        return quota?.status === 'success' ? (quota.planType ?? null) : null;
      }
      return null;
    },
    [claudeQuota, codexQuota]
  );

  const credentials = useMemo(() => toRoutingCredentials(files, cachedPlan), [files, cachedPlan]);
  const pools = useMemo(() => groupByProvider(credentials), [credentials]);

  const anyCooling = credentials.some((credential) => !!credential.cooldown?.records?.length);
  const nowMs = useSyncExternalStore(
    anyCooling ? cooldownClock.subscribe : noopSubscribe,
    cooldownClock.getSnapshot,
    cooldownClock.getSnapshot
  );

  const excludedBaselines = useMemo(() => {
    const result: Record<string, ExcludedBaseline> = {};
    for (const [key, state] of Object.entries(excluded)) {
      if (state.status === 'ready') result[key] = state.baseline;
    }
    return result;
  }, [excluded]);

  const draftState = useMemo(
    () =>
      policy
        ? {
            baseline: policy.baseline,
            settings: policy.settings,
            credentials,
            drafts,
            excluded: excludedBaselines,
          }
        : null,
    [credentials, drafts, excludedBaselines, policy]
  );
  const validation = useMemo(
    () => (draftState ? validateRoutingDraft(draftState) : null),
    [draftState]
  );
  const plan = useMemo(() => (draftState ? buildRoutingSavePlan(draftState) : null), [draftState]);
  const changeCount = plan?.changeCount ?? 0;
  const dirty = changeCount > 0;
  const weighted = policy?.settings.strategy === 'weighted-round-robin';
  const controlsDisabled = !connected || saving;

  /* ---------- guards ---------- */

  const unsavedDialog = useMemo(
    () => ({
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    }),
    [t]
  );

  /* ---------- edits ---------- */

  const setBusyKey = useCallback((key: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const loadExcluded = useCallback(async (credential: RoutingCredential) => {
    const revision = apiClient.getConnectionRevision();
    setExcluded((prev) => ({ ...prev, [credential.key]: { status: 'loading' } }));
    try {
      const text = await authFilesApi.downloadText(credential.name);
      if (revision !== apiClient.getConnectionRevision()) return;
      const baseline = readExcludedBaseline(JSON.parse(text) as unknown);
      setExcluded((prev) => ({ ...prev, [credential.key]: { status: 'ready', baseline } }));
    } catch {
      if (revision !== apiClient.getConnectionRevision()) return;
      setExcluded((prev) => ({ ...prev, [credential.key]: { status: 'error' } }));
    }
  }, []);

  const handlers = useMemo<CredentialRowHandlers>(
    () => ({
      onToggleExpand: (credential) => {
        const opening = !expanded.has(credential.key);
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(credential.key)) next.delete(credential.key);
          else next.add(credential.key);
          return next;
        });
        const state = excluded[credential.key];
        if (opening && credential.editable && (!state || state.status === 'error')) {
          void loadExcluded(credential);
        }
      },
      onPriority: (credential, text) =>
        setDrafts((prev) => updateCredentialDraft(prev, credential, { priority: text.trim() })),
      onWeight: (credential, text) =>
        setDrafts((prev) => updateCredentialDraft(prev, credential, { weight: text })),
      onExcluded: (credential, text) =>
        setDrafts((prev) =>
          updateCredentialDraft(
            prev,
            credential,
            { excludedText: text },
            excludedBaselines[credential.key]
          )
        ),
      onRetryExcluded: (credential) => void loadExcluded(credential),
      onEnable: async (credential, enabled) => {
        const key = `status:${credential.key}`;
        const revision = apiClient.getConnectionRevision();
        setBusyKey(key, true);
        try {
          await authFilesApi.setStatus(credential.name, !enabled, credential.authIndex);
          if (revision !== apiClient.getConnectionRevision()) return;
          setFiles((prev) =>
            prev.map((file) =>
              file.name === credential.name ? { ...file, disabled: !enabled } : file
            )
          );
          notifyAuthFilesChanged();
        } catch (err: unknown) {
          if (revision !== apiClient.getConnectionRevision()) return;
          showNotification(
            t('routing.status_failed', {
              name: credential.label,
              message: getErrorMessage(err, t('common.unknown_error')),
            }),
            'error'
          );
        } finally {
          setBusyKey(key, false);
        }
      },
      onResetCooldown: (credential) => {
        const authIndex = credential.authIndex;
        if (!authIndex) return;
        showConfirmation({
          title: t('auth_files.cooldown_reset_title'),
          message: t('auth_files.cooldown_reset_confirm', { name: credential.label }),
          confirmText: t('auth_files.cooldown_reset_button'),
          cancelText: t('common.cancel'),
          variant: 'primary',
          onConfirm: async () => {
            const key = `reset:${credential.key}`;
            const revision = apiClient.getConnectionRevision();
            setBusyKey(key, true);
            try {
              await authFilesApi.resetCooldown(authIndex);
              if (revision !== apiClient.getConnectionRevision()) return;
              showNotification(
                t('auth_files.cooldown_reset_success', { name: credential.label }),
                'success'
              );
              notifyAuthFilesChanged();
              await loadAll();
            } catch (err: unknown) {
              if (revision !== apiClient.getConnectionRevision()) return;
              showNotification(
                t('auth_files.cooldown_reset_failed', {
                  name: credential.label,
                  message: getErrorMessage(err, t('common.unknown_error')),
                }),
                'error'
              );
            } finally {
              setBusyKey(key, false);
            }
          },
        });
      },
    }),
    [
      excluded,
      excludedBaselines,
      expanded,
      loadAll,
      loadExcluded,
      setBusyKey,
      showConfirmation,
      showNotification,
      t,
    ]
  );

  const handlePreset = useCallback(
    (poolCredentials: RoutingCredential[], kind: PresetKind) => {
      if (kind === 'plan') {
        const result = applyPlanPreset(poolCredentials, drafts);
        setDrafts(result.drafts);
        showNotification(
          result.applied
            ? t('routing.preset_applied', { applied: result.applied, skipped: result.skipped })
            : t('routing.preset_none'),
          result.applied ? 'info' : 'warning'
        );
      } else if (kind === 'flat') {
        setDrafts(applyFlatPreset(poolCredentials, drafts));
      } else {
        setDrafts((prev) =>
          poolCredentials.reduce(
            (next, credential) =>
              updateCredentialDraft(next, credential, { priority: String(credential.priority) }),
            prev
          )
        );
      }
    },
    [drafts, showNotification, t]
  );

  /* ---------- save ---------- */

  const handleDiscard = useCallback(() => {
    setPolicy((prev) => (prev ? { baseline: prev.baseline, settings: prev.baseline } : prev));
    setDrafts({});
  }, []);

  const handleSave = useCallback(async () => {
    if (!plan || !validation?.valid || saving || !connected) return;
    const revision = apiClient.getConnectionRevision();
    const assertConnection = () => {
      if (revision !== apiClient.getConnectionRevision()) {
        throw new DOMException('The management connection changed.', 'AbortError');
      }
    };
    setSaving(true);
    try {
      if (hasConfigChanges(plan)) {
        try {
          if (Object.keys(plan.routingPatch).length) {
            await routingApi.patchRouting(plan.routingPatch);
          }
          for (const path of plan.routingDeletions) {
            assertConnection();
            await routingApi.deleteRoutingField(path);
          }
          if (Object.keys(plan.upstreamPatch).length) {
            assertConnection();
            await routingApi.patchUpstreamCooling(plan.upstreamPatch);
          }
        } catch (err: unknown) {
          if (isAbort(err)) return;
          showNotification(
            t('routing.save_failed', { message: getErrorMessage(err, t('common.unknown_error')) }),
            'error'
          );
          // The patch may have partly landed; re-read without dropping drafts.
          await loadAll();
          return;
        }
      }

      const saved: string[] = [];
      const failed: string[] = [];
      const savedExcluded: Record<string, ExcludedBaseline> = {};
      for (const patch of plan.credentialPatches) {
        assertConnection();
        try {
          await authFilesApi.patchFields(patch.name, patch.fields);
          saved.push(patch.name);
          const previous = excludedBaselines[patch.name];
          const models = previous ? patch.fields[previous.field] : undefined;
          if (previous && models) savedExcluded[patch.name] = { ...previous, models };
        } catch (err: unknown) {
          failed.push(`${patch.label} (${getErrorMessage(err, t('common.unknown_error'))})`);
        }
      }
      assertConnection();

      setDrafts((prev) => pruneSavedDrafts(prev, saved));
      setExcluded((prev) => {
        const next = { ...prev };
        for (const [key, baseline] of Object.entries(savedExcluded)) {
          next[key] = { status: 'ready', baseline };
        }
        return next;
      });
      await useConfigStore
        .getState()
        .fetchConfig(true)
        .catch(() => undefined);
      notifyAuthFilesChanged();
      await loadAll({ resetPolicy: true });

      if (failed.length) {
        showNotification(
          t('routing.save_partial', {
            failed: failed.length,
            total: plan.credentialPatches.length,
            names: failed.join(', '),
          }),
          'warning'
        );
      } else {
        showNotification(t('routing.save_success'), 'success');
      }
    } catch (err: unknown) {
      if (!isAbort(err)) {
        showNotification(
          t('routing.save_failed', { message: getErrorMessage(err, t('common.unknown_error')) }),
          'error'
        );
      }
    } finally {
      setSaving(false);
    }
  }, [connected, excludedBaselines, loadAll, plan, saving, showNotification, t, validation?.valid]);

  /* ---------- render ---------- */

  const invalidCount = validation
    ? Object.keys(validation.settings).length +
      Object.values(validation.credentials).reduce(
        (sum, errors) => sum + Object.keys(errors).length,
        0
      )
    : 0;
  const statusTone: ConfigStatusTone = saving ? 'busy' : invalidCount ? 'error' : 'warning';
  const statusText = saving
    ? t('routing.saving')
    : invalidCount
      ? t('routing.status_invalid', { count: invalidCount })
      : t('routing.changes', { count: changeCount });

  const showSkeleton = loading && !policy;

  return (
    <div className={styles.page}>
      {isCurrentLayer && dirty && <UnsavedChangesGuard shouldBlock dialog={unsavedDialog} />}
      <RoutingHeader
        credentialCount={credentials.length}
        providerCount={pools.length}
        strategy={policy?.baseline.strategy ?? null}
        sticky={policy ? policy.baseline.sessionAffinity : null}
        loading={loading}
        refreshDisabled={!connected || saving}
        onRefresh={() => void loadAll()}
      />

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {showSkeleton ? (
        <RowGroups>
          <Skeleton height={232} rounded={12} />
          <Skeleton height={120} rounded={12} />
        </RowGroups>
      ) : (
        <RowGroups>
          {policy && (
            <RoutingSettingsGroup
              settings={policy.settings}
              errors={validation?.settings ?? {}}
              disabled={controlsDisabled}
              stickyNote={stickyResetRisk(policy.baseline, policy.settings)}
              onChange={(patch) =>
                setPolicy((prev) =>
                  prev
                    ? { baseline: prev.baseline, settings: { ...prev.settings, ...patch } }
                    : prev
                )
              }
            />
          )}
          {pools.map((pool) => (
            <RoutingPoolGroup
              key={pool.provider}
              provider={pool.provider}
              credentials={pool.credentials}
              tiers={groupIntoTiers(pool.credentials, drafts)}
              drafts={drafts}
              errors={validation?.credentials ?? {}}
              weighted={weighted}
              nowMs={nowMs}
              resolvedTheme={resolvedTheme}
              disabled={controlsDisabled}
              expanded={expanded}
              excluded={excluded}
              busyKeys={busy}
              handlers={handlers}
              onPreset={(kind) => handlePreset(pool.credentials, kind)}
            />
          ))}
          {!loading && !error && pools.length === 0 && (
            <EmptyState title={t('routing.empty_title')} description={t('routing.empty_desc')} />
          )}
        </RowGroups>
      )}

      <FloatingSaveBar
        visible={isCurrentLayer && dirty}
        statusText={statusText}
        statusTone={statusTone}
        saving={saving}
        saveDisabled={saving || !connected || invalidCount > 0}
        discardDisabled={saving}
        onSave={() => void handleSave()}
        onDiscard={handleDiscard}
      />
    </div>
  );
}
