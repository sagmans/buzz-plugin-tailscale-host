// Bundles buzz-runner into one Node script with buzz-app's own toolchain, the
// way buzz-app builds its standalone MCP server (vite.buzz-mcp.config.ts).
// The runner has no dependencies of its own: `runner/buzz-app` and
// `runner/node_modules` are local links to a buzz-app clone at the pinned
// revision (scripts/link-toolchain), so its locked vite, TypeScript and
// libraries are used and `@buzz` imports its harness modules unchanged.
// Build with scripts/build-runner, which checks the links and the revision.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The buzz-app clone link that scripts/link-toolchain makes. */
const BUZZ_APP_LINK = "buzz-app";
/** Lets a build write outside the checkout (for example a temp dir), so a
 * dogfood build never replaces the bundle a deploy reads. */
const OUT_DIR_ENV = "BUZZ_RUNNER_OUT_DIR";
const BUNDLE_NAME = "buzz-runner.mjs";
const NODE_TARGET = "node24";

const buzzSrc = resolve(here, BUZZ_APP_LINK, "src");
const customOut = process.env[OUT_DIR_ENV];
const outDir = resolve(customOut ?? resolve(here, "dist"));

export default defineConfig({
  root: here,
  publicDir: false,
  resolve: { alias: { "@buzz": buzzSrc } },
  ssr: { noExternal: true, target: "node" },
  build: {
    outDir,
    // Only the checkout's own dist is emptied: a custom out dir may be any
    // folder, and vite would delete everything in it.
    emptyOutDir: !customOut,
    ssr: resolve(here, "src/main.ts"),
    target: NODE_TARGET,
    minify: false,
    rolldownOptions: {
      output: { entryFileNames: BUNDLE_NAME, codeSplitting: false },
    },
  },
});
