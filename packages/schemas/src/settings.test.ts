import { describe, expect, it } from "vitest";
import {
  AgentProviderPatch,
  AgentProviderSettings,
  ConcurrencySettings,
  SETTINGS_UPDATED,
  SettingsUpdatedPayload,
  VerificationSettings,
} from "./index.ts";

describe("AgentProviderSettings", () => {
  it("without saved configuration, all providers are enabled", () => {
    expect(AgentProviderSettings.parse({})).toEqual({ claude: true, copilot: true, codex: true });
  });

  it("respects the boolean of each provider", () => {
    expect(AgentProviderSettings.parse({ claude: false })).toEqual({
      claude: false,
      copilot: true,
      codex: true,
    });
    expect(AgentProviderSettings.parse({ claude: false, copilot: false })).toEqual({
      claude: false,
      copilot: false,
      codex: true,
    });
  });

  it("rejects an unknown kind, a non-boolean value and extra fields", () => {
    expect(() => AgentProviderSettings.parse({ gemini: true })).toThrow();
    expect(() => AgentProviderSettings.parse({ claude: "no" })).toThrow();
    expect(() => AgentProviderSettings.parse({ claude: null })).toThrow();
  });
});

describe("AgentProviderPatch", () => {
  it("admits only the providers that change and rejects unknown or non-boolean kinds", () => {
    expect(AgentProviderPatch.parse({ claude: false })).toEqual({ claude: false });
    expect(AgentProviderPatch.parse({})).toEqual({});
    expect(() => AgentProviderPatch.parse({ gemini: true })).toThrow();
    expect(() => AgentProviderPatch.parse({ claude: "no" })).toThrow();
    expect(() => AgentProviderPatch.parse({ claude: null })).toThrow();
  });
});

describe("ConcurrencySettings", () => {
  it("accepts integers from 1 to 50", () => {
    expect(ConcurrencySettings.parse({ globalConcurrency: 1 })).toEqual({ globalConcurrency: 1 });
    expect(ConcurrencySettings.parse({ globalConcurrency: 50 })).toEqual({ globalConcurrency: 50 });
  });

  it.each([
    ["cero", { globalConcurrency: 0 }],
    ["more than 50", { globalConcurrency: 51 }],
    ["un decimal", { globalConcurrency: 1.5 }],
    ["a text", { globalConcurrency: "4" }],
    ["an unknown field", { globalConcurrency: 2, otro: 1 }],
    ["an empty body", {}],
  ])("rejects %s", (_name, input) => {
    expect(() => ConcurrencySettings.parse(input)).toThrow();
  });
});

describe("VerificationSettings", () => {
  it("accepts integers from 1 to 20", () => {
    expect(VerificationSettings.parse({ maxVerificationIterations: 1 })).toEqual({
      maxVerificationIterations: 1,
    });
    expect(VerificationSettings.parse({ maxVerificationIterations: 20 })).toEqual({
      maxVerificationIterations: 20,
    });
  });

  it.each([
    ["zero", { maxVerificationIterations: 0 }],
    ["more than 20", { maxVerificationIterations: 21 }],
    ["a decimal", { maxVerificationIterations: 2.5 }],
    ["a text", { maxVerificationIterations: "4" }],
    ["an unknown field", { maxVerificationIterations: 2, other: 1 }],
    ["an empty body", {}],
  ])("rejects %s", (_name, input) => {
    expect(() => VerificationSettings.parse(input)).toThrow();
  });
});

describe("settings.updated event", () => {
  it("carries the saved configuration", () => {
    expect(SETTINGS_UPDATED).toBe("settings.updated");
    expect(
      SettingsUpdatedPayload.parse({ providers: { claude: false, copilot: true, codex: true } }),
    ).toEqual({
      providers: { claude: false, copilot: true, codex: true },
    });
    expect(() => SettingsUpdatedPayload.parse({ providers: { claude: false } })).not.toThrow();
    expect(() => SettingsUpdatedPayload.parse({})).toThrow();
  });

  it("an old event with only providers is still valid", () => {
    expect(
      SettingsUpdatedPayload.parse({ providers: { claude: true, copilot: true, codex: true } }),
    ).toEqual({
      providers: { claude: true, copilot: true, codex: true },
    });
  });

  it("admits globalConcurrency, alone or together with providers, and requires at least one", () => {
    expect(SettingsUpdatedPayload.parse({ globalConcurrency: 3 })).toEqual({
      globalConcurrency: 3,
    });
    expect(
      SettingsUpdatedPayload.parse({
        providers: { claude: true, copilot: false },
        globalConcurrency: 3,
      }),
    ).toEqual({
      providers: { claude: true, copilot: false, codex: true },
      globalConcurrency: 3,
    });
    expect(() => SettingsUpdatedPayload.parse({ globalConcurrency: 0 })).toThrow();
    expect(() => SettingsUpdatedPayload.parse({ globalConcurrency: 3, otro: 1 })).toThrow();
  });

  it("admits maxVerificationIterations alone and keeps old payloads valid", () => {
    expect(SettingsUpdatedPayload.parse({ maxVerificationIterations: 8 })).toEqual({
      maxVerificationIterations: 8,
    });
    expect(SettingsUpdatedPayload.parse({ globalConcurrency: 3 })).toEqual({
      globalConcurrency: 3,
    });
    expect(() => SettingsUpdatedPayload.parse({ maxVerificationIterations: 21 })).toThrow();
    expect(() => SettingsUpdatedPayload.parse({})).toThrow();
  });
});
