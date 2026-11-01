import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// README.md de la raíz: puerta de entrada del repo. Estas pruebas evitan que se pudra:
// secciones obligatorias, tabla de contenidos, enlaces relativos y comandos pnpm citados.
const root = join(import.meta.dirname, "..");
const readmePath = join(root, "README.md");

function readme(): string {
  expect(existsSync(readmePath), "falta README.md en la raíz del repo").toBe(true);
  return readFileSync(readmePath, "utf8");
}

interface Fence {
  info: string;
  body: string;
}

/** Separa el markdown en texto fuera de bloques de código y bloques de código. */
function split(md: string): { prose: string; fences: Fence[] } {
  const fences: Fence[] = [];
  const prose = md.replace(/^```(.*)\n([\s\S]*?)^```[ \t]*$/gm, (_, info: string, body: string) => {
    fences.push({ info: info.trim(), body });
    return "";
  });
  return { prose, fences };
}

function headings(md: string, level: number): string[] {
  const { prose } = split(md);
  const re = new RegExp(`^#{${level}} +(.+?) *#*$`, "gm");
  return [...prose.matchAll(re)].map((m) => m[1] as string);
}

/** Ancla que genera GitHub para un encabezado. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function links(md: string): string[] {
  const { prose } = split(md);
  return [...prose.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
    (m) => m[1] as string,
  );
}

function isExternal(target: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

type PackageJson = { name?: string; scripts?: Record<string, string> };

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
}

function workspaces(): Map<string, PackageJson> {
  const found = new Map<string, PackageJson>();
  for (const group of ["packages", "assets"]) {
    for (const name of readdirSync(join(root, group))) {
      const dir = join(root, group, name);
      if (existsSync(join(dir, "package.json"))) {
        const pkg = readPackage(dir);
        if (pkg.name) found.set(pkg.name, pkg);
      }
    }
  }
  return found;
}

// Subcomandos propios de pnpm que no son scripts.
const pnpmBuiltins = new Set(["install", "i", "add", "exec", "dlx", "run"]);

interface Cited {
  line: string;
  filter: string | undefined;
  script: string | undefined;
}

function citedPnpm(md: string): Cited[] {
  const { fences } = split(md);
  const cited: Cited[] = [];
  for (const { body } of fences) {
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\s#.*$/, "");
      for (const m of line.matchAll(/(?:^|[\s&;|(])pnpm((?:\s+[^\s&;|)]+)*)/g)) {
        const tokens = (m[1] as string).trim().split(/\s+/).filter(Boolean);
        let filter: string | undefined;
        let i = 0;
        while (tokens[i]?.startsWith("-")) {
          if (tokens[i] === "--filter" || tokens[i] === "-F") {
            filter = tokens[i + 1];
            i += 2;
          } else {
            i += 1;
          }
        }
        let script = tokens[i];
        if (script === "run") script = tokens[i + 1];
        else if (script !== undefined && pnpmBuiltins.has(script)) script = undefined;
        cited.push({ line: line.trim(), filter, script });
      }
    }
  }
  return cited;
}

describe("README.md", () => {
  it("existe en la raíz y su primer encabezado de nivel 1 menciona LunasQ", () => {
    const h1 = headings(readme(), 1);
    expect(h1[0]).toContain("LunasQ");
  });

  describe("secciones obligatorias", () => {
    const required: [string, RegExp][] = [
      ["qué es / para qué sirve", /qué es|para qué sirve/i],
      ["características", /caracter[ií]sticas/i],
      ["arquitectura", /arquitectura/i],
      ["requisitos", /requisitos/i],
      ["inicio rápido", /inicio r[aá]pido/i],
      ["uso", /^uso\b/i],
      ["configuración", /configuraci[oó]n/i],
      ["estructura del repositorio", /estructura del repositorio/i],
      ["desarrollo", /^desarrollo\b/i],
      ["documentación", /documentaci[oó]n/i],
      ["contribución", /contribuci[oó]n|contribuir/i],
    ];

    it.each(required)("incluye la sección %s", (_name, pattern) => {
      const h2 = headings(readme(), 2);
      expect(
        h2.some((h) => pattern.test(h)),
        `encabezados de nivel 2: ${h2.join(" | ")}`,
      ).toBe(true);
    });
  });

  it("cada ancla de la tabla de contenidos corresponde a un encabezado", () => {
    const md = readme();
    const anchors = new Set(
      [...split(md).prose.matchAll(/^#{1,6} +(.+?) *#*$/gm)].map((m) => slug(m[1] as string)),
    );
    const toc = links(md).filter((l) => l.startsWith("#"));
    expect(toc.length, "la tabla de contenidos no tiene enlaces a anclas").toBeGreaterThan(5);
    const broken = toc.filter((l) => !anchors.has(l.slice(1)));
    expect(broken, `anclas sin encabezado: ${broken.join(", ")}`).toEqual([]);
  });

  it("todo enlace o imagen relativo apunta a una ruta que existe", () => {
    const relative = links(readme()).filter((l) => !isExternal(l) && !l.startsWith("#"));
    expect(relative.length).toBeGreaterThan(0);
    const broken = relative.filter((l) => {
      const path = decodeURIComponent(l.split("#")[0] as string);
      return !existsSync(resolve(root, path));
    });
    expect(broken, `enlaces rotos: ${broken.join(", ")}`).toEqual([]);
  });

  it("todo comando pnpm citado existe como script", () => {
    const packages = workspaces();
    const rootScripts = readPackage(root).scripts ?? {};
    const cited = citedPnpm(readme());
    expect(cited.length).toBeGreaterThan(0);

    const missing = cited.flatMap(({ line, filter, script }) => {
      if (script === undefined) return [];
      if (filter === undefined) {
        return script in rootScripts ? [] : [`${line} (no hay script «${script}» en la raíz)`];
      }
      const pkg = packages.get(filter);
      if (!pkg) return [`${line} (no existe el paquete «${filter}»)`];
      // `pnpm --filter x exec ...` se descartó arriba (script undefined); aquí sólo scripts.
      return script in (pkg.scripts ?? {})
        ? []
        : [`${line} (no hay script «${script}» en ${filter})`];
    });
    expect(missing, `comandos inexistentes:\n${missing.join("\n")}`).toEqual([]);
  });

  describe("coherencia con el repo", () => {
    it("requisitos e inicio rápido mencionan versiones, comandos y puerto", () => {
      const md = readme();
      const nodeMajor = readFileSync(join(root, ".node-version"), "utf8").trim().split(".")[0];
      const pnpmMajor = (
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          packageManager: string;
        }
      ).packageManager.match(/pnpm@(\d+)/)?.[1];
      expect(md).toMatch(new RegExp(`Node(\\.js)? ${nodeMajor}`));
      expect(md).toMatch(new RegExp(`pnpm ${pnpmMajor}`));
      expect(md).toMatch(/herdr[^\n]*0\.9\.5/);
      expect(md).toMatch(/Claude Code[^\n]*2\.1\.312/);
      expect(md).toMatch(/\bgh\b/);
      for (const cmd of ["lunasq install", "lunasq doctor", "lunasq start"]) {
        expect(md).toContain(cmd);
      }
      expect(md).toContain("7360");
    });

    it("la estructura del repositorio nombra cada paquete y asset", () => {
      const md = readme();
      const dirs = [
        ...readdirSync(join(root, "packages")).map((n) => `packages/${n}`),
        ...readdirSync(join(root, "assets"))
          .filter((n) => existsSync(join(root, "assets", n, "package.json")))
          .map((n) => `assets/${n}`),
      ];
      const missing = dirs.filter((d) => !md.includes(d));
      expect(missing, `directorios sin mencionar: ${missing.join(", ")}`).toEqual([]);
    });

    it("solo declara badges respaldados y no inventa licencia", () => {
      const md = readme();
      const badges = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
        .map((m) => m[1] as string)
        .filter((u) => /shields\.io|badge/i.test(u));
      expect(badges.some((b) => b.includes("actions/workflows/ci.yml"))).toBe(true);
      expect(badges.some((b) => /node/i.test(b))).toBe(true);
      expect(existsSync(join(root, ".github", "workflows", "ci.yml"))).toBe(true);
      const hasLicenseFile = readdirSync(root).some((n) => /^licen[cs]e/i.test(n));
      if (!hasLicenseFile) {
        expect(md).not.toMatch(/license-|licencia (MIT|Apache|GPL|BSD)|\bMIT License\b/i);
      }
      expect(md).not.toMatch(/codecov|coveralls|npm\/v\//i);
    });
  });
});
