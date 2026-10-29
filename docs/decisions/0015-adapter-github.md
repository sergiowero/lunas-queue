# 0015 — Adapter de GitHub (gh) y detección de merges por polling

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-14 · Código: `packages/adapters/src/github/`, `packages/schemas/src/pull-request.ts`, `packages/domain/src/pull-requests.ts`, `packages/db/src/task-prs.ts`, `packages/server/src/github/`

## Contexto

`docs/design.md` (§Integraciones externas y §Decisiones) pide hablar con GitHub solo por el CLI `gh`, detrás de un adapter: crear el PR, leer CI y reviews y detectar merges por polling en v1. Una tarea está *ready* cuando todas sus dependencias tienen su PR mergeado, y si el PR de una dependencia se cierra sin merge, sus dependientes pasan a Needs human. UW-13 (ADR 0014) ya calcula el ready set con `prState = merged` y escala a los dependientes de un PR cerrado; le faltaba quién registrara el estado del PR. El criterio de UW-14: un merge detectado libera a las tareas dependientes.

## Decisión

- **Puerto `GitHubAdapter`** (`@lunasq/adapters`): `createPr`, `findOpenPr` y `getPr(url)`. `PullRequest` trae número, URL, estado (`PrState` de `@lunasq/schemas`), draft, branches, `mergedAt`/`closedAt`, checks (cada uno `pending | success | failure | skipped` y un resumen `none | pending | success | failure`: una falla gana, luego un pendiente) y reviews con su `reviewDecision` (null si el repo no exige reviews).
- **`createPr` idempotente.** Busca primero un PR abierto de `head` hacia `base` (`gh pr list --state=open`) y, si existe, lo devuelve con `created: false`. Si `gh pr create` falla con "already exists" (otro proceso lo abrió en medio), vuelve a buscar y devuelve ese. Un PR cerrado o mergeado no cuenta: se abre otro. Publicar el branch es de la entrega (UW-26), no del adapter.
- **Sin shell.** `RealGitHub` corre `gh` con `execFile` y argumentos sueltos con la forma `--flag=valor`: título y cuerpo vienen de agentes y no deben poder inyectar comandos ni pasar por otra opción si empiezan con `-`. El cuerpo entra por stdin (`--body-file=-`). `GH_PROMPT_DISABLED=1` evita prompts; cada comando tiene timeout (60 s por defecto). `getPr` usa la URL y no necesita checkout.
- **Errores.** `GitHubError` con `code`: `gh_unavailable` (binario ausente), `not_authenticated` (exit 4), `not_found` (mensajes de gh 2.100 para PR o repo inexistente), `timeout`, `invalid_output` (la salida `--json` se valida con Zod; los esquemas no son estrictos porque gh agrega campos entre versiones) y `gh_failed`.
- **Fake y contrato.** `FakeGitHub` en memoria con controles (`merge`, `close`, `reopen`, `setChecks`, `addReview`, `failGetPr`). La suite de contrato corre contra el fake en `pnpm test` y contra GitHub real con `LUNASQ_GH_SANDBOX_REPO=<owner>/<repo> pnpm --filter @lunasq/adapters test:gh`: clona el sandbox, publica branches `lunasq-contract/*`, abre, mergea y cierra PRs y borra los branches al terminar. No corre en CI.
- **El PR solo avanza.** `prStateChange` (dominio) permite únicamente `open → merged | closed`; un dato viejo nunca revierte un merge. Un PR nuevo (otra entrega tras un cierre sin merge) o el mismo PR reabierto en GitHub se registran con `recordPrOpened`, que rechaza abrir otro si el actual ya se mergeó (`pr_already_merged`).
- **Registro en la base.** `TaskPrRepository` (implementa el puerto `PrTrackingStore`) solo toca `pr_url` y `pr_state`, en transacciones `IMMEDIATE`, y deja su evento publicado en el outbox con actor `system`: `task.pr_opened` (`url`, `previousUrl`) y `task.pr_state_changed` (`url`, `from: open`, `to`, `at` = hora del merge o del cierre según GitHub). Lo observado de un PR que no es el actual de la tarea se ignora. Repetir un registro no escribe nada.
- **Poller.** `PrPoller` (server) consulta en cada pasada las tareas con PR abierto, una por una, y registra los cambios. Intervalo de 60 s por defecto (mínimo 1 s). Las pasadas no se solapan, como en el scheduler: un pedido durante una pasada pide una más. Un PR que falla (red, rate limit, PR borrado) se reporta con `onError` y la pasada sigue. Si registró algo, despierta al publicador del outbox.
- **Liberar y escalar es del scheduler.** El evento del outbox dispara una pasada del scheduler (suscrito a `*`, ADR 0014), que despacha a los dependientes ya listos y escala con `dependency_pr_closed` a los de un PR cerrado. UW-14 no duplica esa regla. Un test compone poller, outbox y scheduler y comprueba ambos casos.

## Consecuencias

- **UW-26** (entrega) llama a `createPr` después del push y registra el resultado con `recordPrOpened` antes de `verdict_pass` (`prCreated`). También compone el proceso: crea el `PrPoller` con el publicador y llama `start()` y `stop()`.
- **UW-10** (`after_merge`) y la remoción del worktree tras el merge (UW-17, UW-26) reaccionan a `task.pr_state_changed` con `to: merged`.
- **readySince.** El scheduler sigue usando el `updatedAt` de la dependencia, que ahora es la hora en que LunasQ detectó el merge: el momento en que la dependiente pudo empezar. La hora de GitHub queda en el evento por si hace falta.
- **Costo.** Una llamada a `gh` por PR abierto en cada pasada. Con el volumen de v1 basta; si crece, se agrupa con `gh api graphql` o se pasa al webhook (v2, §Roadmap).
- **Un PR reabierto en GitHub** sin que LunasQ lo registre no se vuelve a consultar: el poller solo mira los abiertos. La entrega lo registra al reentregar (`findOpenPr` lo encuentra).
