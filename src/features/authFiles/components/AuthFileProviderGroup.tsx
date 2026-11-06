/**
 * One provider's credentials under a single-line header:
 * select-group checkbox · icon · name · status squares · active/total ·
 * "N problems" (selects them) · links to that provider's OAuth rules.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RowGroup, groupedRowStyles as rowStyles } from '@/components/common/GroupedRows';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { AuthFileGroupSummary, AuthFileHealth } from '@/features/authFiles/logic';
import styles from './AuthFileProviderGroup.module.scss';

const SQUARE_CLASS: Record<AuthFileHealth['kind'], string> = {
  ok: styles.squareOk,
  cooling: styles.squareWarn,
  problem: styles.squareBad,
  disabled: '',
};

export type AuthFileProviderGroupProps = {
  type: string;
  healths: AuthFileHealth['kind'][];
  summary: AuthFileGroupSummary;
  resolvedTheme: ResolvedTheme;
  selectableCount: number;
  allSelected: boolean;
  excludedCount: number;
  aliasCount: number;
  onToggleSelectGroup: () => void;
  onSelectProblems: (files: AuthFileItem[]) => void;
  children: ReactNode;
};

export function AuthFileProviderGroup({
  type,
  healths,
  summary,
  resolvedTheme,
  selectableCount,
  allSelected,
  excludedCount,
  aliasCount,
  onToggleSelectGroup,
  onSelectProblems,
  children,
}: AuthFileProviderGroupProps) {
  const { t } = useTranslation();
  const label = getTypeLabel(t, type);
  const iconSrc = getAuthFileIcon(type, resolvedTheme);
  const providerParam = encodeURIComponent(type);

  return (
    <RowGroup
      label={label}
      icon={
        <SelectionCheckbox
          checked={allSelected}
          onChange={onToggleSelectGroup}
          disabled={selectableCount === 0}
          ariaLabel={t('auth_files.group_select', { provider: label })}
          title={t('auth_files.group_select', { provider: label })}
        />
      }
      title={
        <span className={styles.title}>
          <span
            className={styles.providerIcon}
            style={
              isThemeSurfaceIconProvider(type)
                ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                : undefined
            }
            aria-hidden="true"
          >
            {iconSrc ? <img src={iconSrc} alt="" /> : label.slice(0, 1).toUpperCase()}
          </span>
          {label}
        </span>
      }
      summary={
        <>
          <span className={rowStyles.squares} aria-hidden="true">
            {healths.map((kind, index) => (
              <i key={index} className={`${styles.square} ${SQUARE_CLASS[kind]}`} />
            ))}
          </span>
          <span
            className={rowStyles.mono}
            title={t('auth_files.group_active', {
              active: summary.active,
              total: summary.total,
            })}
          >
            {summary.active}/{summary.total}
          </span>
          {summary.problemCount > 0 && (
            <button
              type="button"
              className={styles.problems}
              onClick={() => onSelectProblems(summary.problemFiles)}
              disabled={summary.problemFiles.length === 0}
              title={t('auth_files.group_select_problems', { provider: label })}
            >
              {t('auth_files.problem_count', { count: summary.problemCount })}
            </button>
          )}
          {(excludedCount > 0 || aliasCount > 0) && (
            <span className={styles.links}>
              {excludedCount > 0 && (
                <Link
                  className={styles.link}
                  to={`/auth-files/oauth-excluded?provider=${providerParam}`}
                  state={{ fromAuthFiles: true }}
                >
                  {t('auth_files.group_excluded', { count: excludedCount })}
                </Link>
              )}
              {aliasCount > 0 && (
                <Link
                  className={styles.link}
                  to={`/auth-files/oauth-model-alias?provider=${providerParam}`}
                  state={{ fromAuthFiles: true }}
                >
                  {t('auth_files.group_aliases', { count: aliasCount })}
                </Link>
              )}
            </span>
          )}
        </>
      }
    >
      {children}
    </RowGroup>
  );
}
