import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "cordis-plugin-social": resolve(import.meta.dirname, "packages/core/src/index.ts"),
      "cordis-plugin-social-browser": resolve(import.meta.dirname, "packages/browser/src/index.ts"),
      "cordis-plugin-social-browser-local": resolve(import.meta.dirname, "packages/local-browser/src/index.ts"),
      "cordis-plugin-social-profilefleet": resolve(import.meta.dirname, "packages/profilefleet/src/index.ts"),
      "cordis-plugin-social-x": resolve(import.meta.dirname, "packages/x/src/index.ts"),
      "cordis-plugin-social-tools": resolve(import.meta.dirname, "packages/tools/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    sequence: { concurrent: false },
  },
});
