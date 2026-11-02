// Minimal reading of a text value from a TOML (herdr's config): enough for a key, so
// no parser is added. It understands `[a.b]` tables, dotted keys and `#` comments.

/** Value of `key` (dotted path, e.g. `ui.toast.delivery`) if it is a string; otherwise undefined. */
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
