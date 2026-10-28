# AGENTS.md — LunasQ

LunasQ (repositorio `lunas-queue`) es una cola de tareas multi‑proyecto que despacha agentes de codificación (Claude Code en v1) a través de herdr: refinan, implementan, verifican y entregan cada tarea como PR, con gates humanos en la spec y en el merge.

Este archivo dice cómo trabajar en el repo. El detalle vive en `docs/`; léelo antes de cambiar algo que toque lo que describe.

## Documentos de referencia

| Archivo | Qué contiene | Cuándo leerlo |
| --- | --- | --- |
| `docs/design.md` | Diseño completo: modelo de dominio, máquina de estados, dispatcher, MCP, verificación, hooks, auditoría | Antes de implementar cualquier unidad; lee las secciones que la unidad toca |
| `docs/units-of-work.md` | Las 30 unidades de trabajo de v1 con alcance, paquete, dependencias, criterio de terminado y estado | Al empezar y al terminar cada unidad |
| `docs/tech-stack.md` | Stack, paquetes del monorepo y sus fronteras, integraciones externas, tooling | Antes de agregar dependencias o crear archivos en un paquete |
| `docs/decisions/` | ADRs cortos con decisiones tomadas durante la implementación | Antes de contradecir algo de los docs anteriores |

El repo es la fuente de verdad. Si una decisión cambia mientras implementas, actualiza el `.md` correspondiente en el mismo PR que el código.

## Cómo se trabaja

1. **Una unidad de trabajo por sesión, branch y worktree.** Branch con el id de la unidad, por ejemplo `uw-07-api-tareas`. No toques el alcance de otras unidades; si hace falta algo de otra, anótalo y sigue.
2. **Verifica dependencias.** Antes de empezar, confirma en `docs/units-of-work.md` que todas las dependencias de la unidad están en Hecho. Si una falta, usa el fake o contrato previsto, o detente y avisa.
3. **Plan primero, sin código.** Propón el plan: secciones de los docs que aplican, tests que escribirás primero, archivos que vas a tocar y riesgos. Espera aprobación humana antes de implementar.
4. **TDD.** Test que falla → implementación mínima → refactor. Cada punto del criterio "Terminado cuando" de la unidad debe tener al menos un test. No debilites ni borres tests existentes sin justificarlo en el PR.
5. **Revisión antes del PR.** Pide un code review a un subagente con contexto limpio que reciba la unidad, el diff y los tests; resuelve los hallazgos válidos.
6. **PR.** Título con el id de la unidad (`UW-07: API de tareas y dependencias`). La descripción incluye el criterio de terminado y cómo se cumple. Al mergear, la unidad pasa a Hecho en `docs/units-of-work.md`.

## Reglas de arquitectura

- **Monolito modular en pnpm workspaces.** Paquetes: `schemas`, `domain`, `db`, `adapters`, `server`, `web`, `cli`, más `assets/skills` y `assets/agents`.
- **Fronteras de dependencia** (detalle en `docs/tech-stack.md`):
  - `domain` solo depende de `schemas` y no conoce base de datos, HTTP, herdr ni `gh`.
  - `adapters` aísla todo lo externo (herdr, `gh`, git, ejecución de procesos) e incluye un fake por cada adapter.
  - `server` compone todo; `web` solo comparte tipos de `schemas`.
  - Nunca importes de un paquete "hacia arriba".
- **Esquemas en un solo lugar.** Entidades, handoffs y eventos se definen con Zod v4 en `packages/schemas`; el JSON Schema se genera desde ahí.
- **La base de datos es la verdad.** herdr es estado efímero; toda lógica que dependa de él debe poder reconciliarse.
- **Idempotencia.** Despachos, worktrees, hooks y escrituras deben poder repetirse sin duplicar efectos.
- **Sin dependencias nuevas sin motivo.** Si agregas una que no está en `docs/tech-stack.md`, justifícala en el PR o en un ADR.

## Stack y comandos

TypeScript estricto en Node.js 26 LTS, pnpm, SQLite (better-sqlite3 + Drizzle), Hono, SDK oficial de MCP, React + Vite, Vitest, Playwright y Biome.

Los comandos quedan disponibles cuando termine UW-00:

| Acción | Comando |
| --- | --- |
| Instalar | `pnpm install` |
| Tests | `pnpm test` |
| Tests de un paquete | `pnpm --filter <paquete> test` |
| Lint y formato | `pnpm lint` / `pnpm format` |
| Tipos | `pnpm typecheck` |
| End-to-end | `pnpm e2e` |

Antes de abrir un PR, `pnpm typecheck`, `pnpm lint` y `pnpm test` deben pasar. Las pruebas contra herdr y `gh` reales corren aparte; ejecútalas cuando cambies un adapter.

## Al terminar una unidad

- [ ] Todos los puntos de "Terminado cuando" cubiertos por tests en verde.
- [ ] Typecheck, lint y tests pasan.
- [ ] Docs actualizados si cambió alguna decisión; ADR en `docs/decisions/` si se tomó una nueva.
- [ ] Estado de la unidad actualizado en `docs/units-of-work.md`.
- [ ] PR con el id de la unidad y el criterio de terminado en la descripción.

## Orden de trabajo

Empieza por **UW-00** (monorepo, tooling y spikes de validación). Cada spike termina con un ADR en `docs/decisions/`:

1. SDK de MCP para TypeScript: v2 estable o línea v1.x.
2. Run token del agente vía `--mcp-config` por Run.
3. better-sqlite3 con prebuilds para Node 26.
4. Versión mínima de herdr y comportamiento de su CLI y socket.

Si un spike cambia el stack, actualiza `docs/tech-stack.md` antes de pasar a la ola 0. Después sigue el orden del backlog: una unidad empieza cuando sus dependencias están en Hecho, y dentro de cada ola se prioriza la unidad de la ruta crítica.
