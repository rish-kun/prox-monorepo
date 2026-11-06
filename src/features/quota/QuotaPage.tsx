/**
 * 额度查询页：按提供商分组的紧凑账户行。
 *
 * - 每个提供商一组：一行容量头（每账户一个方块 + 可用数）+ 每账户一行；
 *   行内列出全部额度窗口（剩余 %、重置时刻、倒计时），状态列只在
 *   5 小时 / 周窗口耗尽或登录失效时出声；展开行显示完整明细与操作。
 * - 数据默认来自代理被动记录的上游限额响应头（随凭证列表返回，零上游请求）；
 *   进入页面与标签页重新可见时只重取本地凭证列表（10s 节流）。主动查询上游
 *   用量接口（Anthropic /api/oauth/usage 等，限流严格）只在用户点击刷新时发生，
 *   其结果与被动窗口合并（同名窗口以被动数据为准，模型窗口保留）。
 *   Devin 首次可见时另外主动查询一次；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - Claude / Codex 额度只来自代理：代理每小时轮询一次并保存快照，本页加载时
 *   读 GET /quota/snapshots 回填（零上游请求），刷新走 POST /quota/refresh
 *   （刷新全部 / 分组刷新合并为一个请求）；顶部是剩余额度预测图；
 * - 其他提供商主动查询成功的结果写入 localStorage（按 API base 隔离），重载后回填，
 *   时间线与模型窗口无需再打一次上游；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 * - "Prioritise plan": Claude / Codex rows with a running 5-hour window can be
 *   routed first until that window resets (GET/POST/DELETE /quota/burst, polled
 *   every 60 s); the forecast drains bursting accounts first.
 */

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronDown } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaAccountRow } from './components/QuotaAccountRow';
import { QuotaProviderGroup } from './components/QuotaProviderGroup';
import { QuotaRoutingOrder } from './components/QuotaRoutingOrder';
import { routingOrder } from './routingOrder';
import { QuotaTimeline } from './components/QuotaTimeline';
import { QuotaForecast } from './components/QuotaForecast';
import { QUOTA_TAB_ORDER } from './constants';
import {
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  shouldAutoRefreshQuota,
  type QuotaFileEntry,
} from './logic';
import {
  canPrioritiseQuotaRow,
  canPrioritiseWeeklyQuotaRow,
  canStartQuotaWindow,
  limitColumnCount,
  orderQuotaLimits,
  resolveQuotaRowStatus,
  summarizeQuotaLimits,
  type QuotaLimitSummary,
  type QuotaRowStatus,
} from './quotaRowSummary';
import {
  mergeQuotaLimits,
  readPassiveQuota,
  rollOverLimits,
  shouldClearStaleCooldown,
} from './passiveQuota';
import { readSavedQuota, syncSavedQuota } from './quotaPersistence';
import { isProxyQuotaType } from './proxyQuota';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { useProxyQuotaHydration } from './hooks/useProxyQuotaHydration';
import { useQuotaBursts } from './hooks/useQuotaBursts';
import { rowBurstsByIndex, toForecastBursts } from './quotaBurst';
import { readQuotaViewPrefs, writeQuotaViewPrefs } from './uiState';
import styles from './QuotaPage.module.scss';

const SKELETON_ROW_COUNT = 3;

/** Claude / Codex are hydrated from the proxy's snapshots instead of localStorage. */
const PERSISTED_QUOTA_TYPES = QUOTA_TAB_ORDER.filter((type) => !isProxyQuotaType(type));
const PROXY_FORECAST_PROVIDERS = ['claude', 'codex'] as const;

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

interface AccountRowModel {
  entry: QuotaFileEntry;
  key: string;
  quota: QuotaCardState | undefined;
  limits: QuotaLimitSummary[];
  status: QuotaRowStatus;
  livePlanType: string | null;
  /** Fetched state with live windows overlaid — what the reset timeline draws. */
  timelineQuota: QuotaCardState | undefined;
  /** A newer fetch shows quota back while the proxy still holds a cooldown. */
  staleCooldown: boolean;
  /** The 5-hour window is idle and can be opened on demand. */
  canStartWindow: boolean;
  authIndex: string | null;
  /** The 5-hour window is running with quota left: it can be prioritised. */
  canPrioritise: boolean;
  /** The weekly window is running with quota left: it can be prioritised until its reset. */
  canPrioritiseWeekly: boolean;
}

/**
 * Claude/Codex lanes are built from `windows`, so overlay the merged limits as
 * windows on top of the fetched state (keeping e.g. Codex reset credits). The
 * raw reset instants are kept: the timeline projects later windows from them.
 */
function buildTimelineQuota(
  type: QuotaProviderType,
  fetched: QuotaCardState | undefined,
  limits: readonly QuotaLimitSummary[],
  labelOf: (limit: QuotaLimitSummary) => string
): QuotaCardState | undefined {
  if (type !== 'claude' && type !== 'codex') return fetched;
  if (limits.length === 0) return fetched;
  const base = fetched?.status === 'success' ? fetched : {};
  return {
    ...base,
    status: 'success',
    windows: limits.map((limit) => ({
      id: limit.id,
      label: labelOf(limit),
      usedPercent: limit.remaining === null ? null : 100 - limit.remaining,
      resetAtMs: limit.resetAtMs,
      periodHours: limit.periodHours,
    })),
  } as QuotaCardState;
}

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [timelineOpen, setTimelineOpen] = useState(() => readQuotaViewPrefs().timelineOpen);
  const [forecastOpen, setForecastOpen] = useState(() => readQuotaViewPrefs().forecastOpen);
  // 页头的入场级联（标题 → meta → 动作）
  const revealRef = useRevealGroup<HTMLDivElement>();
  const now = useNow();

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ---------- */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- 归类：每个提供商一组，组内保持文件顺序（刷新不跳行） ---------- */

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);

  const groups = useMemo(() => {
    const byType = new Map<QuotaProviderType, AccountRowModel[]>();
    for (const entry of entries) {
      const quota = getQuota(entry);
      const live = readPassiveQuota(entry.type, entry.file);
      const fetchedAtMs = quota?.status === 'success' ? (quota.fetchedAtMs ?? null) : null;
      const rawLimits = orderQuotaLimits(
        mergeQuotaLimits(summarizeQuotaLimits(entry.type, quota), live.limits, {
          fetchedAtMs,
          liveObservedAtMs: live.observedAtMs,
        })
      );
      const limits = rollOverLimits(rawLimits, now);
      const status = resolveQuotaRowStatus(quota, Boolean(entry.file.disabled), limits);
      const row: AccountRowModel = {
        entry,
        key: `${entry.type}:${getQuotaCacheKey(entry.file)}`,
        quota,
        limits,
        status,
        livePlanType: live.planType,
        timelineQuota: buildTimelineQuota(entry.type, quota, rawLimits, (limit) =>
          limit.labelKey
            ? t(limit.labelKey, { ...limit.labelParams, defaultValue: limit.label })
            : limit.label
        ),
        staleCooldown: shouldClearStaleCooldown(
          entry.file,
          limits,
          fetchedAtMs,
          live.observedAtMs,
          now
        ),
        canStartWindow: canStartQuotaWindow(entry.type, status, limits, now),
        authIndex: normalizeAuthIndex(entry.file['auth_index'] ?? entry.file.authIndex),
        canPrioritise: canPrioritiseQuotaRow(entry.type, status, limits, now),
        canPrioritiseWeekly: canPrioritiseWeeklyQuotaRow(entry.type, status, limits, now),
      };
      const list = byType.get(entry.type) ?? [];
      list.push(row);
      byType.set(entry.type, list);
    }
    return QUOTA_TAB_ORDER.filter((type) => byType.has(type)).map((type) => ({
      type,
      rows: byType.get(type) as AccountRowModel[],
    }));
  }, [entries, getQuota, now, t]);

  const timelineQuotaByKey = useMemo(() => {
    const map = new Map<string, QuotaCardState | undefined>();
    groups.forEach(({ rows }) => rows.forEach((row) => map.set(row.key, row.timelineQuota)));
    return map;
  }, [groups]);

  const getTimelineQuota = useCallback(
    (entry: QuotaFileEntry) =>
      timelineQuotaByKey.get(`${entry.type}:${getQuotaCacheKey(entry.file)}`),
    [timelineQuotaByKey]
  );

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    groups.forEach(({ rows }) =>
      rows.forEach((row) => {
        if (row.limits.length > 0) loaded += 1;
        if (row.status.kind === 'error' || row.status.kind === 'logged_out') attention += 1;
      })
    );
    return { loadedCount: loaded, attentionCount: attention };
  }, [groups]);

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  // 回填：文件列表落定后，用上次主动查询成功的结果补齐尚无状态的凭证。
  const listSettled = !loading && !error && filesGeneration === sessionGeneration;
  // Claude / Codex: the proxy's latest snapshots, re-read with every list load.
  useProxyQuotaHydration(files, listSettled && !disableControls);
  useEffect(() => {
    if (!listSettled || !apiBase) return;
    PERSISTED_QUOTA_TYPES.forEach((type) => {
      const saved = readSavedQuota(apiBase, type);
      const keys = entries
        .filter((entry) => entry.type === type)
        .map((entry) => getQuotaCacheKey(entry.file))
        .filter((key) => saved[key]);
      if (keys.length === 0) return;
      getQuotaSetter(QUOTA_ADAPTERS[type])((prev) => {
        const missing = keys.filter((key) => !prev[key] || prev[key].status === 'idle');
        if (missing.length === 0) return prev;
        const next = { ...prev };
        missing.forEach((key) => {
          const state = saved[key].state as QuotaCardState;
          next[key] = { ...state, fetchedAtMs: state.fetchedAtMs ?? saved[key].savedAtMs };
        });
        return next;
      });
    });
  }, [apiBase, entries, listSettled]);

  // 持久化：每次主动查询成功后保存（失败/加载中不覆盖已保存的成功结果）。
  useEffect(() => {
    if (!listSettled || !apiBase) return;
    const survivors: Partial<Record<QuotaProviderType, Set<string>>> = {};
    PERSISTED_QUOTA_TYPES.forEach((type) => {
      survivors[type] = new Set();
    });
    entries.forEach((entry) => survivors[entry.type]?.add(getQuotaCacheKey(entry.file)));
    syncSavedQuota(apiBase, quotaByType, survivors, Date.now());
  }, [apiBase, entries, listSettled, quotaByType]);

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);
  const lastListAtRef = useRef<number | null>(null);

  // 刷新全部（仅用户点击）：先重取文件列表，待其落定（loading 下降沿）再批量拉全部额度
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    lastListAtRef.current = Date.now();
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  // 标签页重新激活时只重取本地凭证列表（携带被动额度），不打上游用量接口。
  const onPageActivated = useEffectEvent(() => {
    if (document.visibilityState !== 'visible') return;
    if (disableControls || loading) return;
    if (!shouldAutoRefreshQuota(lastListAtRef.current, Date.now())) return;
    lastListAtRef.current = Date.now();
    void loadFiles();
  });

  useEffect(() => {
    const listener = () => onPageActivated();
    document.addEventListener('visibilitychange', listener);
    window.addEventListener('focus', listener);
    return () => {
      document.removeEventListener('visibilitychange', listener);
      window.removeEventListener('focus', listener);
    };
  }, []);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(entries);
    }
  }, [disableControls, entries, error, filesGeneration, loading, loadQuota, sessionGeneration]);

  // 冷却清除：主动查询比代理被动观测更新、且显示额度已恢复（如手动重置周额度），
  // 而代理仍把该凭证挂在冷却中时，清除其路由冷却并重取列表。每次查询结果只尝试一次。
  const clearedCooldownRef = useRef(new Set<string>());
  useEffect(() => {
    if (disableControls || !listSettled) return;
    const pending = groups
      .flatMap(({ rows }) => rows)
      .filter((row) => row.staleCooldown)
      .map((row) => ({
        attempt: `${row.key}@${row.quota?.fetchedAtMs ?? ''}`,
        authIndex: row.authIndex,
      }))
      .filter(({ attempt, authIndex }) => authIndex && !clearedCooldownRef.current.has(attempt));
    if (pending.length === 0) return;
    pending.forEach(({ attempt }) => clearedCooldownRef.current.add(attempt));
    void Promise.allSettled(
      pending.map(({ authIndex }) => authFilesApi.resetCooldown(authIndex as string))
    ).then(() => loadFiles());
  }, [disableControls, groups, listSettled, loadFiles]);

  useDevinQuotaAutoLoad(
    entries,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  // 启动 5 小时窗口：经代理向该凭证发一条最便宜的 "hi"，响应头随即刷新被动额度，
  // 重取本地列表即可看到新窗口（不调用上游用量接口）。
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [startingWindowKeys, setStartingWindowKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const startWindow = useCallback(
    async (row: AccountRowModel) => {
      const authIndex = normalizeAuthIndex(
        row.entry.file['auth_index'] ?? row.entry.file.authIndex
      );
      const name = row.entry.file.email || row.entry.file.name;
      if (!authIndex || startingWindowKeys.has(row.key)) return;
      setStartingWindowKeys((prev) => new Set(prev).add(row.key));
      try {
        await authFilesApi.startQuotaWindow(authIndex);
        showNotification(t('quota_management.start_window_success', { name }), 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        showNotification(t('quota_management.start_window_failed', { name, message }), 'error');
      } finally {
        setStartingWindowKeys((prev) => {
          const next = new Set(prev);
          next.delete(row.key);
          return next;
        });
        void loadFiles();
      }
    },
    [loadFiles, showNotification, startingWindowKeys, t]
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleForecast = useCallback(() => {
    setForecastOpen((prev) => {
      writeQuotaViewPrefs({ forecastOpen: !prev });
      return !prev;
    });
  }, []);

  const forecastProviders = useMemo(
    () => PROXY_FORECAST_PROVIDERS.filter((type) => entries.some((entry) => entry.type === type)),
    [entries]
  );

  /* ---------- Prioritise plan ---------- */

  const {
    bursts,
    supported: burstsSupported,
    pending: burstPending,
    run: runBurst,
  } = useQuotaBursts(!disableControls && forecastProviders.length > 0, now);
  const rowBursts = useMemo(() => {
    const typeOf = new Map(
      entries.map((entry) => [
        normalizeAuthIndex(entry.file['auth_index'] ?? entry.file.authIndex),
        entry.type,
      ])
    );
    return rowBurstsByIndex(bursts, (authIndex) => typeOf.get(authIndex) ?? '');
  }, [bursts, entries]);
  const forecastBurstList = useMemo(() => toForecastBursts(bursts), [bursts]);

  const toggleTimeline = useCallback(() => {
    setTimelineOpen((prev) => {
      writeQuotaViewPrefs({ timelineOpen: !prev });
      return !prev;
    });
  }, []);

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && entries.length === 0;

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        onRefreshAll={handleRefreshAll}
      />

      <section className={styles.workbench}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {forecastProviders.length > 0 && (
          <QuotaForecast
            providers={forecastProviders}
            files={files}
            open={forecastOpen}
            onToggle={toggleForecast}
            enabled={!disableControls}
            bursts={forecastBurstList}
          />
        )}

        {loading && entries.length === 0 ? (
          <div className={styles.groups} aria-hidden="true">
            {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
              <Skeleton key={index} height={64} rounded={12} />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            title={t('quota_management.empty_title')}
            description={t('quota_management.empty_desc')}
          />
        ) : (
          <div className={styles.groups}>
            {groups.map(({ type, rows }) => (
              <QuotaProviderGroup
                key={type}
                type={type}
                statuses={rows.map((row) => row.status)}
                now={now}
                resolvedTheme={resolvedTheme}
                refreshing={batchLoading}
                canRefresh={canUseActions}
                onRefresh={() => void loadQuota(rows.map((row) => row.entry))}
                limitColumns={limitColumnCount(rows.map((row) => row.limits.length))}
                routing={
                  <QuotaRoutingOrder
                    now={now}
                    steps={routingOrder(
                      rows.map((row) => ({
                        authIndex: row.authIndex,
                        name: row.entry.file.email || row.entry.file.name,
                        priority:
                          typeof row.entry.file.priority === 'number' ? row.entry.file.priority : 0,
                        disabled: Boolean(row.entry.file.disabled),
                        status: row.status,
                        coolingDown: Boolean(row.entry.file.unavailable) && !row.staleCooldown,
                        burst: row.authIndex ? (rowBursts.get(row.authIndex) ?? null) : null,
                      }))
                    )}
                  />
                }
              >
                {rows.map((row) => {
                  const burst = row.authIndex ? (rowBursts.get(row.authIndex) ?? null) : null;
                  const burstName = row.entry.file.email || row.entry.file.name;
                  return (
                    <QuotaAccountRow
                      key={row.key}
                      entry={row.entry}
                      quota={row.quota}
                      limits={row.limits}
                      status={row.status}
                      livePlanType={row.livePlanType}
                      now={now}
                      resolvedTheme={resolvedTheme}
                      expanded={expanded.has(row.key)}
                      canRefresh={canUseActions && !row.entry.file.disabled}
                      resetting={resettingQuotaName === getQuotaCacheKey(row.entry.file)}
                      canStartWindow={row.canStartWindow}
                      startingWindow={startingWindowKeys.has(row.key)}
                      onStartWindow={() => void startWindow(row)}
                      burst={burst}
                      canPrioritise={
                        burstsSupported && !burst && row.canPrioritise && Boolean(row.authIndex)
                      }
                      burstPending={row.authIndex ? burstPending.has(row.authIndex) : false}
                      canPrioritiseWeekly={
                        burstsSupported &&
                        !burst &&
                        row.canPrioritiseWeekly &&
                        Boolean(row.authIndex)
                      }
                      onPrioritise={() => {
                        if (row.authIndex) void runBurst('prioritise', row.authIndex, burstName);
                      }}
                      onPrioritiseWeekly={() => {
                        if (row.authIndex) {
                          void runBurst('prioritise', row.authIndex, burstName, 'weekly');
                        }
                      }}
                      onStopBurst={() => {
                        if (row.authIndex) void runBurst('cancel', row.authIndex, burstName);
                      }}
                      onToggle={() => toggleExpanded(row.key)}
                      onRefresh={() =>
                        void refreshQuota(row.entry.file, QUOTA_ADAPTERS[row.entry.type])
                      }
                      onReset={() => resetQuota(row.entry.file, QUOTA_ADAPTERS[row.entry.type])}
                    />
                  );
                })}
              </QuotaProviderGroup>
            ))}
          </div>
        )}

        {entries.length > 0 && (
          <div className={styles.timelineSection}>
            <button
              type="button"
              className={styles.timelineToggle}
              aria-expanded={timelineOpen}
              onClick={toggleTimeline}
            >
              <IconChevronDown
                size={14}
                aria-hidden="true"
                className={`${styles.timelineChevron} ${timelineOpen ? styles.timelineChevronOpen : ''}`}
              />
              {t('quota_management.timeline_toggle')}
            </button>
            {timelineOpen && (
              <QuotaTimeline
                entries={entries}
                quotaFor={getTimelineQuota}
                displayNameFor={displayNameFor}
                resolvedTheme={resolvedTheme}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
