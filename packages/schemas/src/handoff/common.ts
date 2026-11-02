import { z } from "zod";

// Primitives shared by all handoffs. The limits keep the handoff bounded:
// the detail lives in the repo (diff and commits), not here.

export const ShortText = z.string().min(1).max(500);
export const Text = z.string().min(1).max(2000);
export const FilePath = z.string().min(1).max(300);

export const EntityId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, {
  error: "invalid id: 1 to 64 alphanumeric characters, hyphens or underscores expected",
});

export const CriterionId = z.string().regex(/^AC-[1-9]\d*$/, {
  error: "invalid criterion id: AC-<n> expected, for example AC-1",
});

export function list<T extends z.ZodType>(item: T, max = 100) {
  return z.array(item).max(max);
}

// Reports each repetition of a key at the path of the repeated element.
export function checkUnique<T>(
  ctx: z.RefinementCtx,
  items: readonly T[],
  key: (item: T) => string,
  path: (index: number) => PropertyKey[],
  label: string,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const value = key(item);
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", path: path(index), message: `duplicate ${label}: ${value}` });
    }
    seen.add(value);
  });
}
