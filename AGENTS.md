# AGENTS.md — LunasQ

LunasQ (repositorio `lunas-queue`) es una cola de tareas multi‑proyecto que despacha agentes de codificación (Claude Code en v1) a través de herdr: refinan, implementan, verifican y entregan cada tarea como PR, con gates humanos en la spec y en el merge.

Este archivo dice cómo trabajar en el repo. El detalle vive en `docs/`; léelo antes de cambiar algo que toque lo que describe.

## Documentos de referencia

| Archivo | Qué contiene | Cuándo leerlo |
| --- | --- | --- |
| `docs/design.md` | Diseño completo: modelo de dominio, máquina de estados, dispatcher, MCP, verificación, hooks, auditoría | Antes de cambiar algo que toque lo que describe |
| `docs/tech-stack.md` | Stack, paquetes del monorepo y sus fronteras, integraciones externas, tooling | Antes de agregar dependencias o crear archivos en un paquete |
| `docs/decisions/` | ADRs cortos con decisiones tomadas durante la implementación | Antes de contradecir algo de los docs anteriores |
| `docs/archive/` | Backlog histórico de unidades de trabajo (ya no se usa) | Solo como referencia histórica |

El repo es la fuente de verdad. Si una decisión cambia mientras implementas, actualiza el `.md` correspondiente en el mismo PR que el código. Un ADR nuevo va en `docs/decisions/<tema>.md`.

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

| Acción | Comando |
| --- | --- |
| Instalar | `pnpm install` |
| Tests | `pnpm test` |
| Tests de un paquete | `pnpm --filter <paquete> test` |
| Lint y formato | `pnpm lint` / `pnpm format` |
| Tipos | `pnpm typecheck` |
| End-to-end | `pnpm e2e` |

Antes de abrir un PR, `pnpm typecheck`, `pnpm lint` y `pnpm test` deben pasar. Las pruebas contra herdr y `gh` reales corren aparte; ejecútalas cuando cambies un adapter.
