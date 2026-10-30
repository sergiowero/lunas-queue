// Lectura mínima de un valor de texto de un TOML (la config de herdr): basta para una clave, así
// que no se agrega un parser. Entiende tablas `[a.b]`, claves con puntos y comentarios `#`.

/** Valor de `key` (ruta con puntos, p. ej. `ui.toast.delivery`) si es un string; si no, undefined. */
export function tomlString(text: string, key: string): string | undefined {
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\s*([^[\]]+?)\s*\]$/.exec(line);
    if (header) {
      table = (header[1] ?? "").replace(/\s*\.\s*/g, ".");
      continue;
    }
    const pair = /^([A-Za-z0-9_.\-\s]+?)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(line);
    if (!pair) continue;
    const name = (pair[1] ?? "").replace(/\s*\.\s*/g, ".");
    const full = table ? `${table}.${name}` : name;
    if (full === key) return pair[2] ?? pair[3];
  }
  return undefined;
}
