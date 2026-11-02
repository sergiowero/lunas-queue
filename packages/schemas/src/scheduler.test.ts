import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONCURRENCY, SchedulerConfig } from "./scheduler.ts";

describe("SchedulerConfig", () => {
  it("without values applies the defaults: global limit of 5 and the others optional", () => {
    expect(SchedulerConfig.parse({})).toEqual({
      globalConcurrency: DEFAULT_GLOBAL_CONCURRENCY,
      phaseConcurrency: {},
      agentKindConcurrency: {},
      agingPointsPerHour: 10,
      boostPerDescendant: 25,
      tickIntervalMs: 30_000,
      retryBackoffMs: 30_000,
      maxRetryBackoffMs: 600_000,
    });
    expect(DEFAULT_GLOBAL_CONCURRENCY).toBe(5);
  });

  it("accepts limits per phase and per agent kind", () => {
    const config = SchedulerConfig.parse({
      globalConcurrency: 8,
      phaseConcurrency: { refine: 3, implement: 2 },
      agentKindConcurrency: { claude: 4 },
    });
    expect(config.phaseConcurrency).toEqual({ refine: 3, implement: 2 });
    expect(config.agentKindConcurrency).toEqual({ claude: 4 });
  });

  it.each([
    { globalConcurrency: 0 },
    { globalConcurrency: 1.5 },
    { phaseConcurrency: { refine: 0 } },
    { phaseConcurrency: { review: 1 } },
    { phaseConcurrency: { deliver: 1 } },
    { agentKindConcurrency: { codex: 1 } },
    { agingPointsPerHour: -1 },
    { boostPerDescendant: -1 },
    { tickIntervalMs: 999 },
    { retryBackoffMs: -1 },
    { maxRetryBackoffMs: 1.5 },
    { otro: 1 },
  ])("rejects %j", (input) => {
    expect(SchedulerConfig.safeParse(input).success).toBe(false);
  });
});
