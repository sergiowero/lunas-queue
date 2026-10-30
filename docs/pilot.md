# Piloto de LunasQ

El piloto tiene dos partes. La suite e2e (`pnpm e2e`, [ADR uw-29-e2e](decisions/uw-29-e2e.md)) automatiza el guion con un agente guionado y corre en CI. Esta guía es la otra parte: el mismo guion en un proyecto real, con herdr y Claude Code de verdad. Gasta tokens y necesita tu máquina, así que se corre a mano, una vez por versión.

## Antes de empezar

1. `lunasq install` y `lunasq doctor` en verde (sin fallas).
2. Un repo de prueba en GitHub, clonado en local, con `gh auth status` válido y un comando de tests que pase.
3. En ese repo, en la rama base, `lunasq/hooks/before_verification/10-smoke.sh` (ejecutable, `echo ok`) y `lunasq/hooks/after_implementation/10-lint.sh` (falla con `exit 1`) con `{"after_implementation": {"10-lint.sh": {"policy": "warn"}}}` en `lunasq/hooks/config`. Solo corren los puntos que `docs/decisions/uw-29-e2e.md` lista como conectados.
4. `lunasq start` y abrir la URL que imprime.

## Guion

1. Crea el proyecto (`POST /api/projects`: repo, rama base, ruta local y comando de tests).
2. Crea tres tareas desde **Nueva tarea**: A, B (depende de A) y C (depende de B). Haz que A sea ambigua para forzar una pregunta.
3. **Pregunta:** responde en la **Bandeja** cuando el refinador pregunte; luego abre A desde «Specs por aprobar» de la Bandeja y aprueba su spec en el detalle de la tarea. Comprueba que el agente retoma con tu respuesta.
4. **Dependencias:** B y C no arrancan hasta que el PR de la anterior se mergea. Mergea el PR de A en GitHub y comprueba que B avanza en el siguiente poll.
5. **Rework:** en B, abre B desde la Bandeja y rechaza algo en la spec (**Pedir cambios**) o deja que el verificador rechace; comprueba que vuelve a implementación con los must-fix y que la iteración sube.
6. **Hook:** en **Hooks** del proyecto, comprueba la ejecución de `10-smoke.sh` y que `10-lint.sh` falló sin detener la fase.
7. Mergea B y C. Cada tarea debe terminar en un PR mergeable (rebasado sobre la base, con evidencia y etiqueta de riesgo).

## Qué registrar

Cada desvío del guion es un hallazgo. Conviértelo en una tarea de LunasQ (intent con el síntoma, el paso del guion y lo que esperabas) y enlázala con **originada por** a la tarea donde apareció.

## Hallazgos de la suite e2e (listos para encolar)

- **Conectar los hooks que faltan:** `before_refinement`, `after_refinement`, `before_implementation` y `on_failure` están en el esquema y en `docs/design.md` §Hooks por fase, pero ningún módulo los ejecuta. Conectarlos a su fase (dispatcher y MCP, como `before_verification`) y probar cada punto.
- **Despertar al scheduler al crear una tarea:** hoy la tarea nueva espera el siguiente tick (30 s). `POST /api/tasks` debería despertarlo, como ya lo hace responder una pregunta.
