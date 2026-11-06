/**
 * Inline detail for one provider entry (shown when its row expands):
 * connection fields, headers, excluded models, key entries, models, then
 * flat Edit / Delete actions.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { groupedRowStyles as g } from '@/components/common/GroupedRows';
import { IconPencil, IconTrash2 } from '@/components/ui/icons';
import {
  getProviderTotalStats,
  stripDisableAllModelsRule,
  type ProviderRecentUsageMap,
} from '@/components/providers/utils';
import type { OpenAIProviderConfig } from '@/types';
import { maskApiKey } from '@/utils/format';
import {
  getSponsorProviderDefinition,
  isMultiProtocolSponsorBrand,
  sponsorProtocolI18nKey,
  sponsorProtocolUrl,
} from '../sponsorDefinitions';
import type { ProviderResource, SponsorProviderRaw } from '../types';
import { CLAUDE_DEFAULT_BASE_URL } from './providerDisplay';
import styles from './ProviderResourceDetail.module.scss';

type Field = { key: string; label: string; value: string | null; mono?: boolean };

const sponsorProtocolEntryKey = (protocol: string): string => {
  if (protocol === 'claude') return 'anthropicEntries';
  if (protocol === 'codex') return 'codexEntries';
  return `${protocol}Entries`;
};

function FieldList({ fields, empty }: { fields: Field[]; empty: string }) {
  return (
    <dl className={styles.fields}>
      {fields.map((field) => (
        <div key={field.key} className={styles.field}>
          <dt className={styles.label}>{field.label}</dt>
          <dd className={`${styles.value} ${field.mono === false ? '' : g.mono}`}>
            {field.value ?? <span className={g.muted}>{empty}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function NameList({ names }: { names: string[] }) {
  return (
    <ul className={styles.names}>
      {names.map((name) => (
        <li key={name} className={`${g.chip} ${styles.nameChip}`}>
          {name}
        </li>
      ))}
    </ul>
  );
}

export type ProviderResourceDetailProps = {
  resource: ProviderResource;
  usageByProvider?: ProviderRecentUsageMap;
  disableMutations: boolean;
  onEdit: (resource: ProviderResource) => void;
  onDelete: (resource: ProviderResource) => void;
};

export function ProviderResourceDetail({
  resource,
  usageByProvider,
  disableMutations,
  onEdit,
  onDelete,
}: ProviderResourceDetailProps) {
  const { t } = useTranslation();
  const notSet = t('providersPage.status.notSet');
  const field = (key: string, value: string | null, mono?: boolean): Field => ({
    key,
    label: t(`providersPage.detail.fields.${key}`),
    value,
    mono,
  });

  let body: ReactNode;

  if (isMultiProtocolSponsorBrand(resource.brand)) {
    const definition = getSponsorProviderDefinition(resource.brand);
    const raw = resource.raw as SponsorProviderRaw;
    const baseUrl = definition.resolveBaseUrl(
      raw.openai[0]?.config.baseUrl ??
        raw.codex[0]?.config.baseUrl ??
        raw.claude[0]?.config.baseUrl ??
        raw.gemini[0]?.config.baseUrl
    );
    const protocolUrls = definition.getProtocolUrls(baseUrl);
    const protocolCounts: Record<string, number> = {
      openai: raw.openai.reduce((sum, item) => sum + (item.config.apiKeyEntries?.length ?? 0), 0),
      codex: raw.codex.length,
      claude: raw.claude.length,
      gemini: raw.gemini.length,
    };

    body = (
      <>
        <FieldList
          empty={notSet}
          fields={[
            field('identifier', resource.apiKeyPreview),
            field('prefix', resource.prefix),
            field('proxyUrl', resource.proxyUrl),
            ...definition.protocols.map((protocol) => ({
              key: `count-${protocol}`,
              label: t(`providersPage.sponsor.${sponsorProtocolEntryKey(protocol)}`),
              value: String(protocolCounts[protocol] ?? 0),
            })),
          ]}
        />
        <Section title={t('providersPage.detail.fields.endpoints')}>
          <dl className={styles.lines}>
            {definition.protocols.map((protocol) => (
              <div key={protocol} className={styles.line}>
                <dt className={styles.lineLabel}>
                  {t(`providersPage.sponsor.protocols.${sponsorProtocolI18nKey(protocol)}`)}
                </dt>
                <dd className={`${g.mono} ${styles.lineValue}`}>
                  {sponsorProtocolUrl(protocolUrls, protocol)}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      </>
    );
  } else {
    const config = resource.raw as {
      headers?: Record<string, string>;
      excludedModels?: string[];
    };
    const headerNames = Object.keys(config.headers ?? {});
    const excludedModels =
      resource.brand === 'openaiCompatibility'
        ? []
        : stripDisableAllModelsRule(config.excludedModels);
    const openaiConfig =
      resource.brand === 'openaiCompatibility' ? (resource.raw as OpenAIProviderConfig) : null;
    const keyEntries = openaiConfig?.apiKeyEntries ?? [];
    const baseUrl =
      resource.baseUrl ??
      (resource.brand === 'claude'
        ? `${CLAUDE_DEFAULT_BASE_URL} ${t('providersPage.status.defaultSuffix')}`
        : null);

    body = (
      <>
        <FieldList
          empty={notSet}
          fields={[
            field('baseUrl', baseUrl),
            ...(openaiConfig ? [] : [field('proxyUrl', resource.proxyUrl)]),
            field('authIndex', resource.authIndex),
            field('prefix', resource.prefix),
          ]}
        />

        {keyEntries.length > 0 && openaiConfig ? (
          <Section title={t('providersPage.detail.fields.apiKeyEntries')}>
            <ol className={styles.lines}>
              {keyEntries.map((entry, index) => {
                const entryStats = usageByProvider
                  ? getProviderTotalStats(
                      usageByProvider,
                      openaiConfig.name,
                      entry.apiKey,
                      openaiConfig.baseUrl
                    )
                  : null;
                return (
                  <li key={`${entry.apiKey}-${index}`} className={styles.keyLine}>
                    <span className={`${g.mono} ${g.muted}`}>{index + 1}</span>
                    <span className={`${g.mono} ${g.ellipsis}`}>{maskApiKey(entry.apiKey)}</span>
                    <span className={`${g.mono} ${g.ellipsis} ${g.muted}`} title={entry.proxyUrl}>
                      {entry.proxyUrl ?? ''}
                    </span>
                    <span
                      className={`${g.mono} ${styles.keyStats}`}
                      title={
                        entryStats
                          ? t('providersPage.row.stats', {
                              success: entryStats.success,
                              failure: entryStats.failure,
                            })
                          : undefined
                      }
                    >
                      {entryStats ? (
                        <>
                          <span className={styles.success}>✓{entryStats.success}</span>
                          <span className={entryStats.failure > 0 ? styles.failure : g.muted}>
                            ✗{entryStats.failure}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Section>
        ) : null}

        {headerNames.length > 0 ? (
          <Section title={`${t('providersPage.detail.fields.headers')} · ${headerNames.length}`}>
            <NameList names={headerNames} />
          </Section>
        ) : null}

        {excludedModels.length > 0 ? (
          <Section
            title={`${t('providersPage.detail.fields.excludedModels')} · ${excludedModels.length}`}
          >
            <NameList names={excludedModels} />
          </Section>
        ) : null}
      </>
    );
  }

  return (
    <div className={styles.detail}>
      {body}

      <Section title={`${t('providersPage.detail.fields.models')} · ${resource.models.length}`}>
        {resource.models.length > 0 ? (
          <NameList names={resource.models} />
        ) : (
          <span className={`${g.muted} ${styles.none}`}>{t('providersPage.status.none')}</span>
        )}
      </Section>

      <div className={styles.actions}>
        <button
          type="button"
          className={g.textButton}
          onClick={() => onEdit(resource)}
          disabled={disableMutations}
        >
          <IconPencil size={13} aria-hidden="true" />
          {t('providersPage.actions.edit')}
        </button>
        <button
          type="button"
          className={`${g.textButton} ${g.danger}`}
          onClick={() => onDelete(resource)}
          disabled={disableMutations}
        >
          <IconTrash2 size={13} aria-hidden="true" />
          {t('providersPage.actions.delete')}
        </button>
      </div>
    </div>
  );
}
