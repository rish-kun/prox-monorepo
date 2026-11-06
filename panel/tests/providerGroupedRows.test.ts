import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { claudeToResource, openaiToResource } from '../src/features/providers/adapters';
import { ProviderResourceRow } from '../src/features/providers/components/ProviderResourceRow';
import { ProviderResourceDetail } from '../src/features/providers/components/ProviderResourceDetail';
import en from '../src/i18n/locales/en.json';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
const render = (component: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, component));

const noop = () => {};

describe('providers page grouped rows', () => {
  test('page renders brands through the shared RowGroup primitive', () => {
    const page = read('src/features/providers/ProvidersWorkbenchPage.tsx');
    const group = read('src/features/providers/components/ProviderBrandGroup.tsx');
    const row = read('src/features/providers/components/ProviderResourceRow.tsx');
    expect(page).toContain('<RowGroups>');
    expect(page).toContain('<ProviderBrandGroup');
    expect(group).toContain('<RowGroup');
    expect(row).toContain('<ExpandableRow');
    expect(row).toContain('--row-cols');
    expect(page).toContain("'providersPage.uiState'");
  });

  test('has no quick-start remnants and manages APIKEY.FUN like any other brand', () => {
    const page = read('src/features/providers/ProvidersWorkbenchPage.tsx');
    expect(page).not.toContain('fixedBrand');
    expect(page).not.toContain('SponsorQuickStartPanel');
    expect(page).not.toMatch(/!==\s*'apikeyFun'/);
    for (const path of [
      'src/features/providers/sheets/ProviderSheet.tsx',
      'src/features/providers/sheets/forms/SponsorProviderForm.tsx',
      'src/features/providers/sheets/forms/sharedForm.module.scss',
    ]) {
      const source = read(path);
      expect(source).not.toContain('quick-start');
      expect(source).not.toContain('quickStart');
    }
    for (const removed of [
      'components/SponsorQuickStartPanel.tsx',
      'components/ProviderCategoryList.tsx',
      'components/ProviderResourcePanel.tsx',
      'components/ProviderResourceTable.tsx',
      'components/ProviderResourceToolbar.tsx',
      'components/ProviderHeaderCard.tsx',
      'uiState.ts',
    ]) {
      expect(existsSync(new URL(`../src/features/providers/${removed}`, import.meta.url))).toBe(
        false
      );
    }
  });

  test('collapsed row shows identity, default Claude URL, counts and a labelled toggle', () => {
    const resource = claudeToResource(
      {
        apiKey: 'sk-ant-1234567890abcdef',
        prefix: 'team',
        models: [{ name: 'claude-sonnet', alias: '' }],
      } as never,
      0
    );
    const html = render(
      createElement(ProviderResourceRow, {
        resource,
        expanded: false,
        disableMutations: false,
        onToggleExpanded: noop,
        onToggleDisabled: noop,
        onEdit: noop,
        onDelete: noop,
      })
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('https://api.anthropic.com');
    expect(html).toContain('(default)');
    expect(html).toContain('team');
    expect(html).toContain('Models');
    expect(html).toContain('aria-label="Enable ');
    expect(html).not.toContain('Disabled');
    expect(html).not.toContain('Edit');
  });

  test('expanded OpenAI row lists key entries and models with Edit and Delete', () => {
    const resource = openaiToResource(
      {
        name: 'router',
        baseUrl: 'https://example.test/v1',
        apiKeyEntries: [{ apiKey: 'sk-one-1234567890' }, { apiKey: 'sk-two-1234567890' }],
        headers: { 'X-Team': 'a' },
        models: [{ name: 'gpt-x', alias: '' }],
        disabled: true,
      },
      0
    );
    const row = render(
      createElement(ProviderResourceRow, {
        resource,
        expanded: true,
        disableMutations: false,
        onToggleExpanded: noop,
        onToggleDisabled: noop,
        onEdit: noop,
        onDelete: noop,
      })
    );
    expect(row).toContain('aria-expanded="true"');
    expect(row).toContain('+1 keys');
    expect(row).toContain('Disabled');

    const detail = render(
      createElement(ProviderResourceDetail, {
        resource,
        disableMutations: false,
        onEdit: noop,
        onDelete: noop,
      })
    );
    expect(detail).toContain('API key entries');
    expect(detail).toContain('X-Team');
    expect(detail).not.toContain('>a<');
    expect(detail).toContain('gpt-x');
    expect(detail).toContain('Edit');
    expect(detail).toContain('Delete');
  });
});
