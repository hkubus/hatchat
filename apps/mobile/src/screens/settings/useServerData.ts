/**
 * Server state for the Settings screens.
 *
 * Every screen fetches what it shows each time it gains focus, so the counts on
 * the root are current after a detail screen changed something, and a detail
 * screen is current after an edit made elsewhere. There is deliberately no
 * shared store to keep in step. The last result per server and resource is
 * remembered only so a pushed screen renders populated at once instead of
 * flashing empty while its own refetch runs.
 *
 * `guard` wraps a mutation: it clears the previous error and notice, reports a
 * failure as an error banner, and on success shows `message` and refetches.
 */

import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import * as api from "../../api";
import type { PluginDescriptor, ProviderStatus, RunnerSummary } from "../../api";
import * as haptics from "../../haptics";
import { currentConfig } from "../../runtime";

export interface Overview {
  providers: ProviderStatus[];
  plugins: PluginDescriptor[];
  runners: RunnerSummary[];
  tools: string[];
}

const cache = new Map<string, unknown>();

/** Keyed by server too, so reconnecting elsewhere never shows the old server's data. */
function cacheKey(name: string): string {
  return `${currentConfig().serverUrl}\u0000${name}`;
}

async function loadOverview(): Promise<Overview> {
  const [providers, plugins, runners, tools] = await Promise.all([
    api.getProviders(),
    api.getPlugins(),
    api.getRunners(),
    // Tool names only feed the allowlist; not worth failing the whole root
    // screen if this one call does.
    api.getTools().catch(() => [] as string[]),
  ]);
  // Seed the detail screens so they open populated.
  cache.set(cacheKey("providers"), providers);
  cache.set(cacheKey("plugins"), plugins);
  cache.set(cacheKey("runners"), runners);
  return { providers, plugins, runners, tools };
}

// Module-level so every loader is referentially stable across renders.
const RESOURCES = {
  overview: loadOverview,
  providers: api.getProviders,
  plugins: api.getPlugins,
  runners: api.getRunners,
  // Unlike the overview, the allowlist screen surfaces this failure: showing
  // "no tools registered" for a request that failed would be wrong.
  tools: api.getTools,
};

type ResourceName = keyof typeof RESOURCES;
type ResourceData<K extends ResourceName> = Awaited<ReturnType<(typeof RESOURCES)[K]>>;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useServerData<K extends ResourceName>(name: K) {
  const key = cacheKey(name);
  const [data, setData] = useState<ResourceData<K> | undefined>(
    () => cache.get(key) as ResourceData<K> | undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = (await RESOURCES[name]()) as ResourceData<K>;
      cache.set(key, next);
      setData(next);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [key, name]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  /** Resolves to whether `run` succeeded, so a form knows when to clear itself. */
  const guard = useCallback(
    async (run: () => Promise<unknown>, message: string): Promise<boolean> => {
      setError(null);
      setNotice(null);
      try {
        await run();
      } catch (e) {
        haptics.error();
        setError(errorMessage(e));
        return false;
      }
      haptics.success();
      setNotice(message);
      await reload();
      return true;
    },
    [reload],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { data, error, notice, dismissNotice, reload, guard };
}
