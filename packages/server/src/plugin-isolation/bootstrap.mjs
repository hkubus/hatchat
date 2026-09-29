// Preloaded (`--import`) into sandboxed plugin processes. The workspace ships
// TypeScript sources that import each other as `./x.js`; Node's native type
// stripping loads `.ts` but doesn't remap those specifiers, and tsx can't run
// under the permission model (esbuild needs worker threads and a subprocess).
// Synchronous in-thread hooks keep this within the sandbox.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND" && /^\.{1,2}\/.*\.js$/.test(specifier)) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
