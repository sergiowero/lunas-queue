import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Dependency boundaries of docs/tech-stack.md. Changing it requires updating that doc and biome.json.
// Each package declares exactly its allowed dependencies, so that package.json,
// tsconfig.references and Biome's overrides describe the same matrix.
const allowed: Record<string, string[]> = {
  schemas: [],
  domain: ["schemas"],
  db: ["schemas", "domain"],
  adapters: ["schemas"],
  server: ["domain", "db", "adapters", "schemas"],
  web: ["schemas"],
  cli: ["server"],
  // End-to-end pilot: composes the runtime with adapter fakes; nobody imports it.
  e2e: ["server", "adapters", "schemas"],
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

describe("dependency boundaries", () => {
  const packages = readdirSync(join(root, "packages")).filter((name) =>
    existsSync(join(root, "packages", name, "package.json")),
  );

  it("every package in packages/ is in the matrix", () => {
    expect(packages.sort()).toEqual(Object.keys(allowed).sort());
  });

  it.each(packages)("%s only declares allowed dependencies", (name) => {
    const dir = join(root, "packages", name);
    expect(internalDeps(dir).sort()).toEqual([...(allowed[name] ?? [])].sort());
    expect(tsReferences(dir).sort()).toEqual([...(allowed[name] ?? [])].sort());
  });

  it.each(packages)("biome.json forbids in %s every @lunasq/* outside the matrix", (name) => {
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

  it("the root does not depend on internal packages nor open pnpm hoisting", () => {
    expect(internalDeps(root)).toEqual([]);
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toMatch(/nodeLinker|shamefullyHoist|publicHoistPattern|hoistPattern/);
    expect(existsSync(join(root, ".npmrc"))).toBe(false);
  });

  it("tsconfig.json root references all packages and tooling", () => {
    const refs = readJson<{ references: { path: string }[] }>(
      join(root, "tsconfig.json"),
    ).references;
    expect(refs.map((r) => r.path).sort()).toEqual(
      [...packages.map((p) => `packages/${p}`), "tooling"].sort(),
    );
  });

  it.each(["skills", "agents"])("assets/%s do not depend on internal packages", (name) => {
    expect(internalDeps(join(root, "assets", name))).toEqual([]);
  });
});
