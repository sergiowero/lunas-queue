# UW-18 — Skills de fase

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-18 · Código: `assets/skills/{refine-task,implement-task,verify-task}/SKILL.md`, `packages/server/src/skills/`, `packages/server/src/mcp/ports.ts`, `packages/server/src/test-helpers/real-claude.ts`

## Contexto

`docs/design.md` (§MCPs y skills) pide una skill por fase que describa el *cómo*, con el LunasQ MCP como único canal de salida, e instrucciones best effort para engram (§Brain). El dispatcher (UW-16) manda un prompt corto que nombra la skill (`phasePrompt`: `refine-task`, `implement-task`, `verify-task`). ADR uw-15-mcp-tools deja a UW-18 documentar los códigos de error, que un rechazo se corrige en el mismo Run y que `invalid_run_token` después de una tool de salida significa que la fase ya terminó. ADR uw-19-revisores pide que `verify-task` lance los revisores por nombre y sin segundo plano. El backlog listaba además `deliver-task`, con salida "PR url vía MCP".

## Decisión

- **Sin `deliver-task`.** Las decisiones posteriores al diseño dejaron la entrega sin agente. `verdict_pass` lo emite solo el sistema después de crear el PR (ADR 0007). La entrega corre dentro del Run del verificador y no se agenda (ADR 0014). El PR lo crea UW-26 con `gh` (ADR uw-14-adapter-github). No hay tool MCP de entrega, ni handoff de entrega, ni fase `deliver` en `PHASE_SKILL`. Una skill que nadie despacha no se escribe. Si en el futuro un agente resuelve conflictos de rebase, eso es implementación: `delivery_conflict` regresa la tarea a in progress. El perfil `deliver` de ADR 0008 se queda sin uso por ahora.
- **Formato.** Una carpeta por skill con `SKILL.md`: frontmatter `name` (el de la carpeta, el que cita el prompt de fase) y `description`. `lunasq install` (UW-28) copia las carpetas a `~/.claude/skills/`.
- **Contenido común.** Cada skill tiene estas secciones:
  - reglas de la fase;
  - pasos, empezando por `get_task_context` y terminando con su tool de salida;
  - qué campos del `TaskContext` usar;
  - un handoff de ejemplo válido en el primer bloque `json`;
  - una tabla de códigos de error con qué hacer en cada uno;
  - `ask_human` (registra la pregunta y el agente termina su turno) y `report_failure`;
  - la sección de engram con los momentos de §Brain, condicionada a que el MCP esté disponible.

  Las skills no se comparten texto entre sí: cada una se lee sola.
- **Por fase.**
  - `refine-task` no escribe código y modela con DDD. Los criterios se escriben Given / When / Then en `given / when / outcome`. Una nueva ronda parte de `changesRequested`.
  - `implement-task` aplica TDD por criterio y marca `update_checklist` por tarea. Entrega con el worktree limpio y los commits `<base>..HEAD`; un rework corrige los `mustFix` del último veredicto.
  - `verify-task` lanza los 4 revisores en paralelo por nombre, sin segundo plano, y reporta los omitidos con justificación. Refuta los hallazgos serios, aplica el checklist de coherencia y hace la prueba de reversión, que deshace antes del veredicto: un pass exige el mismo `HEAD` y el worktree limpio. Un `test_gate_failed` en un pass se convierte en un reject.
- **Pruebas.**
  - `assets/skills/skills.test.ts` comprueba la estructura y que cada skill cite lo que su fase necesita. El paquete no depende de paquetes internos.
  - `packages/server/src/skills/examples.test.ts` valida con `parseHandoff` el ejemplo de cada skill, así un cambio de esquema rompe la suite si la skill queda atrás.
  - `pnpm --filter @lunasq/server test:skills` prueba el criterio contra Claude Code real. Una tarea de juguete (una calculadora en JavaScript, `node --test`) recorre refinamiento, aprobación de la spec, implementación y verificación. Cada fase corre en un `claude -p` con el `phasePrompt` del dispatcher, el MCP por `--mcp-config` y `--strict-mcp-config` (sin engram), el settings de hooks y el gate de UW-11 con un runner local. Se comprueba que cada Run dejó un handoff que pasa `parseHandoff` con la transición aplicada, que el refinador y el verificador no dejaron cambios, y que cada revisor reportado como `ran` aparece en los hooks del Run. Las fases usan `LUNASQ_SKILL_MODEL` (sonnet por defecto) y los revisores `LUNASQ_REVIEWER_MODEL` (haiku).
- **Rama base.** Las skills comparan contra `$(git merge-base origin/<base> HEAD)`, porque el worktree sale de `origin/<base>` y la rama local puede ir atrasada (ADR 0012).
- **Commits de la tarea.** Por la misma razón, `GitCommitVerifier.missing` (UW-15) rechaza también un SHA que ya está en `origin/<base>`, además de los que están en la base local. Así, una `main` local atrasada no hace pasar commits upstream como si fueran de la tarea.
- `serve` y `runClaude` pasan a `src/test-helpers/real-claude.ts`, compartidos con `test:claude` de UW-19.

## Resultado

Con Claude Code 2.1.314, `pnpm --filter @lunasq/server test:skills` pasó completo (3 de 3) con las fases en sonnet y los revisores en haiku. Cada fase dejó un handoff válido y aplicó su transición: refined, verification/queued y el veredicto. El refinador no tocó el árbol ni el HEAD. El implementador dejó el checklist completo y declaró commits del branch. Los revisores reportados como `ran` aparecen en los hooks del Run, y el verificador dejó el worktree limpio y el mismo HEAD. La corrida final tardó unos 5 minutos.

La revisión con contexto limpio llevó a estos cambios:
- comparar contra `merge-base origin/<base> HEAD` y no contra la rama base local;
- una prueba de reversión por criterio que no cuenta un fallo de import como evidencia;
- `mem_session_summary` antes de la tool de salida;
- un ejemplo de pass validado;
- un `origin` en el repo de prueba.

## Consecuencias

- **UW-23**: la skill ya pide reportar como `ran` solo a los revisores lanzados; `test:skills` comprueba eso mismo contra los hooks, así que la validación de UW-23 no debería romper el flujo.
- **UW-26**: sin agente en la entrega, la descripción del PR sale de los handoffs (intent, criterios, `riskLabel`), no de una skill.
- **UW-28**: `lunasq install` copia `assets/skills/*/` a `~/.claude/skills/`. Un proyecto puede sobrescribir una skill con una del mismo nombre en su `.claude/skills/`.
- La prueba real no es determinista: un modelo puede tomar otro camino (por ejemplo, un reject en lugar de un pass). Por eso el test acepta cualquier veredicto válido y solo exige el handoff, la transición y la limpieza del worktree.
