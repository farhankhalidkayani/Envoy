import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Long-running experiments live in `*.experiment.ts` files, which the normal `vitest run` (and CI) never picks up.
 * Run them deliberately with `pnpm --filter @envoy/api experiment`.
 */
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ["src/**/*.experiment.ts"],
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 120_000,
  },
});
