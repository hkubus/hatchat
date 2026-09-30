import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger, Plugin } from "@hat/core";
import { loadIsolatedPlugin, sandboxSupported } from "./plugin-isolation/host.js";

export interface ExternalPluginOptions {
  /**
   * Run each plugin in its own process (see `plugin-isolation/`). When false,
   * plugins are imported into the server process and fully trusted.
   */
  isolate?: boolean;
  /** Secret names isolated plugins may not declare (see `IsolationOptions`). */
  reservedSecrets?: readonly string[];
}

/** Load plugins from a directory of ESM modules. */
export async function loadExternalPlugins(
  dir: string,
  logger: Logger,
  options: ExternalPluginOptions = {},
): Promise<Plugin[]> {
  const isolate = options.isolate ?? true;
  const absolute = path.resolve(dir);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) {
    logger.warn(`plugins dir ${absolute} is not a directory, skipping external plugins`);
    return [];
  }

  const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
  const plugins: Plugin[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mjs|js)$/.test(entry.name)) continue;
    const file = path.join(absolute, entry.name);
    // Resolve symlinks and ensure the target stays inside the plugins dir.
    const real = await fs.promises.realpath(file).catch(() => file);
    if (!real.startsWith(absolute + path.sep) && real !== file) {
      logger.warn(`plugin ${entry.name}: escapes plugins dir, skipping`);
      continue;
    }
    try {
      if (isolate) {
        if (!sandboxSupported && plugins.length === 0) {
          logger.warn(
            `Node ${process.version} lacks the permission model or native type stripping: ` +
              "external plugins get their own process but no filesystem sandbox (needs Node >= 22.18)",
          );
        }
        const plugin = await loadIsolatedPlugin(file, { logger, reservedSecrets: options.reservedSecrets });
        plugins.push(plugin);
        logger.info(`loaded external plugin: ${plugin.id} (${entry.name}, isolated)`);
        continue;
      }
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
      logger.info(`loaded external plugin: ${plugin.id} (${entry.name}, in-process)`);
    } catch (error) {
      logger.error(`failed to load plugin ${entry.name}`, String(error));
    }
  }

  return plugins;
}
