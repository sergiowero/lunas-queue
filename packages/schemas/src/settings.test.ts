import { describe, expect, it } from "vitest";
import { AgentProviderSettings, SETTINGS_UPDATED, SettingsUpdatedPayload } from "./index.ts";

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

describe("evento settings.updated", () => {
  it("lleva la configuración guardada", () => {
    expect(SETTINGS_UPDATED).toBe("settings.updated");
    expect(SettingsUpdatedPayload.parse({ providers: { claude: false, copilot: true } })).toEqual({
      providers: { claude: false, copilot: true },
    });
    expect(() => SettingsUpdatedPayload.parse({ providers: { claude: false } })).not.toThrow();
    expect(() => SettingsUpdatedPayload.parse({})).toThrow();
  });
});
