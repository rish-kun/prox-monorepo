import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import {
  ForecastDrainChart,
  ForecastRemainingChart,
} from '../src/features/quota/components/ForecastCharts';
import { QuotaForecast } from '../src/features/quota/components/QuotaForecast';
import { timeTicks, createTimeFormatters } from '../src/features/quota/components/forecastFormat';
import { DAY, HOUR, buildQuotaForecast } from '../src/features/quota/quotaForecastModel';

const NOW = 1_800_000_000;
const forecast = buildQuotaForecast({
  window: 'weekly',
  samples: [
    { t: NOW - 6 * HOUR, authIndex: 'a', used: 10, resetsAt: NOW + 2 * DAY },
    { t: NOW, authIndex: 'a', used: 30, resetsAt: NOW + 2 * DAY },
  ],
  accounts: { a: { label: 'a@example.com', priority: 0, disabled: false } },
  now: NOW,
  horizon: 7 * DAY,
  lookback: DAY,
});

describe('forecast rendering', () => {
  test('the remaining chart exposes its summary and a data table', () => {
    const markup = renderToStaticMarkup(
      createElement(ForecastRemainingChart, {
        forecast,
        labelFor: () => 'a@example.com',
        summary: 'Remaining summary',
      })
    );
    expect(markup).toContain('aria-label="Remaining summary"');
    expect(markup).toContain('<caption>Remaining summary</caption>');
    expect(markup).toContain('70%');
    expect(markup).toContain('100%');
  });

  test('the drain chart renders a row per bar', () => {
    const markup = renderToStaticMarkup(
      createElement(ForecastDrainChart, { forecast, summary: 'Drain summary' })
    );
    expect(markup.match(/<tr>/g)?.length).toBe(forecast.drainBars.length + 1);
  });

  test('collapsed, the panel is just its header', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaForecast, {
        providers: ['claude', 'codex'],
        files: [],
        open: false,
        onToggle: () => {},
        enabled: false,
      })
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('<figure');
  });

  test('x ticks stay within ten labels for every horizon', () => {
    const format = createTimeFormatters('en-US');
    for (const span of [15 * HOUR, 30 * HOUR, 60 * HOUR, 8.75 * DAY, 17.5 * DAY]) {
      const ticks = timeTicks(NOW - span / 5, NOW + (span * 4) / 5, format);
      expect(ticks.length).toBeGreaterThan(1);
      expect(ticks.length).toBeLessThanOrEqual(10);
    }
  });
});
