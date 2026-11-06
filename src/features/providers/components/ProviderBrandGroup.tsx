/**
 * One provider brand as a bordered row group: logo, name, active/total,
 * an optional sponsor link as quiet text, and a `+` to add another entry.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RowGroup, groupedRowStyles } from '@/components/common/GroupedRows';
import { IconPlus } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { getKimiAffiliateUrl } from '../kimi';
import { getSponsorProviderDefinition, isMultiProtocolSponsorBrand } from '../sponsorDefinitions';
import type { ProviderBrand, ProviderGroup } from '../types';
import { getBrandLogoSrc, getBrandLogoWellStyle } from './providerDisplay';
import styles from './ProviderBrandGroup.module.scss';

type SponsorLink = { href: string; labelKey: string };

function getSponsorLink(brand: ProviderBrand, language: string | undefined): SponsorLink | null {
  if (brand === 'kimi') {
    return { href: getKimiAffiliateUrl(language), labelKey: 'providersPage.sponsor.registerNow' };
  }
  if (!isMultiProtocolSponsorBrand(brand)) return null;
  const definition = getSponsorProviderDefinition(brand);
  if (definition.dashboardUrl) {
    return { href: definition.dashboardUrl, labelKey: 'providersPage.sponsor.dashboardLink' };
  }
  if (definition.affiliateUrl) {
    return { href: definition.affiliateUrl, labelKey: 'providersPage.sponsor.registerLink' };
  }
  return null;
}

export type ProviderBrandGroupProps = {
  group: ProviderGroup;
  resolvedTheme: ResolvedTheme;
  addDisabled: boolean;
  onAdd: (brand: ProviderBrand) => void;
  children: ReactNode;
};

export function ProviderBrandGroup({
  group,
  resolvedTheme,
  addDisabled,
  onAdd,
  children,
}: ProviderBrandGroupProps) {
  const { t, i18n } = useTranslation();
  const label = t(`providersPage.providerNames.${group.id}`);
  const logoSrc = getBrandLogoSrc(group.id, resolvedTheme);
  const total = group.resources.length;
  const active = group.resources.filter((resource) => !resource.disabled).length;
  const sponsorLink = getSponsorLink(group.id, i18n.resolvedLanguage ?? i18n.language);
  const addLabel = t('providersPage.group.add', { provider: label });
  const activeLabel = t('providersPage.header.activeMeta', { active, total });

  return (
    <RowGroup
      label={label}
      icon={logoSrc ? <img src={logoSrc} alt="" /> : <span>{label.slice(0, 1)}</span>}
      iconStyle={getBrandLogoWellStyle(group.id)}
      title={label}
      summary={
        <>
          <span className={groupedRowStyles.mono} title={activeLabel} aria-label={activeLabel}>
            {active}/{total}
          </span>
          {sponsorLink && (
            <a
              className={styles.link}
              href={sponsorLink.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t(sponsorLink.labelKey)}
            </a>
          )}
        </>
      }
      actions={
        <button
          type="button"
          className={groupedRowStyles.iconButton}
          onClick={() => onAdd(group.id)}
          disabled={addDisabled}
          aria-label={addLabel}
          title={addLabel}
        >
          <IconPlus size={15} />
        </button>
      }
    >
      {children}
    </RowGroup>
  );
}
