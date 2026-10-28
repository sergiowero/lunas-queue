# 0005 — Handoff v1: Zod como validador, JSON Schema como contrato estructural

- Estado: aceptada
- Fecha: 2026-10-28
- Unidad: UW-03 · Código: `packages/schemas/src/handoff/`, ejemplos en `packages/schemas/examples/handoff/v1/`, JSON Schema en `packages/schemas/json-schema/v1/`

## Contexto

`docs/design.md` (Formato del handoff) pide un sobre común más un cuerpo por fase, validado contra un JSON Schema versionado y generado desde Zod v4. Varias reglas del handoff cruzan campos (ids únicos, un pass sin criterios en fail, un reject con must‑fix, tamaño total acotado), y `z.toJSONSchema` no exporta los `superRefine`.

## Decisión

- **Zod es el validador.** `parseHandoff(input)` de `@lunasq/schemas` es la única puerta: lee `schemaVersion`, rechaza versiones no registradas, mide el tamaño (≤ 32 KB en UTF‑8) y valida con el esquema de esa versión. El LunasQ MCP (UW-15) lo usa directo.
- **El JSON Schema es contrato estructural.** `pnpm --filter @lunasq/schemas generate` escribe `handoff.json` (unión por `phase`) y un archivo por fase; cada uno declara draft 2020‑12, un `$id` `urn:lunasq:handoff:v1:<nombre>` y en `description` que las reglas entre campos solo las aplica Zod. Un test de drift falla si el archivo versionado no coincide con Zod.
- **Errores** como `{ path, message }[]`, con rutas tipo `body.criteria[2].id` (`(raíz)` para el objeto completo) y mensajes en español: los de Zod con su locale `es` pasado por llamada (sin configuración global) y los de reglas propias escritos a mano.
- **Formato:** objetos estrictos (un campo desconocido es error), identificadores en camelCase inglés, `result` `completed | partial` (un fallo va por `report_failure`, sin handoff), criterios `AC-<n>` con `given / when / outcome` (`then` se evita porque vuelve "thenable" al objeto), tareas `T-<n>`, `riskLabel` `low | medium | high` (bajo / medio / alto en UI y PR), los 4 revisores `lunasq-*-reviewer` obligatorios con `ran` + hallazgos o `skipped` + justificación.
- **Versiones:** `handoffSchemas` registra cada versión; un cambio incompatible agrega `2` sin borrar `1`, y los ejemplos y el JSON Schema viven por versión.
- **Fronteras:** los tests y el generador de `schemas` usan `node:fs`; Biome los exime de la regla de imports, y en `src` prohíbe además los globals `process`, `Buffer` y `require`.

## Consecuencias

- Un consumidor que valide solo con el JSON Schema acepta handoffs que Zod rechaza; LunasQ nunca debe validar así.
- UW-15 valida los criterios del handoff contra la spec aprobada (p. ej. que `criterionTests` cubra todos sus criterios): el esquema no conoce la spec.
- UW-18 y `assets/agents` deben usar los mismos nombres de revisor.
- El handoff de reintento (Questions, checklist, resumen del Run fallido) lo arma LunasQ, no un agente; no tiene esquema aquí.
