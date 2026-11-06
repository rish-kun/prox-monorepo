/**
 * Breakdown table (provider / account / model). Sortable headers, mono
 * tabular figures, compact token counts with the exact value on hover.
 * Cost reads "—" + "unpriced" when nothing in the row has a price, and gets a
 * "partial" marker when only some of it does.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/format';
import { costState, formatUsd, type SortKey, type UsageSort, type UsageTotals } from '../model';
import styles from './UsageTable.module.scss';

export interface UsageTableRow {
  key: string;
  identity: ReactNode;
  title?: string;
  totals: UsageTotals;
  /** Set on fully unpriced rows that can be fixed by adding a price. */
  onAddPrice?: () => void;
}

export interface UsageTableSection {
  key: string;
  /** Sub-header row (e.g. the provider above its accounts). */
  heading?: ReactNode;
  rows: UsageTableRow[];
}

const COLUMNS: Array<{ key: SortKey; labelKey: string }> = [
  { key: 'requests', labelKey: 'usage.col_requests' },
  { key: 'input', labelKey: 'usage.col_input' },
  { key: 'cacheRead', labelKey: 'usage.col_cache_read' },
  { key: 'cacheWrite', labelKey: 'usage.col_cache_write' },
  { key: 'output', labelKey: 'usage.col_output' },
  { key: 'total', labelKey: 'usage.col_total' },
  { key: 'cost', labelKey: 'usage.col_cost' },
];

function Tokens({ value }: { value: number }) {
  return (
    <td className={value === 0 ? styles.muted : undefined} title={value.toLocaleString()}>
      {formatCompactNumber(value)}
    </td>
  );
}

export function CostValue({
  totals,
  locale,
  onAddPrice,
}: {
  totals: UsageTotals;
  locale?: string;
  onAddPrice?: () => void;
}) {
  const { t } = useTranslation();
  const state = costState(totals);
  if (state === 'none') {
    return (
      <>
        <span className={styles.muted}>—</span>
        {onAddPrice ? (
          <button
            type="button"
            className={`${styles.marker} ${styles.markerButton}`}
            onClick={onAddPrice}
            title={t('usage.unpriced_hint')}
          >
            {t('usage.unpriced')}
          </button>
        ) : (
          <span className={styles.marker} title={t('usage.unpriced_hint')}>
            {t('usage.unpriced')}
          </span>
        )}
      </>
    );
  }
  return (
    <>
      {formatUsd(totals.cost, locale)}
      {state === 'partial' && (
        <span className={styles.marker} title={t('usage.partial_hint')}>
          {t('usage.partial')}
        </span>
      )}
    </>
  );
}

interface UsageTableProps {
  label: string;
  firstColumn: string;
  sections: UsageTableSection[];
  sort: UsageSort;
  onSort: (key: SortKey) => void;
}

export function UsageTable({ label, firstColumn, sections, sort, onSort }: UsageTableProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  return (
    <div className={styles.scroll}>
      <table className={styles.table} aria-label={label}>
        <thead>
          <tr>
            <th scope="col" className={styles.identityHead}>
              {firstColumn}
            </th>
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    type="button"
                    className={`${styles.sortButton} ${active ? styles.sortActive : ''}`}
                    onClick={() => onSort(column.key)}
                  >
                    {t(column.labelKey)}
                    <span className={styles.sortArrow} aria-hidden="true">
                      {active ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={section.key}>
            {section.heading !== undefined && (
              <tr className={styles.subhead}>
                <th scope="colgroup" colSpan={COLUMNS.length + 1}>
                  {section.heading}
                </th>
              </tr>
            )}
            {section.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className={styles.identity} title={row.title}>
                  {row.identity}
                </th>
                <td>
                  {row.totals.requests.toLocaleString()}
                  {row.totals.failed > 0 && (
                    <span
                      className={styles.failed}
                      title={t('usage.failed_count', { count: row.totals.failed })}
                    >
                      {' '}
                      · {row.totals.failed.toLocaleString()}
                    </span>
                  )}
                </td>
                <Tokens value={row.totals.input} />
                <Tokens value={row.totals.cacheRead} />
                <Tokens value={row.totals.cacheWrite} />
                <Tokens value={row.totals.output} />
                <td className={styles.strong} title={row.totals.total.toLocaleString()}>
                  {formatCompactNumber(row.totals.total)}
                </td>
                <td className={styles.strong}>
                  <CostValue totals={row.totals} locale={locale} onAddPrice={row.onAddPrice} />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
