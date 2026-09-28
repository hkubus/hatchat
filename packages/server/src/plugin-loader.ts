import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger, Plugin } from "@hat/core";

/** Load trusted in-process plugins from a directory of ESM modules. */
export async function loadExternalPlugins(dir: string, logger: Logger): Promise<Plugin[]> {
  const absolute = path.resolve(dir);
  if (!fs.existsSync(absolute)) return [];

  const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
  const plugins: Plugin[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mjs|js)$/.test(entry.name)) continue;
    const file = path.join(absolute, entry.name);
    try {
      const mod = (await import(pathToFileURL(file).href)) as {
        default?: Plugin;
        plugin?: Plugin;
      };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin || typeof plugin.id !== "string" || typeof plugin.activate !== "function") {
        logger.warn(`plugin ${entry.name}: does not export a valid Plugin, skipping`);
        continue;
      }
      plugins.push(plugin);
      logger.info(`loaded external plugin: ${plugin.id} (${entry.name})`);
    } catch (error) {
      logger.error(`failed to load plugin ${entry.name}`, String(error));
    }
  }

  return plugins;
}
