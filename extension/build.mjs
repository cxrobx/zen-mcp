import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(root, "src");
const outDir = join(root, "dist");

if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [
    join(srcDir, "background.ts"),
    join(srcDir, "options/options.ts"),
    join(srcDir, "snapshot/inject.ts"),
    join(srcDir, "readability/inject.ts"),
    join(srcDir, "mask/inject.ts"),
  ],
  outdir: outDir,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox115",
  sourcemap: true,
  logLevel: "info",
});

// Babel standalone is intentionally self-contained and therefore large. Minify
// this page-injected evaluator separately and omit its source map so every
// evaluate_script call does not ship multi-megabyte debug text into the tab.
await build({
  entryPoints: [join(srcDir, "evaluate/inject.ts")],
  outfile: join(outDir, "evaluate/inject.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox115",
  minify: true,
  sourcemap: false,
  logLevel: "info",
});

await cp(join(srcDir, "manifest.json"), join(outDir, "manifest.json"));
await mkdir(join(outDir, "options"), { recursive: true });
await cp(join(srcDir, "options/options.html"), join(outDir, "options/options.html"));
await cp(join(srcDir, "options/options.css"), join(outDir, "options/options.css"));

const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`extension built -> ${outDir}`);
