// Metro config for `@hat/mobile`, which lives inside the pnpm workspace.
//
// Four adjustments are needed to reach code outside this package:
//
//  1. `watchFolders` — the app is symlinked into the workspace root, so Metro
//     has to watch the root to see edits to `@hat/core` and to dependency
//     resolution changes.
//  2. `nodeModulesPaths` — the app's own `node_modules` and the workspace root's,
//     so a bare specifier resolves even when the importer sits in a sibling
//     workspace package.
//  3. `transformIgnorePatterns` — `@hat/core` ships raw TypeScript (`"exports":
//     { ".": "./src/index.ts" }`, no build step), so Metro has to run Babel over
//     it. The default pattern ignores everything under `node_modules`, which
//     would leave `interface` and `export type` untransformed.
//  4. `resolveRequest` — the packages in this repo are written for Node's ESM
//     resolver, so their relative imports carry a `.js` extension that only
//     exists in the emitted JavaScript (`import { x } from "./errors.js"` in a
//     `.ts` file). Metro's own `sourceExts` handling *appends* extensions
//     rather than substituting them, so it looks for `errors.js.ts` and gives
//     up. The shim below rewrites those specifiers to the sibling `.ts`.
//
// Note what is deliberately *not* set: `disableHierarchicalLookup`. Metro's
// walk up the directory tree is what finds a package's dependencies in pnpm's
// nested store — react-native's own `invariant` lives next to it under
// `.pnpm/`, and is in neither of the paths above. Turning the walk off breaks
// resolution of every transitive dependency.
//
// The `.pnpm/` alternation covers both layouts: a hoisted (npm/yarn) store puts
// the real directory at `node_modules/<name>`, while pnpm reaches it through
// `node_modules/.pnpm/<name>@<version>/node_modules/<name>`.

const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

config.transformIgnorePatterns = [
  "node_modules/(?!(?:.pnpm/)?(?:@react-native|react-native|@react-navigation|@expo|@expo-google-fonts|expo|expo-modules-core|expo-asset|expo-constants|expo-file-system|expo-font|expo-linking|@hat)(/|$))",
];

/** Emitted JS extension -> the TypeScript sources it can have come from. */
const TS_SOURCE_FOR = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts", ".ts"]],
  [".cjs", [".cts", ".ts"]],
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const sources = TS_SOURCE_FOR.get(path.extname(moduleName));
  const isLocal =
    moduleName.startsWith("./") || moduleName.startsWith("../") || path.isAbsolute(moduleName);
  if (sources && isLocal && context.originModulePath) {
    const base = moduleName.slice(0, -path.extname(moduleName).length);
    const dir = path.dirname(context.originModulePath);
    for (const source of sources) {
      if (fs.existsSync(path.resolve(dir, base + source))) {
        return context.resolveRequest(context, base + source, platform);
      }
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
