// Lo que LunasQ sabe de la TUI de Claude Code para operarla desde herdr. Es comportamiento externo,
// por eso vive en adapters junto al de herdr. Captura en spikes/herdr/outputs/09-agent-read-blocked.txt.

/** Opción del diálogo de confianza de carpeta que lo distingue de otros `blocked` (permisos). */
export const TRUST_DIALOG_MARKER = "Yes, I trust this folder";

/**
 * Teclas que aceptan el diálogo: el cursor arranca en "No, exit", así que un Enter a secas
 * cerraría Claude Code (ADR 0004).
 */
export const TRUST_ACCEPT_KEYS = ["down", "enter"] as const;

/** Si la pantalla del agente muestra el diálogo de confianza de carpeta. */
export function showsTrustDialog(screen: string): boolean {
  return screen.includes(TRUST_DIALOG_MARKER) && screen.includes("No, exit");
}
