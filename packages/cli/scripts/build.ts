// Arma el paquete npm `lunasq` en `dist/` (ADR uw-28-instalador): un solo bundle ESM con todo el
// monorepo salvo better-sqlite3 (nativo, con prebuild), más las migraciones y los assets que el
// bundle busca junto a sí (`bin/../drizzle`, `bin/../assets`). Node no quita tipos dentro de
// node_modules, así que el paquete publicado no puede llevar los `.ts` del repo.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    // Dependencias CommonJS dentro de un bundle ESM: su `require` necesita uno real.
    banner: {
      js: 'import { createRequire as __lunasqCreateRequire } from "node:module"; const require = __lunasqCreateRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  await cp(join(repo, "packages", "db", "drizzle"), join(outdir, "drizzle"), { recursive: true });
  // El front end va en `web/`, que `lunasq start` sirve; siempre se arma de nuevo para no
  // publicar un build viejo.
  const webDist = join(repo, "packages", "web", "dist", "app");
  execFileSync("pnpm", ["--filter", "@lunasq/web", "build"], { cwd: repo, stdio: "inherit" });
  await cp(webDist, join(outdir, "web"), { recursive: true });
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
    description: "Cola de tareas que despacha agentes de codificación a través de herdr",
    type: "module",
    bin: { lunasq: "bin/lunasq.js" },
    engines: { node: ">=26" },
    dependencies: { "better-sqlite3": pkg.dependencies["better-sqlite3"] },
  };
  await writeFile(join(outdir, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
  return outdir;
}

if (import.meta.main) console.log(`lunasq → ${await buildPackage(process.argv[2])}`);
