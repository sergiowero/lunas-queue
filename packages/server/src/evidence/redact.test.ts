import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.ts";

const ghp = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const awsKey = "AKIAIOSFODNN7EXAMPLE";
const anthropic = `sk-ant-api03-${"Zx9_-Qw8Er7".repeat(4)}`;

describe("redactSecrets", () => {
  it.each([
    ["token de GitHub", `git push https://x:${ghp}@github.com/o/r`, ghp],
    ["fine-grained de GitHub", `token github_pat_${"A1b2C3d4E5".repeat(4)}`, "github_pat_"],
    ["access key de AWS", `aws_access_key_id ${awsKey}`, awsKey],
    ["API key de Anthropic", `ANTHROPIC=${anthropic}`, anthropic],
    ["API key de OpenAI", `key sk-${"abcDEF0123456789".repeat(3)}`, "sk-abcDEF"],
    ["token de Slack", "xoxb-1234567890-abcdefghij", "xoxb-1234567890"],
    ["clave de Stripe", `sk_live_${"a1b2c3d4e5f6g7h8"}`, "sk_live_a1b2"],
    [
      "API key de Google",
      `AIza${"SyA-1234567890abcdefghijklmnopqrstu".slice(0, 35)}`,
      "AIzaSyA-1234",
    ],
    [
      "token de npm",
      `//registry.npmjs.org/:_authToken=npm_${"a1B2c3D4e5".repeat(3)}123456`,
      "npm_a1B2",
    ],
    [
      "JWT",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
      "eyJhbGciOiJIUzI1NiJ9",
    ],
    [
      "bearer",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "abcdefghijklmnopqrstuvwxyz0123",
    ],
    ["run token del header", `X-LunasQ-Run-Token: ${"ab12".repeat(16)}`, "ab12ab12ab12"],
    ["run token del entorno", `LUNASQ_RUN_TOKEN=${"cd34".repeat(16)}`, "cd34cd34cd34"],
    ["credenciales en una URL", "postgres://admin:hunter2hunter2@db.local/x", "hunter2hunter2"],
    ["asignación genérica", 'const apiKey = "s3cr3t-valor-largo"', "s3cr3t-valor-largo"],
    ["variable de entorno con password", "DB_PASSWORD=correct-horse-battery", "correct-horse"],
  ])("redacta %s", (_name, text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED");
  });

  it("redacta un bloque de llave privada completo", () => {
    const text = [
      "antes",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
      "QyNTUxOQAAACBk",
      "-----END OPENSSH PRIVATE KEY-----",
      "después",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).toBe("antes\n[REDACTED:private-key]\ndespués");
  });

  it("redacta un bloque de llave privada cortado sin su cierre", () => {
    const out = redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nmás");
    expect(out).not.toContain("MIIEow");
  });

  it("conserva el nombre de la variable y redacta solo el valor", () => {
    expect(redactSecrets("API_KEY=abcdef123456")).toBe("API_KEY=[REDACTED]");
    expect(redactSecrets('"password": "hunter2hunter2"')).toBe('"password": "[REDACTED]"');
  });

  it("redacta el cuerpo de una llave privada cuyo BEGIN quedó fuera", () => {
    const body = "MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxx\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    const out = redactSecrets(`resto\n${body}\n-----END RSA PRIVATE KEY-----\nfin`);
    expect(out).not.toContain("MIIEow");
    expect(out).not.toContain("END RSA");
    expect(out).toContain("fin");
  });

  it.each([
    [
      "JSON anidado con comillas escapadas",
      '{"content":"{\\"password\\": \\"hunter2hunter2\\"}"}',
      "hunter2",
    ],
    ["valor entre comillas con espacios", "DB_PASSWORD='p@ss w0rd long'", "w0rd"],
    ["valor entre comillas dobles con espacios", 'password="abc def ghi jkl"', "ghi jkl"],
    ["Basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "dXNlcjpw"],
    [
      "contraseña de mysql en la línea de comandos",
      "mysql -u root -pSuperSecret123 db",
      "SuperSecret123",
    ],
  ])("redacta %s", (_name, text, secret) => {
    expect(redactSecrets(text)).not.toContain(secret);
  });

  it("no tarda de forma cuadrática con nombres largos sin secreto", () => {
    const start = Date.now();
    redactSecrets("a.".repeat(50_000));
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("redacta los valores conocidos de forma literal", () => {
    const out = redactSecrets("el token es tok_raro_1234 y otra vez tok_raro_1234", {
      known: ["tok_raro_1234"],
    });
    expect(out).toBe("el token es [REDACTED:known] y otra vez [REDACTED:known]");
  });

  it("ignora valores conocidos demasiado cortos para no destrozar el texto", () => {
    expect(redactSecrets("a b ab", { known: ["a", "ab"] })).toBe("a b ab");
  });

  it("deja intacto el texto sin secretos", () => {
    const text = "Implementé T-1 y T-2.\nPasan 12 tests; commit 3f2a9c1 en lunasq/tasks.\n";
    expect(redactSecrets(text)).toBe(text);
  });

  it("no toca palabras como token o password sin un valor asignado", () => {
    const text = "el token se valida; password: corto";
    expect(redactSecrets(text)).toBe(text);
  });

  it("es idempotente", () => {
    const once = redactSecrets(`key ${ghp} y DB_PASSWORD=correct-horse-battery`);
    expect(redactSecrets(once)).toBe(once);
  });
});
