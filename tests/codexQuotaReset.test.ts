import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import {
  apiCallApi,
  authFilesApi,
  apiClient,
  normalizeSnapshot,
  quotaSnapshotsApi,
} from '@/services/api';
import { CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL } from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const file = { name: 'codex-test.json', auth_index: 'test-index', type: 'codex' };
const response = (body: unknown, statusCode = 200) => ({
  statusCode,
  body,
  bodyText: JSON.stringify(body),
  header: {},
});
const reset = () => CODEX_CONFIG.resetQuota!(file, t);
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

function setup(body: unknown, statusCode = 200) {
  const calls: string[] = [];
  const request = spyOn(apiCallApi, 'request').mockImplementation(async (payload) => {
    if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL) {
      calls.push('consume');
      return response(body, statusCode);
    }
    // Quota reads go through the proxy, never a direct api-call.
    calls.push(`unexpected ${payload.url}`);
    return response({});
  });
  const clear = spyOn(authFilesApi, 'resetCooldown').mockImplementation(async () => {
    calls.push('clear');
    return { status: 'ok', auth_index: 'test-index', models: [] };
  });
  const refresh = spyOn(quotaSnapshotsApi, 'refresh').mockImplementation(
    async (indexes, options) => {
      calls.push(`read${options?.force ? ' (force)' : ''}`);
      return {
        pollIntervalSeconds: 3600,
        snapshots: {
          [indexes?.[0] ?? '']: normalizeSnapshot({
            auth_index: indexes?.[0],
            fetched_at: '2026-10-26T10:00:00Z',
            responses: { usage: { status_code: 200, body: { rate_limit: null } } },
          }),
        },
      };
    }
  );
  mocks.push(request, clear, refresh);
  return { calls, request, clear, refresh };
}

describe('Codex reset gateway cooldown', () => {
  test.each(['reset', 'already_redeemed'])(
    'clears only after confirmed %s, before a forced proxy refresh',
    async (code) => {
      const { calls, clear, refresh } = setup({ code, windows_reset: 0 });
      await reset();
      expect(calls).toEqual(['consume', 'clear', 'read (force)']);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith('test-index');
      expect(refresh).toHaveBeenCalledWith(['test-index'], { force: true });
    }
  );

  test.each(['no_credit', 'nothing_to_reset', 'unknown'])('does not clear for %s', async (code) => {
    const { calls } = setup({ code });
    await expect(reset()).rejects.toThrow('codex_quota.reset_not_confirmed');
    expect(calls).toEqual(['consume']);
  });

  test('does not clear on HTTP failure', async () => {
    const { calls } = setup({ code: 'reset' }, 503);
    await expect(reset()).rejects.toThrow();
    expect(calls).toEqual(['consume']);
  });

  test('does not clear on transport failure', async () => {
    const { request, clear } = setup({});
    request.mockRejectedValue(new Error('timeout'));
    await expect(reset()).rejects.toThrow('timeout');
    expect(clear).not.toHaveBeenCalled();
  });

  test('directs cooldown failures to manual clearing, without another consume', async () => {
    const { request, clear } = setup({ code: 'reset' });
    clear.mockRejectedValue(new Error('offline'));
    await expect(reset()).rejects.toThrow('codex_quota.reset_cooldown_failed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('rejects mismatched cooldown acknowledgements', async () => {
    const { clear } = setup({ code: 'reset' });
    clear.mockResolvedValue({ status: 'ok', auth_index: 'other-index', models: [] });
    await expect(reset()).rejects.toThrow('codex_quota.reset_cooldown_failed');
  });

  test('does not clear after connection changes during redemption', async () => {
    const { clear } = setup({ code: 'reset' });
    const revision = spyOn(apiClient, 'getConnectionRevision')
      .mockReturnValueOnce(1)
      .mockReturnValue(2);
    mocks.push(revision);
    await expect(reset()).rejects.toThrow('codex_quota.reset_cooldown_failed');
    expect(clear).not.toHaveBeenCalled();
  });
});
