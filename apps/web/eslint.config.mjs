import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

/**
 * Next 16 removed the `next lint` subcommand, so this app lints through the
 * ESLint CLI directly. `core-web-vitals` is the rule set `next lint` used to
 * apply — Next's own plugin plus the React and React Hooks recommendations,
 * with the rules that affect Core Web Vitals raised from warning to error.
 *
 * Listing the ignores explicitly is Next's documented flat-config setup:
 * `globalIgnores` replaces the defaults `eslint-config-next` carries rather
 * than adding to them, so build output has to be named again here.
 */
export default defineConfig([
  ...nextVitals,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    rules: {
      /*
       * Zest serves uploaded media straight off disk from the server's
       * `/media` route — no CDN, no bucket, no image loader (see
       * `apps/server/src/main.ts`). `next/image` exists to put an optimizer in
       * front of exactly the thing this deployment deliberately does not have,
       * so the rule has nothing to offer here and would only be silenced at
       * every call site.
       */
      "@next/next/no-img-element": "off",
    },
  },
  {
    // A PostCSS config is an anonymous object export by definition.
    files: ["*.config.mjs", "*.config.js"],
    rules: { "import/no-anonymous-default-export": "off" },
  },
]);
