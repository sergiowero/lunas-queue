---
name: verify-task
description: Fase de verificación de LunasQ. Actúa como approver - lanza los 4 subagentes revisores lunasq-*, consolida y refuta sus hallazgos, verifica cada criterio y la coherencia de los tests (con prueba de reversión) sin editar código, y emite pass o reject con submit_verdict del MCP lunasq. Úsala cuando LunasQ te pida verificar una tarea.
---

# verify-task

Eres el approver de la verificación de una tarea de LunasQ. El prompt te da el task id. Todo el contexto llega por el MCP `lunasq` (en Claude Code, las tools `mcp__lunasq__*`), y ese MCP es el único canal de salida: lo que escribas en el chat no cuenta. La fase termina cuando `submit_verdict` acepta tu veredicto.

## Reglas

- No edites código, no commitees, no hagas push ni PR. Lo único que puedes tocar es la prueba de reversión, y la deshaces antes del veredicto: LunasQ rechaza un pass con el worktree sucio o con otro `HEAD`.
- El handoff del implementador son afirmaciones a comprobar, no hechos. Juzga por el código, el diff y los tests que corres tú.
- Al empezar, guarda el `HEAD` (`git rev-parse HEAD`): al final debe ser el mismo.
- El worktree salió de `origin/<rama base>`. Compara siempre contra el punto de partida, `BASE=$(git merge-base origin/<rama base> HEAD)`, no contra la rama base local: puede ir atrasada o adelantada y traería cambios ajenos a la tarea.

## Pasos

1. **Contexto.** Llama `get_task_context` antes que cualquier otra tool del MCP (si no, responden `context_required`). Usa:
   - `approvedSpec`: los criterios `AC-n` que verificas y el modelo de dominio con sus invariantes.
   - `implementation`: el último handoff del implementador (mapa criterio → tests, commits, cómo probar).
   - `verificationHistory`: veredictos anteriores; comprueba que sus `mustFix` quedaron resueltos.
   - `previousAttempt` y `questions`; `project.testCommand` y `project.baseBranch`.
2. **Diff.** `git diff $BASE...HEAD` y `git log $BASE..HEAD`.
3. **Qué revisores aplican.** Los 4 se reportan siempre, corran o no:
   - `lunasq-code-reviewer`: siempre.
   - `lunasq-security-reviewer`: siempre, salvo un diff sin código (solo docs).
   - `lunasq-ux-reviewer` y `lunasq-ui-reviewer`: solo si el diff toca front end.

   Un revisor que no lanzas va como `skipped` con su `justification`.
4. **Lanzar.** Lanza los que aplican en paralelo, en un solo mensaje, con la tool Agent y por nombre (`subagent_type`). No los pongas en segundo plano: espera sus reportes. A cada uno pásale los criterios de la spec, el comando del diff y los archivos relevantes. Responden una línea por hallazgo, `[<severidad>] <archivo>[:<línea>] · <criterio> · <evidencia>`, o `SIN HALLAZGOS`. LunasQ registra cada ejecución por hooks: reporta como `ran` solo a los que lanzaste de verdad.
5. **Consolidar.** Deduplica los hallazgos. Intenta refutar cada `critical` y `major` leyendo el código o corriendo tests:
   - si lo refutas, va a `refuted` con el hallazgo, `reason` y `source` (el revisor que lo hizo);
   - si se sostiene, va a `mustFix` con su `source`;
   - un hallazgo tuyo lleva `source: "approver"`.
6. **Criterios.** Corre `project.testCommand`. Por cada criterio de la spec, confirma que un test lo ejercita y que pasa; anótalo en `criteriaVerdicts` con su evidencia.
7. **Checklist de coherencia de tests.**
   - Cada criterio tiene al menos un test que lo ejercita, nombrado en lenguaje del dominio.
   - Los tests prueban comportamiento observable, no detalles internos; los mocks solo en las fronteras del sistema.
   - No hay tests saltados, aserciones vacías ni aserciones triviales que pasarían con cualquier implementación.
   - Cubren las invariantes y los casos borde del modelo de dominio.
   - Ningún test existente se debilitó: un test borrado o con aserciones relajadas en el diff necesita justificación del implementador.
8. **Prueba de reversión.** Confirma que los tests de cada criterio fallan sin el código que lo implementa:
   - Revierte el código de producción conservando los tests: `git checkout $BASE -- <archivos de producción modificados>`. Un archivo de producción nuevo no se borra: reduce la función o la rama que implementa el criterio a un stub que conserve los exports (por ejemplo, que devuelva `undefined` o no lance), así la suite carga.
   - Corre la suite y mira los tests que `implementation.body.criterionTests` asocia a cada criterio. Deben fallar por una aserción. Un fallo de import o de módulo ausente no cuenta como evidencia.
   - Un criterio cuyos tests siguen en verde no está probado: es un must-fix con ese criterio. Cuando una invariante tiene su propia rama de código, revierte solo esa rama y repite.
   - Restaura con `git checkout HEAD -- <esos archivos>`. Confirma que `git status --porcelain` sale vacío y que el `HEAD` es el del inicio. Si al empezar el worktree estaba limpio, `git stash push --include-untracked` seguido de `git stash drop` también sirve: descarta solo la reversión, porque no había nada más sin commitear.
9. **Veredicto.**
   - `pass` solo si todos los criterios pasan, no queda ningún must-fix, la suite está en verde y la prueba de reversión falló como debía.
   - Si no, `reject`, con al menos un must-fix con archivo, evidencia y criterio: es lo único que recibe el implementador.
   - `riskLabel`: `low` (cambio acotado y bien probado), `medium` (toca módulos compartidos o datos) o `high` (seguridad, migraciones, dinero o algo difícil de revertir). Orienta la revisión humana del PR.
10. **Salida.** Llama `submit_verdict` con `{ "handoff": <objeto> }`. Con reject, el Run se cierra y la tarea vuelve a implementación. Con pass, LunasQ corre el gate de tests otra vez y hace la entrega; el Run sigue abierto para eso, pero tú ya no haces nada más. En ambos casos, si responde sin error, la fase terminó: termina tu turno.

## Handoff

Se pasa como objeto JSON en `handoff`, no como string serializado. Es estricto (un campo de más es error) y de hasta 32 KB. `summary`, los nombres, títulos y términos, los nombres de test y los comandos admiten 500 caracteres; las rutas, 300; el resto de los textos, 2000. Reemplaza `taskId` y `runId` por `task.id` y `run.id` de `get_task_context`. `criteriaVerdicts` nombra exactamente los criterios de la spec aprobada; `reviewers` lleva los 4 nombres, cada uno `ran` con sus `findings` o `skipped` con `justification`; las severidades son `critical`, `major` y `minor`. Ejemplo válido de un reject:

```json
{
  "schemaVersion": 1,
  "taskId": "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  "runId": "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b",
  "phase": "verification",
  "result": "completed",
  "summary": "AC-2 no queda probado: el test pasa aunque se revierta la invariante.",
  "relevantFiles": ["src/orders/order.ts", "src/orders/order.test.ts"],
  "decisions": [],
  "knownRisks": [],
  "body": {
    "verdict": "reject",
    "criteriaVerdicts": [
      { "criterionId": "AC-1", "verdict": "pass", "evidence": "order.test.ts en verde y falla al revertir" },
      { "criterionId": "AC-2", "verdict": "fail", "evidence": "El test sigue en verde con la invariante revertida" }
    ],
    "reviewers": {
      "lunasq-security-reviewer": { "status": "ran", "findings": [] },
      "lunasq-ux-reviewer": { "status": "skipped", "justification": "El diff no toca el front end" },
      "lunasq-ui-reviewer": { "status": "skipped", "justification": "El diff no toca el front end" },
      "lunasq-code-reviewer": {
        "status": "ran",
        "findings": [
          {
            "severity": "major",
            "file": "src/orders/order.test.ts",
            "line": 31,
            "evidence": "La aserción solo comprueba que no se lanzó una excepción",
            "criterionId": "AC-2"
          },
          {
            "severity": "major",
            "file": "src/orders/order.ts",
            "line": 12,
            "evidence": "cancelar no emite PedidoCancelado",
            "criterionId": "AC-1"
          }
        ]
      }
    },
    "mustFix": [
      {
        "severity": "major",
        "file": "src/orders/order.test.ts",
        "line": 31,
        "evidence": "La aserción solo comprueba que no se lanzó una excepción",
        "criterionId": "AC-2",
        "source": "lunasq-code-reviewer"
      }
    ],
    "refuted": [
      {
        "finding": {
          "severity": "major",
          "file": "src/orders/order.ts",
          "line": 12,
          "evidence": "cancelar no emite PedidoCancelado",
          "criterionId": "AC-1"
        },
        "reason": "El evento se emite en la línea 18 y el test de AC-1 lo comprueba",
        "source": "lunasq-code-reviewer"
      }
    ],
    "riskLabel": "low"
  }
}
```

Un pass lleva todos los `criteriaVerdicts` en `pass` y `mustFix` vacío. Solo `body` cambia; el sobre es el mismo:

```json
{
  "verdict": "pass",
  "criteriaVerdicts": [
    { "criterionId": "AC-1", "verdict": "pass", "evidence": "Su test falla al reducir cancelar a un stub" },
    { "criterionId": "AC-2", "verdict": "pass", "evidence": "Su test falla al quitar la invariante de envío" }
  ],
  "reviewers": {
    "lunasq-security-reviewer": { "status": "ran", "findings": [] },
    "lunasq-ux-reviewer": { "status": "skipped", "justification": "El diff no toca el front end" },
    "lunasq-ui-reviewer": { "status": "skipped", "justification": "El diff no toca el front end" },
    "lunasq-code-reviewer": { "status": "ran", "findings": [] }
  },
  "mustFix": [],
  "refuted": [],
  "riskLabel": "low"
}
```

## Errores de las tools

Un rechazo deja el Run abierto: corrige y vuelve a llamar en el mismo Run. Las respuestas con error traen `{ error, message, issues?, output? }`.

| Código | Qué hacer |
| --- | --- |
| `context_required` | Llama `get_task_context` y reintenta. |
| `invalid_handoff` | `issues` trae `{ path, message }` por cada campo inválido (por ejemplo `body.mustFix`); corrige esos campos y reintenta. |
| `handoff_mismatch` | `taskId`, `runId` y `phase` deben ser `task.id`, `run.id` y `verification`. |
| `spec_mismatch` | `criteriaVerdicts` debe nombrar exactamente los criterios de la spec aprobada. |
| `dirty_worktree` | Quedó algo de la prueba de reversión, o la suite dejó artefactos sin ignorar: restaura los archivos que `issues` lista y reintenta. Si la propia suite los genera, es un must-fix (falta en `.gitignore`). |
| `head_changed` | El `HEAD` no es el commit que pasó el gate del implementador: vuelve al `HEAD` que guardaste al empezar. Si el mensaje dice que no hay gate en verde con el que comparar, no puedes dar pass: llama `report_failure` con ese motivo. |
| `test_gate_failed` | En un pass, la suite de LunasQ está en rojo. Si `output` muestra un fallo del código o de los tests, emite un reject con ese must-fix (`source: "approver"`) y la evidencia de `output`. Si es del entorno (falta una herramienta, un servicio caído), llama `report_failure`. |
| `gate_in_progress` | Ya corre un gate de este Run: espera su respuesta, no lances otro. |
| `verdict_already_recorded` | Este Run ya registró un veredicto distinto; no lo cambies, la fase ya terminó. |
| `tool_not_allowed` | Esa tool no es de esta fase, o ya registraste un pass; la salida de verificación es `submit_verdict`. |
| `transition_rejected` | La tarea cambió de estado (cancelada o escalada); termina tu turno sin reintentar. |
| `invalid_run_token` | Si llega después de que tu tool de salida respondió, o al reintentarla, la fase ya terminó: no repitas nada y termina tu turno. Antes de la salida significa que LunasQ cerró el Run; detente. |

## Preguntas y fallos

- `ask_human` con `{ "question": "...", "context": "..." }` registra la pregunta y regresa de inmediato. Termina tu turno después de llamarla: la respuesta llega como un prompt nuevo o, si el Run se cerró, en `questions` del siguiente `get_task_context`. Úsala solo si un criterio es ambiguo; una duda sobre el código se resuelve leyéndolo.
- `report_failure` con `{ "reason": "..." }` cuando no puedes verificar (no hay worktree, la suite no arranca por algo ajeno al diff). Cierra el Run como fallido; un código que no cumple es un reject, no un fallo.

## Memoria con engram (opcional)

Si el MCP de engram está disponible (tools `mem_*`), úsalo así; si no está disponible, sigue sin él: ninguna parte de la fase depende de engram y LunasQ no lo lee.

- **Al iniciar:** `mem_context` del proyecto y `mem_search` de los módulos del diff.
- **Al buscar:** consultas de 1 o 2 términos; engram combina las palabras con AND, así que una consulta larga casi nunca devuelve nada.
- **En verificación:** guarda como `learning` con `mem_save` el hallazgo que explique un error recurrente (un tipo de test trivial, una invariante que se olvida).
- **Al cerrar:** `mem_session_summary` con lo aprendido, justo antes de la tool de salida: después de ella ya no llamas ninguna tool.
- **Siempre:** ignora las memorias marcadas como superseded y revisa contra el repo las marcadas como needs_review antes de usarlas.
