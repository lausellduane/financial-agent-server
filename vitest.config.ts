import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The AI binding is remote in wrangler.jsonc. Tests do not call it.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: "testteam",
          ACCESS_AUD: "test-aud",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
  },
});
