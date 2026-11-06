import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The quota host binds CSS-module classes at import time, which Bun cannot render.
// Keep these source contracts small; browser checks cover the actual row interactions.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('src/features/authFiles/components/AuthFileRow.tsx');
const styles = read('src/features/authFiles/components/AuthFileRow.module.scss');
const page = read('src/features/authFiles/AuthFilesPage.tsx');

const slice = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));

describe('auth file row presentation contract', () => {
  test('builds on the shared grouped-row primitive with identity, not logos', () => {
    expect(source).toContain("from '@/components/common/GroupedRows'");
    expect(source).toContain('<ExpandableRow');
    expect(source).not.toContain('<img');
    expect(source).not.toContain('getAuthFileIcon');
    expect(source).toContain('{identity.primary}');
    expect(source).toContain('{identity.secondary');
    expect(page).toContain('<AuthFileProviderGroup');
    expect(page).toContain('<AuthFileRow');
  });

  test('uses one trailing toggle and credential-specific accessible names', () => {
    const leading = slice('leading={', 'identity={');
    const trailing = slice('trailing={', 'detail={');
    expect(source.match(/<ToggleSwitch/g)).toHaveLength(1);
    expect(leading).not.toContain('<ToggleSwitch');
    expect(leading).toContain("ariaLabel={t('auth_files.card_select', { name: file.name })}");
    expect(leading).toContain('onToggleSelect(file.name)');
    expect(trailing).toContain('<ToggleSwitch');
    expect(trailing).toContain("t('auth_files.card_toggle', { name: file.name })");
    expect(trailing).toContain('checked={!file.disabled}');
    expect(trailing).toContain('onToggleStatus(file, value)');
    expect(trailing).toContain('isStatusUpdating');
    expect(trailing).toContain('isManualRefreshing');
    expect(trailing).toContain('!isRuntimeOnly');
    expect(source).toContain(
      'const isStatusUpdating = statusUpdating[getAuthFileRefreshKey(file)] === true;'
    );
  });

  test('runtime-only credentials get a virtual chip and no checkbox or toggle', () => {
    const leading = slice('leading={', 'identity={');
    expect(leading).toMatch(/isRuntimeOnly \?\s*\(\s*<span className=\{styles\.selectionSpacer\}/);
    expect(source).toContain("t('auth_files.virtual_chip')");
  });

  test('dims disabled row content but keeps the re-enable controls clear', () => {
    expect(source).toContain("file.disabled === true ? styles.rowDisabled : ''");
    expect(source).not.toContain('dimmed=');
    const trailing = slice('trailing={', 'detail={');
    expect(trailing).not.toContain('rowDisabled');
    expect(trailing).not.toContain('{dim}');
    expect(styles).toMatch(/\.rowDisabled\s*\{\s*opacity:\s*0\.5;/);
  });

  test('uses a plain-text weight tooltip while preserving the details link', () => {
    expect(source).toContain("title={t('auth_files.weight_tooltip')}");
    expect(source).not.toContain("title={t('auth_files.weight_hint')}");
    const detailsSource = read('src/features/authFiles/components/AuthFileDetailsSheet.tsx');
    expect(detailsSource).toContain('i18nKey="auth_files.weight_hint"');

    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru']) {
      const { auth_files: messages } = JSON.parse(read(`src/i18n/locales/${locale}.json`)) as {
        auth_files: Record<string, string>;
      };
      expect(messages.weight_tooltip).toBeTruthy();
      expect(messages.weight_tooltip).not.toMatch(/<[^>]+>/);
      expect(messages.weight_hint).toContain('<settingsLink>');
      expect(messages.weight_tooltip).toBe(messages.weight_hint.replace(/<\/?settingsLink>/g, ''));
    }
  });

  test('retains individual management actions and warning detail', () => {
    for (const handler of [
      'onShowModels(file)',
      'onDownload(file.name)',
      'onManualRefresh(file)',
      'onCooldownReset(file)',
      'onOpenPrefixProxyEditor(file)',
      'onDelete(file.name)',
    ]) {
      expect(source).toContain(handler);
    }
    expect(source).toContain('rawStatusMessage && hasStatusWarning');
    expect(source).toContain('showManualRefreshButton');
    expect(source).toContain('file.disabled ||');
    expect(source).toContain('<AuthFileCooldownSection');
    expect(source).toContain('<AuthFileQuotaSection');
  });
});

describe('summarizeAuthFileStatusMessage', () => {
  test('extracts the message from a raw upstream JSON error body', async () => {
    const { summarizeAuthFileStatusMessage } = await import('@/features/authFiles/constants');
    expect(
      summarizeAuthFileStatusMessage(
        '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":4606}}'
      )
    ).toBe('The usage limit has been reached');
    expect(summarizeAuthFileStatusMessage('{"error":"invalid_grant"}')).toBe('invalid_grant');
    expect(summarizeAuthFileStatusMessage('401 unauthorized')).toBe('401 unauthorized');
    expect(summarizeAuthFileStatusMessage('{not json')).toBe('{not json');
  });
});
