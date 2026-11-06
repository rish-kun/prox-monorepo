import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { authFilesApi } from '@/services/api/authFiles';
import { routingApi } from '@/services/api/routing';
import * as barrel from '@/services/api';

const spies: Array<{ mockRestore(): void }> = [];
const mock = (method: 'get' | 'patch' | 'delete' | 'post', value: unknown = {}) => {
  const spy = spyOn(apiClient, method).mockResolvedValue(value as never);
  spies.push(spy);
  return spy;
};
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const notFound = Object.assign(new Error('not found'), { status: 404, apiCode: 'not_found' });

describe('routing API contracts', () => {
  test('is exported from the API barrel', () => {
    expect(barrel.routingApi).toBe(routingApi);
  });

  test('reads the routing subtree, treating an absent section as empty', async () => {
    const get = mock('get', { strategy: 'fill-first' });
    expect(await routingApi.getRouting()).toEqual({ strategy: 'fill-first' });
    expect(get).toHaveBeenCalledWith('/config/routing');
    get.mockRejectedValueOnce(notFound);
    expect(await routingApi.getRouting()).toEqual({});
  });

  test('merge-patches routing relative to /config/routing', async () => {
    const patch = mock('patch');
    await routingApi.patchRouting({ strategy: 'round-robin', retry: { 'request-retry': 2 } });
    expect(patch).toHaveBeenCalledWith('/config/routing', {
      strategy: 'round-robin',
      retry: { 'request-retry': 2 },
    });
  });

  test('clears routing leaves with DELETE and tolerates missing fields', async () => {
    const del = mock('delete');
    await routingApi.deleteRoutingField(['retry', 'max-retry-credentials']);
    expect(del).toHaveBeenCalledWith('/config/routing/retry/max-retry-credentials');
    del.mockRejectedValueOnce(notFound);
    await routingApi.deleteRoutingField(['session-affinity-ttl']);
    del.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(routingApi.deleteRoutingField(['strategy'])).rejects.toThrow('boom');
    await expect(routingApi.deleteRoutingField(['..'])).rejects.toThrow();
    expect(del).toHaveBeenCalledTimes(3);
  });

  test('reads and patches upstream model-level cooling per provider', async () => {
    const get = mock('get');
    get.mockImplementation(async (path: string) => {
      if (path.includes('/claude/')) return true;
      throw notFound;
    });
    expect(await routingApi.getUpstreamCooling()).toEqual({ claude: true, codex: false });
    expect(get.mock.calls.map((call) => call[0])).toEqual([
      '/config/upstream/claude/model-level-cooling',
      '/config/upstream/codex/model-level-cooling',
    ]);

    const patch = mock('patch');
    await routingApi.patchUpstreamCooling({ codex: true });
    expect(patch).toHaveBeenCalledWith('/config/upstream', {
      codex: { 'model-level-cooling': true },
    });
    await routingApi.patchUpstreamCooling({});
    expect(patch).toHaveBeenCalledTimes(1);
  });

  test('per-credential routing fields go through /credentials/fields and status/cooldown ops', async () => {
    const patch = mock('patch');
    await authFilesApi.patchFields('a.json', { priority: 20, weight: null });
    expect(patch).toHaveBeenCalledWith('/credentials/fields', {
      name: 'a.json',
      priority: 20,
      weight: null,
    });
    await authFilesApi.setStatus('a.json', true, '7');
    expect(patch).toHaveBeenLastCalledWith('/credentials/status', {
      name: 'a.json',
      disabled: true,
      auth_index: '7',
    });
    const post = mock('post', { status: 'ok', auth_index: '7', models: [] });
    await authFilesApi.resetCooldown('7');
    expect(post).toHaveBeenCalledWith('/routing/cooldown/reset', { auth_index: '7' });
  });
});
