import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Fronteras de dependencia de docs/tech-stack.md. Cambiarla exige actualizar ese doc.
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

  it.each(["skills", "agents"])("assets/%s no depende de paquetes internos", (name) => {
    expect(internalDeps(join(root, "assets", name))).toEqual([]);
  });
});
