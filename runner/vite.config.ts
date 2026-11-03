// Bundles buzz-runner into one Node script, the way buzz-app builds its
// standalone MCP server (vite.buzz-mcp.config.ts). Build tools and libraries
// are the runner's own (package.json, pnpm-lock.yaml); `runner/buzz-app` is a
// local link to a buzz-app clone at the pinned revision (scripts/link-toolchain),
// so `@buzz` imports its harness modules unchanged.
// Build with scripts/build-runner, which checks the link, the revision and the
// installed dependencies.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The buzz-app clone link that scripts/link-toolchain makes. */
const BUZZ_APP_LINK = "buzz-app";
/** Lets a build write outside the checkout (for example a temp dir), so a
 * dogfood build never replaces the bundle a deploy reads. */
const OUT_DIR_ENV = "BUZZ_RUNNER_OUT_DIR";
const BUNDLE_NAME = "buzz-runner.mjs";
const NODE_TARGET = "node24";
const ENTRY = resolve(here, "src/main.ts");
/** Imports that name a file, a builtin or a module Vite made up, not a package. */
const NOT_A_PACKAGE = /^(?:[./]|node:|\0|virtual:)/;
const PLUGIN_NAME = "buzz-runner-own-dependencies";

const buzzLink = resolve(here, BUZZ_APP_LINK);
const buzzSrc = resolve(buzzLink, "src");
const customOut = process.env[OUT_DIR_ENV];
const outDir = resolve(customOut ?? resolve(here, "dist"));

/** True when `file` is inside `dir`. */
function inside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * A buzz-app module's package imports resolve in the runner, not in the
 * clone. Vite resolves a module's imports from its real path, so without this
 * the clone's own node_modules (when it has one) would supply them, outside
 * the runner's lockfile and its 14-day release age. A package the runner does
 * not declare stops the build (fail closed), so a new buzz-app dependency is
 * added to package.json on purpose, never pulled in unseen.
 */
function ownDependencies(): Plugin {
  let clone = "";
  return {
    name: PLUGIN_NAME,
    enforce: "pre",
    buildStart() {
      clone = realpathSync(buzzLink);
    },
    async resolveId(source, importer, options) {
      if (!importer || NOT_A_PACKAGE.test(source) || isAbsolute(source)) return null;
      const from = importer.split("?")[0] ?? importer;
      const base = inside(buzzLink, from) ? buzzLink : inside(clone, from) ? clone : undefined;
      if (!base) return null;
      const found = await this.resolve(source, ENTRY, { ...options, skipSelf: true });
      if (found) return found;
      this.error(`${relative(base, from)} imports "${source}", which runner/package.json does not declare: add it with a pinned version`);
    },
  };
}

export default defineConfig({
  root: here,
  publicDir: false,
  plugins: [ownDependencies()],
  // Symlinks kept: buzz-app modules keep their runner/buzz-app/... ids, so the
  // bundle names them relative to runner/ and holds no local clone path.
  // The plugin above, not the folder walk, then picks their packages.
  resolve: { alias: { "@buzz": buzzSrc }, preserveSymlinks: true },
  ssr: { noExternal: true, target: "node" },
  build: {
    outDir,
    // Only the checkout's own dist is emptied: a custom out dir may be any
    // folder, and vite would delete everything in it.
    emptyOutDir: !customOut,
    ssr: ENTRY,
    target: NODE_TARGET,
    minify: false,
    rolldownOptions: {
      output: { entryFileNames: BUNDLE_NAME, codeSplitting: false },
    },
  },
});
