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
  },
});
