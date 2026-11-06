/**
 * Usage: tokens the proxy has carried — per provider, account and model —
 * over time, with what they would have cost at public API prices.
 *
 * Data comes from the proxy's usage recorder (`/usage/summary`); every
 * derivation is in model.ts, prices in pricing.ts (defaults + local
 * overrides). Cost is an API-equivalent estimate, never a bill, and unpriced
 * models are flagged rather than counted as $0.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PageToolbarSlot } from '@/components/layout/PageToolbar';
import { RowGroup, RowGroups } from '@/components/common/GroupedRows';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { providerLabel } from '@/features/dashboard/utils';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useThemeStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { formatCompactNumber } from '@/utils/format';
import { CostValue, UsageTable, type UsageTableSection } from './components/UsageTable';
import { PricesEditor } from './components/PricesEditor';
import { UsageChart, type ChartMetric } from './components/UsageChart';
import {
  DEFAULT_SORT,
  USAGE_RANGES,
  fillBuckets,
  groupByAccount,
  groupByModel,
  groupByProvider,
  liveAccountNames,
  priceRows,
  resolveAccountName,
  sortGroups,
  sumRows,
  type SortKey,
  type UsageRange,
  type UsageSort,
} from './model';
import { normalizeModelId } from './pricing';
import { usePrices } from './usePrices';
import { useUsageData } from './useUsageData';
import styles from './usage.module.scss';

const DASH = '—';

/** Six digits stay exact; beyond that compact so the strip never overflows. */
const formatCount = (value: number): string =>
  value < 1_000_000 ? value.toLocaleString() : formatCompactNumber(value);

function ProviderIcon({ provider, theme }: { provider: string; theme: ResolvedTheme }) {
  const src = getAuthFileIcon(provider, theme);
  return (
    <span
      className={styles.icon}
      style={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(theme) }
          : undefined
      }
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" /> : provider.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.segment} ${option.value === value ? styles.segmentActive : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const theme = useThemeStore((state) => state.resolvedTheme);

  const [range, setRange] = useState<UsageRange>('24h');
  const [metric, setMetric] = useState<ChartMetric>('tokens');
  const [sort, setSort] = useState<UsageSort>(DEFAULT_SORT);
  const [pricesOpen, setPricesOpen] = useState(false);
  const [draftModel, setDraftModel] = useState('');
  const pricesRef = useRef<HTMLDivElement>(null);

  const data = useUsageData(range);
  const { summary, query, files, error } = data;
  useHeaderRefresh(data.refresh, data.connected);
  const prices = usePrices();

  const priced = useMemo(
    () => (summary ? priceRows(summary.rows, prices.table) : []),
    [summary, prices.table]
  );
  const totals = useMemo(() => sumRows(priced), [priced]);
  const buckets = useMemo(
    () => (summary && query ? fillBuckets(priced, query, summary.firstRecordedAt) : []),
    [priced, query, summary]
  );
  const liveNames = useMemo(() => liveAccountNames(files ?? []), [files]);

  const onSort = useCallback((key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: 'desc' }
    );
  }, []);

  const openPricesFor = useCallback((model: string) => {
    setDraftModel(normalizeModelId(model));
    setPricesOpen(true);
    window.requestAnimationFrame(() =>
      pricesRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    );
  }, []);

  const unattributed = t('usage.unattributed');
  const providerName = (provider: string) => providerLabel(provider, unattributed);
  const providerIdentity = (provider: string): ReactNode => (
    <span className={styles.identity}>
      <ProviderIcon provider={provider} theme={theme} />
      <span className={styles.name}>{providerName(provider)}</span>
    </span>
  );

  const providerSections: UsageTableSection[] = [
    {
      key: 'providers',
      rows: sortGroups(groupByProvider(priced), sort).map((group) => ({
        key: group.key,
        identity: providerIdentity(group.provider),
        title: providerName(group.provider),
        totals: group.totals,
      })),
    },
  ];

  const accountSections: UsageTableSection[] = groupByAccount(priced, sort).map((provider) => ({
    key: provider.key,
    heading: providerIdentity(provider.provider),
    rows: provider.accounts.map((account) => {
      const resolved = resolveAccountName(account.authIndex, liveNames, summary?.accounts ?? {});
      const name = resolved?.name ?? unattributed;
      return {
        key: account.key,
        identity: (
          <span className={`${styles.name} ${resolved?.mono ? styles.monoName : ''}`}>{name}</span>
        ),
        title: name,
        totals: account.totals,
      };
    }),
  }));

  const modelSections: UsageTableSection[] = [
    {
      key: 'models',
      rows: sortGroups(groupByModel(priced), sort).map((group) => ({
        key: group.key,
        identity: <span className={`${styles.name} ${styles.monoName}`}>{group.model}</span>,
        title: group.priceKey ? `${group.model} → ${group.priceKey}` : group.model,
        totals: group.totals,
        onAddPrice: group.priceKey ? undefined : () => openPricesFor(group.model),
      })),
    },
  ];

  const loaded = summary !== null;
  const hasRows = priced.length > 0;
  const overrideCount = Object.keys(prices.overrides).length;

  const rangeOptions = USAGE_RANGES.map((value) => ({
    value,
    label: t(`usage.range_${value}`),
  }));

  const firstRecorded = summary?.firstRecordedAt
    ? new Date(summary.firstRecordedAt * 1000).toLocaleString(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  const errorText = error
    ? error.status === 404
      ? t('usage.error_unsupported')
      : error.status === 503
        ? t('usage.error_unavailable')
        : t('usage.error_generic', { message: error.message || String(error.status ?? '') })
    : null;

  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>{t('usage.title')}</h1>

      <div className={styles.toolbar}>
        <Segmented
          label={t('usage.range_aria')}
          options={rangeOptions}
          value={range}
          onChange={setRange}
        />
        {errorText && loaded && <span className={styles.toolbarError}>{errorText}</span>}
        <PageToolbarSlot />
      </div>

      {!loaded && errorText ? (
        <EmptyState title={errorText} />
      ) : loaded && !hasRows ? (
        <EmptyState
          title={t('usage.empty_title')}
          description={
            firstRecorded
              ? t('usage.empty_desc_range', { date: firstRecorded })
              : t('usage.empty_desc_new')
          }
        />
      ) : (
        <>
          <section className={styles.kpis} aria-label={t('usage.kpi_aria')}>
            <dl className={styles.kpiList}>
              <div className={styles.kpi}>
                <dt className={styles.kpiLabel}>{t('usage.kpi_tokens')}</dt>
                <dd className={styles.kpiValue} title={loaded ? totals.total.toLocaleString() : ''}>
                  {loaded ? formatCount(totals.total) : DASH}
                </dd>
              </div>
              <div className={styles.kpi} title={t('usage.kpi_cost_hint')}>
                <dt className={styles.kpiLabel}>{t('usage.kpi_cost')}</dt>
                <dd className={styles.kpiValue}>
                  {loaded ? <CostValue totals={totals} locale={locale} /> : DASH}
                </dd>
              </div>
              <div className={styles.kpi}>
                <dt className={styles.kpiLabel}>{t('usage.kpi_requests')}</dt>
                <dd className={styles.kpiValue}>
                  {loaded ? formatCount(totals.requests) : DASH}
                  {loaded && totals.failed > 0 && (
                    <span className={styles.kpiFailed}>
                      {t('usage.failed_count', { count: totals.failed })}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <RowGroups>
            <RowGroup
              label={t('usage.chart_title')}
              title={t('usage.chart_title')}
              actions={
                <Segmented
                  label={t('usage.chart_metric_aria')}
                  options={[
                    { value: 'tokens' as const, label: t('usage.chart_tokens') },
                    { value: 'cost' as const, label: t('usage.chart_cost') },
                  ]}
                  value={metric}
                  onChange={setMetric}
                />
              }
            >
              {buckets.length > 0 && query ? (
                <div className={styles.chartBody}>
                  <UsageChart buckets={buckets} bucket={query.bucket} metric={metric} />
                </div>
              ) : (
                <p className={styles.empty}>{DASH}</p>
              )}
            </RowGroup>

            {hasRows && (
              <>
                <RowGroup label={t('usage.by_provider')} title={t('usage.by_provider')}>
                  <UsageTable
                    label={t('usage.by_provider')}
                    firstColumn={t('usage.col_provider')}
                    sections={providerSections}
                    sort={sort}
                    onSort={onSort}
                  />
                </RowGroup>
                <RowGroup label={t('usage.by_account')} title={t('usage.by_account')}>
                  <UsageTable
                    label={t('usage.by_account')}
                    firstColumn={t('usage.col_account')}
                    sections={accountSections}
                    sort={sort}
                    onSort={onSort}
                  />
                </RowGroup>
                <RowGroup label={t('usage.by_model')} title={t('usage.by_model')}>
                  <UsageTable
                    label={t('usage.by_model')}
                    firstColumn={t('usage.col_model')}
                    sections={modelSections}
                    sort={sort}
                    onSort={onSort}
                  />
                </RowGroup>
              </>
            )}
          </RowGroups>
        </>
      )}

      <div
        ref={pricesRef}
        className={`${styles.pricesAnchor} ${pricesOpen ? '' : styles.pricesCollapsed}`}
      >
        <RowGroup
          label={t('usage.prices_title')}
          title={t('usage.prices_title')}
          summary={
            <>
              <span className={styles.muted}>{t('usage.prices_unit')}</span>
              {overrideCount > 0 && (
                <span>{t('usage.prices_edited', { count: overrideCount })}</span>
              )}
            </>
          }
          actions={
            <>
              {overrideCount > 0 && (
                <button type="button" className={styles.headButton} onClick={prices.reset}>
                  {t('usage.prices_reset')}
                </button>
              )}
              <button
                type="button"
                className={styles.headButton}
                aria-expanded={pricesOpen}
                aria-controls={pricesOpen ? 'usage-prices' : undefined}
                onClick={() => setPricesOpen((open) => !open)}
              >
                {pricesOpen ? t('usage.prices_hide') : t('usage.prices_show')}
              </button>
            </>
          }
        >
          {pricesOpen ? (
            <div id="usage-prices">
              <PricesEditor
                table={prices.table}
                overrides={prices.overrides}
                onSet={prices.setPrice}
                onRemove={prices.removePrice}
                draftModel={draftModel}
                onDraftModelChange={setDraftModel}
              />
            </div>
          ) : null}
        </RowGroup>
      </div>
    </div>
  );
}
