import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_PATTERN,
  agentName,
  answerPrompt,
  DispatchRuleError,
  isAgentName,
  nudgePrompt,
  phasePrompt,
  resolveSession,
  runEnv,
  telemetryRunEnv,
} from "./dispatch.ts";

const TASK = "0f3c9a2e-7b41-4d2a-9e0c-5a6b7c8d9e10";

describe("agentName", () => {
  it("is deterministic and meets the herdr name pattern", () => {
    const name = agentName(TASK, "implement", 3);
    expect(name).toBe("t0f3c9a2e7b41-implement-3");
    expect(agentName(TASK, "implement", 3)).toBe(name);
    expect(name).toMatch(AGENT_NAME_PATTERN);
  });

  it("fits in 32 characters with the longest phase and large ordinals", () => {
    expect(agentName(TASK, "implement", 9999).length).toBeLessThanOrEqual(32);
  });

  it("distinguishes phase and ordinal", () => {
    expect(agentName(TASK, "refine", 1)).not.toBe(agentName(TASK, "verify", 1));
    expect(agentName(TASK, "refine", 1)).not.toBe(agentName(TASK, "refine", 2));
  });

  it("rejects non-positive ordinals and names that do not fit", () => {
    expect(() => agentName(TASK, "refine", 0)).toThrow(DispatchRuleError);
    expect(() => agentName(TASK, "implement", 10 ** 12)).toThrow(DispatchRuleError);
    expect(() => agentName("x!", "refine", 1)).toThrow(DispatchRuleError);
  });
});

describe("runEnv", () => {
  it("carries token, task, Run and phase with the tech-stack names", () => {
    expect(runEnv({ runToken: "tok", taskId: TASK, runId: "run-1", phase: "verify" })).toEqual({
      LUNASQ_RUN_TOKEN: "tok",
      LUNASQ_TASK_ID: TASK,
      LUNASQ_RUN_ID: "run-1",
      LUNASQ_PHASE: "verify",
    });
  });
});

describe("telemetryRunEnv", () => {
  it("sets task, Run and phase as resource attributes and the run token as the OTLP header", () => {
    expect(
      telemetryRunEnv({ runToken: "tok", taskId: TASK, runId: "run-1", phase: "verify" }),
    ).toEqual({
      OTEL_RESOURCE_ATTRIBUTES: `lunasq.task_id=${TASK},lunasq.run_id=run-1,lunasq.phase=verify`,
      OTEL_EXPORTER_OTLP_HEADERS: "X-LunasQ-Run-Token=tok",
    });
  });
});

describe("phasePrompt", () => {
  it("invokes the skill of the phase with the task id and sends context through MCP", () => {
    const prompt = phasePrompt("refine", TASK);
    expect(prompt).toContain("refine-task");
    expect(prompt).toContain(TASK);
    expect(prompt).toContain("get_task_context");
    expect(phasePrompt("implement", TASK)).toContain("implement-task");
    expect(phasePrompt("verify", TASK)).toContain("verify-task");
  });

  it("is a single line: herdr sends it as a single prompt", () => {
    expect(phasePrompt("verify", TASK)).not.toContain("\n");
  });
});

describe("isAgentName", () => {
  it("recognizes the names that agentName builds and nothing else", () => {
    expect(isAgentName(agentName(TASK, "verify", 3))).toBe(true);
    expect(isAgentName("t0f3c9a2e7b41-deliver-1")).toBe(false);
    expect(isAgentName("t0f3c9a2e7b41-refine-0")).toBe(false);
    expect(isAgentName("mi-agente")).toBe(false);
    expect(isAgentName(`x${agentName(TASK, "refine", 1)}`)).toBe(false);
  });
});

describe("nudgePrompt", () => {
  it("reminds of the open phase and the exit tools, on a single line", () => {
    const prompt = nudgePrompt("implement", TASK);
    expect(prompt).toContain(TASK);
    expect(prompt).toContain("implement-task");
    expect(prompt).toContain("report_failure");
    expect(prompt).toContain("ask_human");
    expect(prompt).not.toContain("\n");
  });
});

describe("answerPrompt", () => {
  it("delivers question and answer to the agent on a single line", () => {
    const prompt = answerPrompt("implement", TASK, {
      question: "Do I drop the table?",
      answer: "Yes,\ndrop it\n\nand migrate the data",
    });
    expect(prompt).toContain(TASK);
    expect(prompt).toContain("Do I drop the table?");
    expect(prompt).toContain("Yes, drop it and migrate the data");
    expect(prompt).toContain("implement-task");
    expect(prompt).not.toContain("\n");
  });
});

describe("resolveSession", () => {
  const name = "t0f3c9a2e7b41-refine-1";

  it("prefers the native session id", () => {
    expect(resolveSession({ nativeId: "n-1", herdr: { value: "h-1" }, agentName: name })).toEqual({
      value: "n-1",
      source: "native",
    });
  });

  it("if there is no native one it uses the one herdr reports", () => {
    expect(resolveSession({ herdr: { value: "h-1" }, agentName: name })).toEqual({
      value: "h-1",
      source: "herdr",
    });
  });

  it("as a fallback it uses the deterministic name of the agent", () => {
    expect(resolveSession({ nativeId: null, agentName: name })).toEqual({
      value: name,
      source: "name",
    });
  });
});
