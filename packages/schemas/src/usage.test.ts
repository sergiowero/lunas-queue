import { describe, expect, it } from "vitest";
import { OtlpLogsRequest } from "./usage.ts";

describe("OtlpLogsRequest", () => {
  it("tolerates fields it does not read and fills in absent lists", () => {
    const req = OtlpLogsRequest.parse({
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
          },
          scopeLogs: [
            {
              scope: { name: "com.anthropic.claude_code.events" },
              logRecords: [
                { timeUnixNano: "1", attributes: [{ key: "n", value: { intValue: "2" } }] },
              ],
            },
          ],
        },
        {},
      ],
    });
    expect(req.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes).toHaveLength(1);
    expect(req.resourceLogs[1]?.scopeLogs).toEqual([]);
    expect(OtlpLogsRequest.parse({}).resourceLogs).toEqual([]);
  });

  it("rejects a body that is not OTLP", () => {
    expect(() => OtlpLogsRequest.parse({ resourceLogs: "x" })).toThrow();
  });
});
