/**
 * A bordered group of rows with a one-line header — the quota page's
 * provider group, shared so every list page reads the same way.
 */

import type { ReactNode } from 'react';
import styles from './GroupedRows.module.scss';

export type RowGroupProps = {
  /** Accessible name for the section (usually the title text). */
  label: string;
  icon?: ReactNode;
  /** Inline style for the icon well (e.g. theme-surface backgrounds). */
  iconStyle?: React.CSSProperties;
  title: ReactNode;
  /** Compact facts after the title: counts, status squares, links. */
  summary?: ReactNode;
  /** Right-aligned controls (refresh, add…). */
  actions?: ReactNode;
  children: ReactNode;
};

export function RowGroup({
  label,
  icon,
  iconStyle,
  title,
  summary,
  actions,
  children,
}: RowGroupProps) {
  return (
    <section className={styles.group} aria-label={label}>
      <header className={styles.head}>
        {icon !== undefined && (
          <span className={styles.headIcon} style={iconStyle}>
            {icon}
          </span>
        )}
        <h2 className={styles.title}>{title}</h2>
        {summary !== undefined && <div className={styles.summary}>{summary}</div>}
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
      </header>
      <div>{children}</div>
    </section>
  );
}

/** Vertical stack of groups with the standard gap. */
export function RowGroups({ children }: { children: ReactNode }) {
  return <div className={styles.groups}>{children}</div>;
}
