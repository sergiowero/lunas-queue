/** Primer `x.y.z` del texto (p. ej. `2.1.314 (Claude Code)` o `v26.1.0`). */
export function parseVersion(text: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0];
}

/** Compara `x.y.z` numéricamente: negativo si `a < b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
