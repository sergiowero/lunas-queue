import type { z } from "zod";

export interface HandoffError {
  path: string;
  message: string;
}

export const ROOT_PATH = "(raíz)";

// ["body", "criteria", 2, "id"] → "body.criteria[2].id"
export function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return ROOT_PATH;
  return path
    .map((key, i) => (typeof key === "number" ? `[${key}]` : `${i === 0 ? "" : "."}${String(key)}`))
    .join("");
}

export function toHandoffErrors(error: z.ZodError): HandoffError[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));
}
