// Redacción de secretos del archivo de evidencia (docs/design.md §Auditoría, ADR
// uw-24-archivo-evidencia). Patrones al estilo gitleaks: formatos de token conocidos, llaves
// privadas, credenciales en URLs y asignaciones de variables con nombre de secreto. Se prefiere
// redactar de más: el archivo viaja en el PR y queda en el historial de git.

type Rule = { id: string; pattern: RegExp; replace?: (...groups: string[]) => string };

const redacted = (id: string) => `[REDACTED:${id}]`;

/** Las comillas con las que abre (o cierra) un valor, para conservarlas al redactarlo. */
function quoteOf(value: string, closing = false): string {
  const m = /^(\\?["'])/.exec(value);
  if (!m?.[1]) return "";
  const quoted = value.length > m[1].length && value.endsWith(m[1].replace("\\", ""));
  return closing && !quoted ? "" : m[1];
}

const RULES: readonly Rule[] = [
  {
    id: "private-key",
    // Con o sin cierre: un transcript recortado puede dejar el bloque a medias.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?=\n\s*\n)|$)/g,
  },
  {
    // Cuerpo de una llave cuyo BEGIN quedó fuera (recorte): líneas base64 y el END.
    id: "private-key",
    pattern:
      /(?:^|\n)(?:[A-Za-z0-9+/=]{16,}[ \t]*\n)+[ \t]*-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: "bearer",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
    replace: (_all, prefix) => `${prefix}${redacted("bearer")}`,
  },
  {
    id: "basic-auth",
    pattern: /\b(Basic\s+)[A-Za-z0-9+/]{12,}={0,2}/g,
    replace: (_a, p) => `${p}${redacted("basic-auth")}`,
  },
  {
    // El run token de LunasQ (ADR 0002): en el header del MCP y en el entorno del pane.
    id: "run-token",
    pattern: /\b(X-LunasQ-Run-Token|LUNASQ_RUN_TOKEN)(\s*[:=]\s*)["']?[^\s"']+["']?/gi,
    replace: (_all, name, sep) => `${name}${sep}${redacted("run-token")}`,
  },
  {
    id: "url-credentials",
    pattern: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}:)[^\s/@]+(@)/gi,
    replace: (_all, head, at) => `${head}${redacted("url-credentials")}${at}`,
  },
  {
    // `NOMBRE_SECRETO = valor`, `"password": "valor"`, `-pvalor`. Conserva el nombre. El valor entre
    // comillas se redacta completo (con espacios); las comillas pueden venir escapadas (`\\"`, JSON
    // dentro de JSON). Sin comillas, hasta el primer espacio o delimitador.
    id: "assignment",
    // Sin prefijo de nombre: `DB_` queda fuera del match y se conserva, y el cuantificador acotado
    // evita el backtracking cuadrático en textos largos.
    pattern:
      /((?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]{0,64}(?:\\?["'])?\s*[:=]\s*)(?!\[REDACTED)(\\?"(?:[^"\\\n]|\\.){4,}?\\?"|'[^'\n]{4,}'|\\?["']?[^\s"'`,;)}\]\\]{8,})/gi,
    replace: (_all, head, value) => `${head}${quoteOf(value)}[REDACTED]${quoteOf(value, true)}`,
  },
  {
    id: "cli-password",
    pattern: /(\s-p)(?=[^\s=-])[^\s]{6,}/g,
    replace: (_all, head) => `${head}${redacted("cli-password")}`,
  },
];

/** Un valor conocido más corto que esto destrozaría el texto al reemplazarlo en todas partes. */
const MIN_KNOWN_LENGTH = 8;

export type RedactOptions = {
  /** Secretos exactos que se conocen (p. ej. el run token del Run): se reemplazan donde estén. */
  known?: readonly string[];
};

export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  let out = text;
  for (const secret of opts.known ?? []) {
    if (secret.length >= MIN_KNOWN_LENGTH) out = out.replaceAll(secret, redacted("known"));
  }
  for (const rule of RULES) {
    const replace = rule.replace;
    out = replace
      ? out.replace(rule.pattern, (...args) => replace(...(args as string[]).slice(0, -2)))
      : out.replace(rule.pattern, redacted(rule.id));
  }
  return out;
}
