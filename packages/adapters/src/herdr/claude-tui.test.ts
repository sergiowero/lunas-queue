import { describe, expect, it } from "vitest";
import {
  showsUsageLimit,
  TRUST_DIALOG_MARKER,
  USAGE_LIMIT_PATTERN,
  usageLimitMessage,
} from "./claude-tui.ts";

// Pantallas observadas del CLI (docs/design.md §Señales): el aviso de límite queda en la TUI y
// herdr no lo detecta (su manifiesto no tiene regla para ese UI), así que LunasQ lo reconoce aquí.
const WAIT_SCREEN =
  "Usage limit reached · limit resets 3:45pm\nContinuing automatically at 3:45pm · Esc to cancel";
const WRAP_UP_SCREEN = "trabajo en curso…\n❯ claude\nUsage limit reached · wrapping up";
const AGENTS_OWN_WORK = "❯ corrijo el bug de usage limit que quedó descrito en la tarea";
const TRUST_SCREEN = ` Quick safety check\n ${TRUST_DIALOG_MARKER}`;

const withLimit: readonly string[] = [
  WAIT_SCREEN,
  WRAP_UP_SCREEN,
  "5-hour limit reached · resets 5pm",
  "You've reached your weekly limit. It resets wed at 8:00am",
  "You've hit your usage limit. Your limit will reset at 5pm (Asia/Tokyo)",
  "Now using credits. Your plan limit resets wed at 5:00pm",
  "Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again",
];

const withoutLimit: readonly string[] = [
  AGENTS_OWN_WORK,
  "El plan tiene rate limits pero hoy no se alcanzó ninguno",
  TRUST_SCREEN,
];

describe("showsUsageLimit", () => {
  it("reconoce las pantallas de límite de uso vistas del CLI", () => {
    for (const screen of withLimit) expect(showsUsageLimit(screen)).toBe(true);
  });

  it("no marca el diálogo de confianza ni el trabajo propio del agente", () => {
    for (const screen of withoutLimit) expect(showsUsageLimit(screen)).toBe(false);
  });
});

describe("usageLimitMessage", () => {
  it("devuelve el aviso con su tanda contigua de líneas", () => {
    expect(usageLimitMessage(WAIT_SCREEN)).toBe(
      "Usage limit reached · limit resets 3:45pm · Continuing automatically at 3:45pm · Esc to cancel",
    );
  });

  it("sin aviso devuelve el fallback", () => {
    expect(usageLimitMessage(AGENTS_OWN_WORK)).toBe("usage limit reached");
  });

  it("corta en 500 caracteres", () => {
    const long = `${WRAP_UP_SCREEN}`.padEnd(600, "-");
    expect(usageLimitMessage(long).length).toBeLessThanOrEqual(500);
  });

  it("el patrón es el mismo para detectar la pantalla y sacar el mensaje", () => {
    expect(showsUsageLimit(WRAP_UP_SCREEN)).toBe(USAGE_LIMIT_PATTERN.test(WRAP_UP_SCREEN));
  });
});
