import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // NestJS's DI resolves constructor parameter types via TypeScript's
  // emitDecoratorMetadata — which esbuild (vitest's default transform)
  // does not implement, silently resolving injected providers to
  // `undefined`. SWC does emit it (see .swcrc); this plugin swaps the
  // transform for any test that bootstraps real Nest DI
  // (Test.createTestingModule), not just ones that `new` services by hand.
  plugins: [swc.vite()],
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // e2e files share real Postgres/Redis state (tenants scoped by unique
    // id are fine in parallel, but the login rate limiter is keyed by
    // source IP — global, not per-tenant). Running files in parallel let
    // one file's deliberate 429 trip poison another file's concurrent
    // /auth/login calls. Sequential files trade some wall-clock time for
    // not having to make every piece of shared state parallel-safe.
    fileParallelism: false,
  },
});
