/**
 * One dense row: an identity button that toggles an inline detail panel,
 * then page-defined cells, then trailing controls.
 *
 * Column widths come from the page via CSS custom properties on `style`:
 * `--row-identity` (identity column max width) and `--row-cols` (the
 * grid-template-columns for the cells between identity and trailing).
 */

import { useId, type CSSProperties, type ReactNode } from 'react';
import { IconChevronDown } from '@/components/ui/icons';
import styles from './GroupedRows.module.scss';

export type ExpandableRowProps = {
  expanded: boolean;
  onToggle: () => void;
  /** Content of the identity button (dot, name, chips). */
  identity: ReactNode;
  identityTitle?: string;
  /** Leading content before the identity button (e.g. a selection checkbox). */
  leading?: ReactNode;
  /** Cells between identity and trailing; laid out by --row-cols. */
  children?: ReactNode;
  trailing?: ReactNode;
  /** Rendered only while expanded. */
  detail?: ReactNode;
  dimmed?: boolean;
  style?: CSSProperties;
};

export function ExpandableRow({
  expanded,
  onToggle,
  identity,
  identityTitle,
  leading,
  children,
  trailing,
  detail,
  dimmed = false,
  style,
}: ExpandableRowProps) {
  const detailId = useId();
  return (
    <div className={`${styles.item} ${dimmed ? styles.itemDimmed : ''}`}>
      <div className={styles.row} style={style}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {leading}
          <button
            type="button"
            className={styles.identity}
            aria-expanded={expanded}
            aria-controls={detail ? detailId : undefined}
            onClick={onToggle}
            title={identityTitle}
          >
            <IconChevronDown
              size={14}
              aria-hidden="true"
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
            />
            {identity}
          </button>
        </div>
        <div className={styles.cells}>{children}</div>
        <div className={styles.trailing}>{trailing}</div>
      </div>
      {expanded && detail !== undefined && (
        <div id={detailId} className={styles.detail}>
          {detail}
        </div>
      )}
    </div>
  );
}
