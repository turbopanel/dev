import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      exclude: ["node_modules/**"],
      coverage: {
        provider: "v8",
        reportsDirectory: "coverage",
        reporter: ["text", "lcov"],
        include: ["src/lib/**/*.ts", "src/hooks/**/*.ts"],
        // Ratchet. SonarCloud only gates coverage on *new* code (80%), so
        // repo-wide coverage could erode indefinitely without any gate
        // noticing. These are the measured levels minus ~1pt of headroom, so
        // ordinary churn passes and a real regression fails. Raise them when
        // coverage rises; do not lower them to make a red run go green.
        thresholds: {
          statements: 98,
          branches: 98,
          functions: 97,
          lines: 99,
        },
        exclude: [
          "**/*.test.*",
          // Ink theme tokens — no meaningful unit surface
          "src/theme.ts",
          // Spawn / systemd / Docker / log-tail integration — exercised in-guest only
          "src/lib/converge-service-log.ts",
          "src/lib/daemon-log.ts",
          "src/lib/daemon-install.ts",
          "src/lib/docker-access.ts",
          "src/lib/drizzle-studio.ts",
          "src/lib/instance-runtime.ts",
          "src/lib/open-url.ts",
          "src/lib/platform-docker-resources.ts",
          "src/lib/postgres-runtime.ts",
          "src/lib/reset-dev-database.ts",
          "src/lib/service-open.ts",
          "src/lib/service-restart.ts",
          "src/lib/spawn-trusted.ts",
          "src/lib/stack-versions.ts",
        ],
      },
    },
  }),
);
