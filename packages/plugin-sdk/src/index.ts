import type { Plugin } from "@hat/core";

export { z } from "zod";
export * from "@hat/core";

/** Identity helper for authoring plugins with full type checking. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
