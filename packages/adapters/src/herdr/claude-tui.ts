// Lo que LunasQ sabe de la TUI de Claude Code para operarla desde herdr. Es comportamiento externo,
// por eso vive en adapters junto al de herdr. Captura en spikes/herdr/outputs/09-agent-read-blocked.txt.

/** Opción del diálogo de confianza de carpeta que lo distingue de otros `blocked` (permisos). */
export const TRUST_DIALOG_MARKER = "Yes, I trust this folder";

/**
 * Teclas que aceptan el diálogo: el cursor arranca en "No, exit", así que un Enter a secas
 * cerraría Claude Code (ADR 0004).
 */
export const TRUST_ACCEPT_KEYS = ["down", "enter"] as const;

/** Copilot's interactive workspace-trust dialog selects "1. Yes" by default. */
export const COPILOT_TRUST_ACCEPT_KEYS = ["enter"] as const;

/** Si la pantalla del agente muestra el diálogo de confianza de carpeta. */
export function showsTrustDialog(screen: string): boolean {
  return screen.includes(TRUST_DIALOG_MARKER) && screen.includes("No, exit");
}

/** Si Copilot CLI muestra su diálogo interactivo de confianza de carpeta. */
export function showsCopilotTrustDialog(screen: string): boolean {
  return (
    screen.includes("Confirm folder trust") &&
    screen.includes("Do you trust the files in this folder?") &&
    screen.includes("1. Yes")
  );
}

/**
 * La TUI del agente cuando se agota el uso: el aviso queda en pantalla y reintentar no sirve hasta
 * que se restablece. Textos vistos del CLI: `Usage limit reached · limit resets 3:45pm`,
 * `Usage limit reached · wrapping up`, `5-hour limit reached · resets <hora>`, el pie de la
 * espera `Continuing automatically at 3:45pm · Esc to cancel` y el corte
 * `Automatic continue stopped after repeated usage-limit hits`. herdr no conoce ese UI (su
 * manifiesto de detección no tiene regla para él), así que LunasQ lo reconoce aquí.
 */
export const USAGE_LIMIT_PATTERN = new RegExp(
  [
    "usage limit reached",
    "hit your usage limit",
    "usage-limit", // `Automatic continue stopped after repeated usage-limit hits`
    "(?:5-hour|weekly|session) limit (?:reached|resets)",
    "reached your (?:5-hour|weekly|session) limit",
    "limit(?: will)? resets? [^\\n]*?\\d{1,3}:\\d{2}", // `· limit resets 3:45pm`
    "limit will reset at ", // `Your limit will reset at 5pm (Asia/Tokyo)`
    "continuing automatically",
    "automatic continue",
  ].join("|"),
  "i",
);

/** Si la pantalla del agente muestra el aviso de límite de uso. */
export function showsUsageLimit(screen: string): boolean {
  return USAGE_LIMIT_PATTERN.test(screen);
}

/**
 * El aviso como lo dibuja Claude, para la nota del escalamiento: la última línea que lo menciona
 * con su tanda contigua de a lo más tres líneas (el aviso y su pie con la hora del reset).
 */
export function usageLimitMessage(screen: string): string {
  const lines = screen.split("\n").map((line) => line.trim());
  const idx = lines.reduce((last, line, i) => (USAGE_LIMIT_PATTERN.test(line) ? i : last), -1);
  if (idx === -1) return "usage limit reached";
  let start = idx;
  for (
    let steps = 0;
    steps < 2 && start > 0 && USAGE_LIMIT_PATTERN.test(lines[start - 1] ?? "");
    steps += 1
  )
    start -= 1;
  const message = lines
    .slice(start, idx + 1)
    .filter(Boolean)
    .join(" · ");
  return message.slice(0, 500) || "usage limit reached";
}
