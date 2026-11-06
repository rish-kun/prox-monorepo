/**
 * Routing policy endpoints (v8 layout).
 *
 * `routing.*` holds strategy, sticky sessions, retry and cooldown policy;
 * model-level cooling lives under `upstream.<provider>.model-level-cooling`.
 * PATCH merges into the addressed subtree (null is retained, not deleted), so
 * clearing a field back to its default uses DELETE on the leaf path.
 */

import { apiClient } from './client';
import { getConfigValue } from './configValue';

export const ROUTING_CONFIG_PATH = '/config/routing';
export const UPSTREAM_CONFIG_PATH = '/config/upstream';

export type ModelLevelCoolingProvider = 'claude' | 'codex';
export type UpstreamCoolingState = Record<ModelLevelCoolingProvider, boolean>;
export type UpstreamCoolingPatch = Partial<UpstreamCoolingState>;

const MODEL_LEVEL_COOLING_PROVIDERS: ModelLevelCoolingProvider[] = ['claude', 'codex'];

const routingFieldUrl = (path: readonly string[]): string => {
  if (
    !path.length ||
    path.some((key) => !key || key === '.' || key === '..' || /[/\\]/.test(key))
  ) {
    throw new Error('Routing field path cannot be safely represented');
  }
  return `${ROUTING_CONFIG_PATH}/${path.map((key) => encodeURIComponent(key)).join('/')}`;
};

const readBoolean = (value: unknown): boolean =>
  value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');

export const routingApi = {
  /** Raw `routing` subtree; an absent section reads as an empty map. */
  getRouting: () => getConfigValue<unknown>(ROUTING_CONFIG_PATH, {}),

  /** Merge-patch the `routing` subtree (keys relative to `routing`). */
  patchRouting: (patch: Record<string, unknown>) => apiClient.patch(ROUTING_CONFIG_PATH, patch),

  /** Remove one routing leaf so the backend default applies again. Missing is success. */
  deleteRoutingField: async (path: readonly string[]): Promise<void> => {
    const url = routingFieldUrl(path);
    try {
      await apiClient.delete(url);
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) return;
      throw error;
    }
  },

  async getUpstreamCooling(): Promise<UpstreamCoolingState> {
    const values = await Promise.all(
      MODEL_LEVEL_COOLING_PROVIDERS.map((provider) =>
        getConfigValue<unknown>(`${UPSTREAM_CONFIG_PATH}/${provider}/model-level-cooling`, false)
      )
    );
    return { claude: readBoolean(values[0]), codex: readBoolean(values[1]) };
  },

  /** Only the providers present in `patch` are written. */
  patchUpstreamCooling: async (patch: UpstreamCoolingPatch): Promise<void> => {
    const body: Record<string, Record<string, boolean>> = {};
    for (const provider of MODEL_LEVEL_COOLING_PROVIDERS) {
      const value = patch[provider];
      if (typeof value === 'boolean') body[provider] = { 'model-level-cooling': value };
    }
    if (!Object.keys(body).length) return;
    await apiClient.patch(UPSTREAM_CONFIG_PATH, body);
  },
};
