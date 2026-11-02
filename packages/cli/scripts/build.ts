// Builds the `lunasq` npm package in `dist/` (ADR uw-28-instalador): a single ESM bundle with the whole
// monorepo except better-sqlite3 (native, with prebuild), plus the migrations and the assets the
// bundle looks for next to itself (`bin/../drizzle`, `bin/../assets`). Node does not strip types inside
// node_modules, so the published package cannot carry the repo's `.ts` files.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const cli = join(import.meta.dirname, "..");
const repo = join(cli, "..", "..");

export async function buildPackage(outdir = join(cli, "dist")): Promise<string> {
  const pkg = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
  await rm(outdir, { recursive: true, force: true });
  await build({
    entryPoints: [join(cli, "src", "bin.ts")],
    outfile: join(outdir, "bin", "lunasq.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    external: ["better-sqlite3"],
    // CommonJS dependencies inside an ESM bundle: their `require` needs a real one.
    banner: {
      js: 'import { createRequire as __lunasqCreateRequire } from "node:module"; const require = __lunasqCreateRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  await cp(join(repo, "packages", "db", "drizzle"), join(outdir, "drizzle"), { recursive: true });
  // The front end goes in `web/`, which `lunasq start` serves; it is always rebuilt so as not to
  // publish an old build.
  // It is built in its own temporary folder: two builds in the same checkout do not empty each other.
  const webDist = await mkdtemp(join(tmpdir(), "lunasq-web-"));
  try {
    execFileSync(
      "pnpm",
      ["--filter", "@lunasq/web", "exec", "vite", "build", "--outDir", webDist, "--emptyOutDir"],
      { cwd: repo, stdio: "inherit" },
    );
    await cp(webDist, join(outdir, "web"), { recursive: true });
  } finally {
    await rm(webDist, { recursive: true, force: true });
  }
  for (const dir of ["skills", "agents"]) {
    await cp(join(repo, "assets", dir), join(outdir, "assets", dir), {
      recursive: true,
      filter: (src) => !/node_modules|\.test\.ts$|package\.json$|\.gitignore$/.test(src),
    });
  }
  await mkdir(outdir, { recursive: true });
  const published = {
    name: "lunasq",
    version: pkg.version,
    description: "Task queue that dispatches coding agents through herdr",
    type: "module",
    bin: { lunasq: "bin/lunasq.js" },
    engines: { node: ">=26" },
    dependencies: { "better-sqlite3": pkg.dependencies["better-sqlite3"] },
  };
  await writeFile(join(outdir, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
  return outdir;
}

if (import.meta.main) console.log(`lunasq → ${await buildPackage(process.argv[2])}`);
