/**
 * Editable price table (USD per 1M tokens). Each cell commits on blur/Enter;
 * invalid input snaps back. Edited defaults can be reverted one by one,
 * custom models removed, and everything reset from the section header.
 */

import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_PRICES,
  PRICE_FIELDS,
  normalizeModelId,
  samePrice,
  type ModelPrice,
  type PriceField,
  type PriceSet,
  type PriceTable,
} from '../pricing';
import styles from './PricesEditor.module.scss';

const FIELD_LABEL_KEYS: Record<PriceField, string> = {
  input: 'usage.col_input',
  cacheWrite: 'usage.col_cache_write',
  cacheRead: 'usage.col_cache_read',
  output: 'usage.col_output',
};

const TIER_THRESHOLDS: Record<1 | 2, string> = { 1: '100K', 2: '272K' };

const parsePrice = (text: string): number | null => {
  const trimmed = text.trim().replace(',', '.');
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

function PriceInput({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const commit = (input: HTMLInputElement) => {
    const parsed = parsePrice(input.value);
    if (parsed === null) {
      input.value = String(value);
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <input
      // Remount when the committed value changes so the draft resets.
      key={value}
      className={styles.input}
      type="text"
      inputMode="decimal"
      defaultValue={String(value)}
      aria-label={label}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

interface PricesEditorProps {
  table: PriceTable;
  overrides: PriceTable;
  onSet: (key: string, price: ModelPrice) => void;
  onRemove: (key: string) => void;
  /** Prefill for the "add model" row (from an unpriced marker). */
  draftModel: string;
  onDraftModelChange: (model: string) => void;
}

export function PricesEditor({
  table,
  overrides,
  onSet,
  onRemove,
  draftModel,
  onDraftModelChange,
}: PricesEditorProps) {
  const { t } = useTranslation();
  const keys = Object.keys(table).sort((left, right) => left.localeCompare(right));

  const fieldLabel = (model: string, field: PriceField, suffix = '') =>
    t('usage.prices_field_aria', {
      model: suffix ? `${model} ${suffix}` : model,
      field: t(FIELD_LABEL_KEYS[field]),
    });

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('usage.col_model')}</th>
            {PRICE_FIELDS.map((field) => (
              <th key={field} scope="col">
                {t(FIELD_LABEL_KEYS[field])}
              </th>
            ))}
            <th scope="col">
              <span className={styles.srOnly}>{t('usage.prices_actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className={styles.addBody}>
          <AddPriceRow
            model={draftModel}
            onModelChange={onDraftModelChange}
            onAdd={(model, price) => {
              onSet(model, price);
              onDraftModelChange('');
            }}
          />
        </tbody>
        <tbody>
          {keys.map((key) => {
            const price = table[key];
            const fallback = DEFAULT_PRICES[key];
            const custom = !fallback;
            const edited = Boolean(overrides[key]) && !custom && !samePrice(price, fallback);
            const setBase = (field: PriceField, value: number) =>
              onSet(key, { ...price, [field]: value });
            const long = price.longContext;
            const longSuffix = long
              ? t('usage.prices_long_context', { threshold: TIER_THRESHOLDS[long.minTier] })
              : '';
            return [
              <tr key={key} className={long ? styles.hasLong : undefined}>
                <th scope="row" className={styles.model}>
                  {key}
                  {edited && <span className={styles.edited} aria-hidden="true" />}
                </th>
                {PRICE_FIELDS.map((field) => (
                  <td key={field}>
                    <PriceInput
                      value={price[field]}
                      label={fieldLabel(key, field)}
                      onCommit={(value) => setBase(field, value)}
                    />
                  </td>
                ))}
                <td className={styles.actions}>
                  {(edited || custom) && (
                    <button type="button" className={styles.link} onClick={() => onRemove(key)}>
                      {custom ? t('usage.prices_delete') : t('usage.prices_revert')}
                    </button>
                  )}
                </td>
              </tr>,
              long && (
                <tr key={`${key}:long`} className={styles.longRow}>
                  <th scope="row" className={styles.longLabel}>
                    {longSuffix}
                  </th>
                  {PRICE_FIELDS.map((field) => (
                    <td key={field}>
                      <PriceInput
                        value={long[field]}
                        label={fieldLabel(key, field, longSuffix)}
                        onCommit={(value) =>
                          onSet(key, { ...price, longContext: { ...long, [field]: value } })
                        }
                      />
                    </td>
                  ))}
                  <td />
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY_DRAFT: Record<PriceField, string> = {
  input: '',
  cacheWrite: '',
  cacheRead: '',
  output: '',
};

function AddPriceRow({
  model,
  onModelChange,
  onAdd,
}: {
  model: string;
  onModelChange: (model: string) => void;
  onAdd: (model: string, price: PriceSet) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const id = normalizeModelId(model);
  const parsed = PRICE_FIELDS.map((field) => parsePrice(draft[field]));
  const valid = Boolean(id) && parsed.every((value) => value !== null);

  const submit = () => {
    if (!valid) return;
    const [input, cacheWrite, cacheRead, output] = parsed as number[];
    onAdd(id, { input, cacheWrite, cacheRead, output });
    setDraft(EMPTY_DRAFT);
  };
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') submit();
  };

  return (
    <tr className={styles.addRow}>
      <th scope="row">
        <input
          className={`${styles.input} ${styles.modelInput}`}
          type="text"
          value={model}
          placeholder={t('usage.prices_new_model')}
          aria-label={t('usage.prices_new_model')}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => onModelChange(event.target.value)}
          onKeyDown={onEnter}
        />
      </th>
      {PRICE_FIELDS.map((field) => (
        <td key={field}>
          <input
            className={styles.input}
            type="text"
            inputMode="decimal"
            value={draft[field]}
            aria-label={t(FIELD_LABEL_KEYS[field])}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [field]: event.target.value }))
            }
            onKeyDown={onEnter}
          />
        </td>
      ))}
      <td className={styles.actions}>
        <button type="button" className={styles.link} disabled={!valid} onClick={submit}>
          {t('usage.prices_add')}
        </button>
      </td>
    </tr>
  );
}
