<div align="center">

# LunasQ

**Una cola de tareas multi‑proyecto que despacha agentes de codificación: tú defines el intent, ellos lo refinan, implementan, verifican y lo entregan como PR.**

[![CI](https://github.com/sergiowero/lunas-queue/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2026-5FA04E?logo=node.js&logoColor=white)](.node-version)

</div>

LunasQ es una *AI software factory* **lights‑on**: agentes especializados trabajan solos y tú conservas dos gates humanos, **aprobar la spec** y **mergear cada PR**. Corre en tu máquina, en un solo proceso local, y usa [herdr](https://herdr.dev) para lanzar y observar a los agentes.

## Tabla de contenidos

- [Qué es LunasQ](#qué-es-lunasq)
- [Características](#características)
- [Arquitectura](#arquitectura)
- [Requisitos](#requisitos)
- [Inicio rápido](#inicio-rápido)
- [Uso](#uso)
- [Configuración](#configuración)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Desarrollo](#desarrollo)
- [Documentación](#documentación)
- [Contribución](#contribución)
- [Estado del proyecto y alcance de v1](#estado-del-proyecto-y-alcance-de-v1)

## Qué es LunasQ

Un humano escribe el *intent* de una tarea («quiero un README profesional»). LunasQ lo convierte en un PR listo para revisar sin que tengas que sentarte con el agente:

```text
intent → refinamiento → gate de spec (humano) → implementación → verificación → PR → merge (humano)
```

1. **Refinamiento.** Un agente lee el repo, aclara el intent (si duda, te pregunta en la Bandeja) y escribe una *spec*: modelo de dominio, requerimientos, criterios de aceptación Given / When / Then y una task list.
2. **Gate de spec.** Tú la apruebas o pides cambios. Sin aprobación no se escribe código.
3. **Implementación.** Otro agente trabaja con TDD en un worktree propio de la tarea, marca la task list y declara el fin con un handoff estructurado. LunasQ corre el comando de tests del proyecto como gate.
4. **Verificación.** Una sesión independiente actúa como *approver*: lanza los revisores que aplican (código, seguridad, UI, UX), verifica cada criterio y emite `pass` o `reject` con lo que hay que corregir. Un `reject` regresa la tarea a implementación (máximo 3 iteraciones; después pasa a *Needs human*).
5. **Entrega.** LunasQ hace rebase sobre la rama base, push y abre el PR con evidencia y una etiqueta de riesgo.
6. **Merge.** Lo haces tú. LunasQ detecta el merge y libera a las tareas que dependían de esta.

Sirve para encolar muchas tareas de varios repos, dejarlas avanzar en paralelo y dedicar tu atención solo a decidir: *¿esta spec es lo que quiero?* y *¿este PR se mergea?*

## Características

- **Multi‑proyecto.** Cada proyecto es un repo con su rama base, comando de tests, perfil de agente por fase y límites de concurrencia.
- **Dependencias como DAG.** Una tarea espera a que los PRs de sus dependencias estén mergeados; se rechazan los ciclos. El scheduler ordena por prioridad, *aging* y boost por desbloqueo.
- **Un worktree por tarea.** Cada tarea tiene su propio branch (`lunasq/<id>`) y checkout en todas las fases, así varias tareas del mismo repo corren en paralelo sin pisarse.
- **MCP como canal de salida.** Los agentes reportan spec, checklist y veredictos con tools del LunasQ MCP, validadas con un run token; no se infiere nada leyendo la terminal.
- **Verificación con revisores.** El approver elige entre cuatro subagentes de solo lectura (código, seguridad, UI, UX) y justifica los que omite.
- **Hooks por fase.** Scripts del proyecto en `lunasq/hooks/` que LunasQ ejecuta antes y después de cada fase (bump de versión, deploys de prueba, avisos).
- **Bandeja de preguntas.** Los agentes preguntan de forma asíncrona con `ask_human`; tú respondes en la UI y el agente retoma con tu respuesta.
- **Proveedores Claude Code y Copilot CLI.** Se elige el agente por fase y proyecto, con fallback al otro si uno no arranca.
- **Idempotente y reconciliable.** La base de datos es la fuente de verdad; herdr es estado efímero que un loop de reconciliación compara y corrige.
- **Trazabilidad.** Event log append‑only, trailers `LunasQ-Task` y `LunasQ-Run` en cada commit y archivo de evidencia en `lunasq/tasks/<id>.md`.
- **Consumo visible.** Tokens y costo por Run vía telemetría OTLP local.

## Arquitectura

Cuatro piezas propias (front end, backend, scheduler, dispatcher) y un MCP propio. herdr y GitHub (por el CLI `gh`) son dependencias externas detrás de adapters; engram (memoria del proyecto) es opcional y solo lo usan los agentes.

![Arquitectura: control plane, datos, herdr como execution plane, usage collector, GitHub y engram opcional](docs/images/arquitectura.png)

Todo LunasQ es un único proceso Node.js en `localhost`: recibe la UI por HTTP y SSE, a los agentes por MCP y la telemetría por OTLP.

![Topología en runtime: un proceso lunasq en Node.js con API, MCP, usage collector, scheduler, dispatcher y adapters](docs/images/topologia-runtime.png)

Cada tarea recorre una máquina de estados con un único gate de aprobación y un loop de calidad entre *In progress* y *Verification*. Cada estado con agente tiene un sub‑estado (`queued`, `running`, `waiting_human`).

![Máquina de estados: Draft, Refined, In progress, Verification y Completed, con los loops de cambios pedidos y rework](docs/images/maquina-de-estados.png)

Principios: la base de datos es la verdad, reconciliación en lugar de disparo único, salidas estructuradas por MCP, aislamiento por tarea, verificador independiente e idempotencia. Detalle completo en [docs/design.md](docs/design.md).

## Requisitos

| Herramienta | Versión | Para qué |
| --- | --- | --- |
| Node.js 26 | Fijado en [.node-version](.node-version) | Runtime |
| pnpm 11 | Fijado en `packageManager` de `package.json` | Gestor del monorepo |
| [herdr](https://herdr.dev) | ≥ 0.9.5, con su servidor corriendo | Ejecuta y observa a los agentes |
| [Claude Code](https://claude.com/claude-code) | ≥ 2.1.312 | Agente por defecto |
| `gh` | Autenticado (`gh auth status`) | PRs y detección de merges |
| GitHub Copilot CLI | ≥ 1.0.0 (opcional) | Agente alternativo |

`pnpm lunasq doctor` comprueba todo esto y te dice qué falta.

## Inicio rápido

```bash
# 1. Instalar dependencias
pnpm install

# 2. Verificar la máquina e instalar skills, revisores y configuración MCP
pnpm lunasq install            # opcional: --port <n> para cambiar el puerto

# 3. Comprobar que todo esté en verde
pnpm lunasq doctor

# 4. Arrancar LunasQ en localhost (puerto 7360 por defecto)
pnpm lunasq start
```

`install` no instala nada si faltan requisitos y lista los que faltan. `start` imprime la URL de la UI.

### Front end en desarrollo

Para trabajar en la UI, levanta Vite apuntando al servidor de LunasQ (el proxy usa por defecto el puerto 4310, así que indica el 7360):

```bash
LUNASQ_API=http://localhost:7360 pnpm --filter @lunasq/web dev
```

## Uso

1. **Crea un proyecto** con `POST /api/projects`: repo (`owner/nombre`), rama base, ruta local y comando de tests. Opcionalmente, perfil de agente por fase, límites de concurrencia y script de bootstrap del worktree.
2. **Crea tareas** desde **Nueva tarea**: intent, prioridad (entero, mayor = más prioritaria) y dependencias.
3. **Responde preguntas** en la **Bandeja** cuando el refinador tenga dudas; el agente retoma con tu respuesta.
4. **Revisa la spec.** Ábrela desde «Specs por aprobar» de la Bandeja y **aprueba** o usa **Pedir cambios** con comentarios; cada ronda crea una versión nueva.
5. **Sigue el avance** en el tablero: checklist, Runs, consumo y eventos de cada tarea.
6. **Mergea el PR** en GitHub cuando estés conforme. LunasQ lo detecta por polling y libera a las tareas dependientes.

Si un agente se bloquea, agota reintentos o la verificación agota sus iteraciones, la tarea pasa a *Needs human*: revisa el motivo y reanúdala o cancélala. La guía completa, con un guion para probarlo en un proyecto real, está en [docs/pilot.md](docs/pilot.md).

## Configuración

LunasQ guarda todo lo suyo en `~/.lunasq/` (cámbialo con `LUNASQ_HOME`):

| Archivo | Contenido |
| --- | --- |
| `config.json` | Puerto (`port`, por defecto 7360) y si se pasa telemetría a los panes (`telemetry`) |
| `mcp.json` | Configuración estable del LunasQ MCP para Claude Code |
| `lunasq.db` | Base SQLite (modo WAL) con tareas, specs, Runs y Event log |
| `claude-settings.json` | Settings con los hooks de los subagentes revisores |

| Variable | Efecto |
| --- | --- |
| `LUNASQ_HOME` | Directorio de LunasQ en lugar de `~/.lunasq` |
| `CLAUDE_CONFIG_DIR` | Directorio de Claude Code donde `install` copia skills y revisores (por defecto `~/.claude`) |
| `LUNASQ_API` | Destino del proxy `/api` del front end en desarrollo |

**Hooks por proyecto.** Cada repo gestionado puede definir scripts ejecutables en `lunasq/hooks/<punto>/` (por ejemplo `before_delivery/10-bump-version`), ordenados alfabéticamente, con timeout y política `block` o `warn` en `lunasq/hooks/config`. LunasQ los lee siempre de la rama base, nunca del branch de la tarea. Puntos disponibles: `before_` y `after_` de `refinement`, `implementation`, `verification` y `delivery`, además de `after_merge` y `on_failure`. Detalle en [docs/design.md](docs/design.md) y [ADR uw-10-hooks](docs/decisions/uw-10-hooks.md).

## Estructura del repositorio

Monolito modular con pnpm workspaces. La regla: `domain` solo depende de `schemas` y nunca se importa «hacia arriba».

| Ruta | Contenido |
| --- | --- |
| `packages/schemas` | Esquemas Zod v4 compartidos (entidades, handoffs, eventos) y generación de JSON Schema |
| `packages/domain` | Máquina de estados, guards y reglas del scheduler en TypeScript puro |
| `packages/db` | Esquema Drizzle, migraciones, repositorios y outbox sobre SQLite |
| `packages/adapters` | Todo lo externo (herdr, `gh`, git, procesos, hooks), cada uno con su fake |
| `packages/server` | API Hono, SSE, LunasQ MCP, usage collector, scheduler, dispatcher y reconciliación |
| `packages/web` | Front end React + Vite que consume los tipos de `schemas` |
| `packages/cli` | Binario `lunasq`: `install`, `doctor` y `start` |
| `packages/e2e` | Piloto end‑to‑end con Playwright contra el runtime completo con herdr y GitHub falsos |
| `assets/skills` | Skills de fase: `refine-task`, `implement-task` y `verify-task` |
| `assets/agents` | Definiciones de los cuatro subagentes revisores |
| `tooling/` | Pruebas del repo: fronteras de dependencia y este README |
| `docs/` | Diseño, stack, ADRs e imágenes |

## Desarrollo

```bash
pnpm install
pnpm test        # Vitest en todos los proyectos
pnpm lint        # Biome (lint y formato)
pnpm format      # aplica el formato
pnpm typecheck   # tsc -b en modo estricto
pnpm e2e         # compila el front end y corre Playwright
```

Pruebas que usan herramientas reales (gastan tokens o necesitan tu máquina; corren aparte de la suite):

```bash
pnpm --filter @lunasq/adapters test:herdr   # contrato del adapter de herdr
pnpm --filter @lunasq/adapters test:gh      # contrato del adapter de gh
pnpm --filter @lunasq/server test:herdr     # dispatcher contra herdr real
pnpm --filter @lunasq/server test:claude    # revisores con Claude Code real
pnpm --filter @lunasq/server test:usage     # usage collector
pnpm --filter @lunasq/server test:skills    # skills con Claude Code real
```

Las reglas de trabajo en el repo (arquitectura, fronteras, idempotencia) están en [AGENTS.md](AGENTS.md).

## Documentación

| Documento | Qué contiene |
| --- | --- |
| [docs/design.md](docs/design.md) | Diseño completo: dominio, máquina de estados, scheduler, dispatcher, hooks, MCP, verificación y auditoría |
| [docs/tech-stack.md](docs/tech-stack.md) | Stack, paquetes y fronteras, integraciones externas y tooling |
| [docs/decisions/](docs/decisions/) | ADRs con las decisiones tomadas durante la implementación |
| [docs/pilot.md](docs/pilot.md) | Guion para probar LunasQ de punta a punta en un proyecto real |

## Contribución

1. Crea un branch desde `main` y haz commits pequeños, con el test junto o antes del código que cubre.
2. Antes de abrir el PR, ejecuta `pnpm typecheck`, `pnpm lint` y `pnpm test`; si cambias un adapter, corre también sus pruebas reales.
3. Si una decisión cambia mientras implementas, actualiza el `.md` correspondiente en el mismo PR; una decisión nueva va en un ADR en `docs/decisions/`.
4. No agregues dependencias que no estén en [docs/tech-stack.md](docs/tech-stack.md) sin justificarlas en el PR o en un ADR.
5. Abre el PR contra `main`. [CI](.github/workflows/ci.yml) corre dos checks: `check` (typecheck, lint y tests) y `e2e` (Playwright). Ambos deben pasar y el merge es siempre humano.

## Estado del proyecto y alcance de v1

LunasQ está en desarrollo activo. v1 cubre el flujo completo descrito arriba, con Claude Code y GitHub Copilot CLI como agentes, una sola máquina y un solo usuario.

**Fuera de alcance en v1:** merge automático, commits directos a `main`, despliegue a producción hecho por LunasQ (se puede configurar con hooks del proyecto), carriles por tamaño de tarea, pruebas de aceptación ocultas al builder, multiusuario con roles e intake automático desde issues de GitHub (planeado para v2). El roadmap completo está en [docs/design.md](docs/design.md).
