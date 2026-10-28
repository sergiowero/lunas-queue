import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Fronteras de dependencia de docs/tech-stack.md. Cambiarla exige actualizar ese doc y biome.json.
// Cada paquete declara exactamente sus dependencias permitidas, para que package.json,
// tsconfig.references y los overrides de Biome describan la misma matriz.
const allowed: Record<string, string[]> = {
  schemas: [],
  domain: ["schemas"],
  db: ["schemas", "domain"],
  adapters: ["schemas"],
  server: ["domain", "db", "adapters", "schemas"],
  web: ["schemas"],
  cli: ["server"],
};

const root = join(import.meta.dirname, "..");

type PackageJson = Record<string, Record<string, string> | undefined>;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function internalDeps(pkgDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson;
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return fields
    .flatMap((field) => Object.keys(pkg[field] ?? {}))
    .filter((name) => name.startsWith("@lunasq/"))
    .map((name) => name.slice("@lunasq/".length));
}

function tsReferences(pkgDir: string): string[] {
  const tsconfig = JSON.parse(readFileSync(join(pkgDir, "tsconfig.json"), "utf8")) as {
    references?: { path: string }[];
  };
  return (tsconfig.references ?? []).map((ref) => ref.path.replace("../", ""));
}

describe("fronteras de dependencia", () => {
  const packages = readdirSync(join(root, "packages")).filter((name) =>
    existsSync(join(root, "packages", name, "package.json")),
  );

  it("todo paquete de packages/ está en la matriz", () => {
    expect(packages.sort()).toEqual(Object.keys(allowed).sort());
  });

  it.each(packages)("%s solo declara dependencias permitidas", (name) => {
    const dir = join(root, "packages", name);
    expect(internalDeps(dir).sort()).toEqual([...(allowed[name] ?? [])].sort());
    expect(tsReferences(dir).sort()).toEqual([...(allowed[name] ?? [])].sort());
  });

  it.each(packages)("biome.json prohíbe en %s todo @lunasq/* fuera de la matriz", (name) => {
    const biome = readJson<{
      overrides: {
        includes: string[];
        linter: {
          rules: {
            style: { noRestrictedImports: { options: { patterns: { group: string[] }[] } } };
          };
        };
      }[];
    }>(join(root, "biome.json"));
    const override = biome.overrides.find((o) => o.includes.includes(`packages/${name}/**`));
    const group = override?.linter.rules.style.noRestrictedImports.options.patterns[0]?.group ?? [];
    const exceptions = group.filter((g) => g.startsWith("!@lunasq/") && !g.endsWith("/**"));
    expect(group[0]).toBe("@lunasq/*");
    expect(exceptions.map((g) => g.slice("!@lunasq/".length)).sort()).toEqual(
      [...(allowed[name] ?? [])].sort(),
    );
  });

  it("la raíz no depende de paquetes internos ni abre el hoisting de pnpm", () => {
    expect(internalDeps(root)).toEqual([]);
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toMatch(/nodeLinker|shamefullyHoist|publicHoistPattern|hoistPattern/);
    expect(existsSync(join(root, ".npmrc"))).toBe(false);
  });

  it("tsconfig.json raíz referencia todos los paquetes y tooling", () => {
    const refs = readJson<{ references: { path: string }[] }>(
      join(root, "tsconfig.json"),
    ).references;
    expect(refs.map((r) => r.path).sort()).toEqual(
      [...packages.map((p) => `packages/${p}`), "tooling"].sort(),
    );
  });

  it.each(["skills", "agents"])("assets/%s no depende de paquetes internos", (name) => {
    expect(internalDeps(join(root, "assets", name))).toEqual([]);
  });
});
