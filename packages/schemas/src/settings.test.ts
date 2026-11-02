import { describe, expect, it } from "vitest";
import {
  AgentProviderPatch,
  AgentProviderSettings,
  ConcurrencySettings,
  SETTINGS_UPDATED,
  SettingsUpdatedPayload,
} from "./index.ts";

describe("AgentProviderSettings", () => {
  it("sin configuración guardada, claude y copilot quedan habilitados", () => {
    expect(AgentProviderSettings.parse({})).toEqual({ claude: true, copilot: true });
  });

  it("respeta el booleano de cada proveedor", () => {
    expect(AgentProviderSettings.parse({ claude: false })).toEqual({
      claude: false,
      copilot: true,
    });
    expect(AgentProviderSettings.parse({ claude: false, copilot: false })).toEqual({
      claude: false,
      copilot: false,
    });
  });

  it("rechaza un kind desconocido, un valor no booleano y campos extra", () => {
    expect(() => AgentProviderSettings.parse({ gemini: true })).toThrow();
    expect(() => AgentProviderSettings.parse({ claude: "no" })).toThrow();
    expect(() => AgentProviderSettings.parse({ claude: null })).toThrow();
  });
});

describe("AgentProviderPatch", () => {
  it("admite solo los proveedores que cambian y rechaza kinds desconocidos o no booleanos", () => {
    expect(AgentProviderPatch.parse({ claude: false })).toEqual({ claude: false });
    expect(AgentProviderPatch.parse({})).toEqual({});
    expect(() => AgentProviderPatch.parse({ gemini: true })).toThrow();
    expect(() => AgentProviderPatch.parse({ claude: "no" })).toThrow();
    expect(() => AgentProviderPatch.parse({ claude: null })).toThrow();
  });
});

describe("ConcurrencySettings", () => {
  it("acepta enteros de 1 a 50", () => {
    expect(ConcurrencySettings.parse({ globalConcurrency: 1 })).toEqual({ globalConcurrency: 1 });
    expect(ConcurrencySettings.parse({ globalConcurrency: 50 })).toEqual({ globalConcurrency: 50 });
  });

  it.each([
    ["cero", { globalConcurrency: 0 }],
    ["más de 50", { globalConcurrency: 51 }],
    ["un decimal", { globalConcurrency: 1.5 }],
    ["un texto", { globalConcurrency: "4" }],
    ["un campo desconocido", { globalConcurrency: 2, otro: 1 }],
    ["un cuerpo vacío", {}],
  ])("rechaza %s", (_name, input) => {
    expect(() => ConcurrencySettings.parse(input)).toThrow();
  });
});

describe("evento settings.updated", () => {
  it("lleva la configuración guardada", () => {
    expect(SETTINGS_UPDATED).toBe("settings.updated");
    expect(SettingsUpdatedPayload.parse({ providers: { claude: false, copilot: true } })).toEqual({
      providers: { claude: false, copilot: true },
    });
    expect(() => SettingsUpdatedPayload.parse({ providers: { claude: false } })).not.toThrow();
    expect(() => SettingsUpdatedPayload.parse({})).toThrow();
  });

  it("un evento antiguo con solo providers sigue siendo válido", () => {
    expect(SettingsUpdatedPayload.parse({ providers: { claude: true, copilot: true } })).toEqual({
      providers: { claude: true, copilot: true },
    });
  });

  it("admite globalConcurrency, solo o junto con providers, y exige al menos uno", () => {
    expect(SettingsUpdatedPayload.parse({ globalConcurrency: 3 })).toEqual({
      globalConcurrency: 3,
    });
    expect(
      SettingsUpdatedPayload.parse({
        providers: { claude: true, copilot: false },
        globalConcurrency: 3,
      }),
    ).toEqual({ providers: { claude: true, copilot: false }, globalConcurrency: 3 });
    expect(() => SettingsUpdatedPayload.parse({ globalConcurrency: 0 })).toThrow();
    expect(() => SettingsUpdatedPayload.parse({ globalConcurrency: 3, otro: 1 })).toThrow();
  });
});
