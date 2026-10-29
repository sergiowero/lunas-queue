import { z } from "zod";

// Primitivas compartidas por todos los handoffs. Los límites mantienen el handoff acotado:
// el detalle vive en el repo (diff y commits), no aquí.

export const ShortText = z.string().min(1).max(500);
export const Text = z.string().min(1).max(2000);
export const FilePath = z.string().min(1).max(300);

export const EntityId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, {
  error: "id inválido: se esperan de 1 a 64 caracteres alfanuméricos, guion o guion bajo",
});

export const CriterionId = z.string().regex(/^AC-[1-9]\d*$/, {
  error: "id de criterio inválido: se esperaba AC-<n>, por ejemplo AC-1",
});

export function list<T extends z.ZodType>(item: T, max = 100) {
  return z.array(item).max(max);
}

// Reporta cada repetición de una clave en la ruta del elemento repetido.
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
      ctx.addIssue({ code: "custom", path: path(index), message: `${label} repetido: ${value}` });
    }
    seen.add(value);
  });
}
