// Secret redaction for the evidence file (docs/design.md §Audit, ADR
// uw-24-archivo-evidencia). gitleaks-style patterns: known token formats, private
// keys, credentials in URLs and variable assignments with a secret name. It prefers
// to over-redact: the file travels in the PR and stays in git history.

type Rule = { id: string; pattern: RegExp; replace?: (...groups: string[]) => string };

const redacted = (id: string) => `[REDACTED:${id}]`;

/** The quotes a value opens (or closes) with, to keep them when redacting it. */
function quoteOf(value: string, closing = false): string {
  const m = /^(\\?["'])/.exec(value);
  if (!m?.[1]) return "";
  const quoted = value.length > m[1].length && value.endsWith(m[1].replace("\\", ""));
  return closing && !quoted ? "" : m[1];
}

const RULES: readonly Rule[] = [
  {
    id: "private-key",
    // With or without closing: a trimmed transcript can leave the block half done.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?=\n\s*\n)|$)/g,
  },
  {
    // Body of a key whose BEGIN was left out (trimming): base64 lines and the END.
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
    // LunasQ's run token (ADR 0002): in the MCP header and in the pane's environment.
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
    // `SECRET_NAME = value`, `"password": "value"`, `-pvalue`. Keeps the name. The quoted
    // value is redacted whole (with spaces); the quotes may come escaped (`\\"`, JSON
    // inside JSON). Without quotes, up to the first space or delimiter.
    id: "assignment",
    // Without a name prefix: `DB_` stays out of the match and is kept, and the bounded quantifier
    // avoids quadratic backtracking in long texts.
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

/** A known value shorter than this would wreck the text if replaced everywhere. */
const MIN_KNOWN_LENGTH = 8;

export type RedactOptions = {
  /** Exact known secrets (e.g. the Run's run token): they are replaced wherever they are. */
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
