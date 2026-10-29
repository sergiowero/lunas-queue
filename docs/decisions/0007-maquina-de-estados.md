# 0007 — Máquina de estados y Event log

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-04 · Código: `packages/domain/src/state-machine.ts`, `packages/db/src/task-transitions.ts`, `packages/db/src/event-log.ts`, `packages/schemas/src/events.ts`, `packages/db/drizzle/0001_events_append_only.sql`

## Contexto

`docs/design.md` (§Máquina de estados) define los estados, los sub‑estados y la tabla de transiciones, pero deja abiertos la salida de Needs human, el regreso a In progress por conflictos en la entrega, la cuenta de iteraciones y reintentos, y cómo se garantiza que ninguna transición ocurra sin su evento.

## Decisión

- **Comandos.** La máquina de estados recibe 14 comandos (`TaskCommand` en `@lunasq/schemas`). Diez cambian el estado: `submit_spec`, `request_changes`, `approve`, `submit_for_verification`, `verdict_rework`, `verdict_pass`, `delivery_conflict`, `escalate`, `cancel` y `resume`. Cuatro cambian solo el sub‑estado: `dispatch` (queued → running), `ask_human` (running → waiting\_human), `answer` (waiting\_human → running si el agente sigue vivo, o queued si no) y `run_failed` (running → queued).
- **Dominio puro.** `transition(snapshot, command, actor)` no tiene efectos: devuelve el estado siguiente y el evento, o un error `invalid_transition`, `actor_not_allowed` o `guard_failed`, en ese orden de precedencia. Los guards reciben hechos ya calculados por quien llama (spec completa, versión aprobada, gate de tests, coherencia de tests, criterios, commits, PR); los calculan UW-11, UW-12, UW-23 y UW-26.
- **Actores.** Cada comando tiene sus actores permitidos (`COMMAND_ACTORS`), según la tabla del diseño. `verdict_pass` lo emite solo el sistema: el verificador registra su veredicto en el handoff (UW-23) y la entrega (UW-26) emite el pass después de crear el PR, con el hecho `verifierPassed`; el agente no puede saber si el PR se creó.
- **Orígenes.** Los comandos que cierran una fase (`submit_spec`, `submit_for_verification`, `verdict_rework`, `verdict_pass`, `delivery_conflict`) exigen `running`: el Run de la fase sigue abierto. Así nadie puede completar una tarea en `verification/queued`, que es la que todavía no tiene verificador. La entrega corre mientras el Run del verificador está abierto, y ese Run se cierra después de la transición; la reconciliación (UW-17) no debe tratar ese intervalo como un Run caído.
- **Sub‑estado.** Solo draft, in\_progress y verification llevan sub‑estado, y se entra a ellos en `queued`; el resto lo tiene en `null`. Un snapshot incoherente rechaza todo comando.
- **Iteraciones.** `verificationIteration` cuenta reworks. `verdict_rework` con iteración menor que el máximo (default 3) vuelve a in\_progress con iteración + 1; con el máximo alcanzado va a needs\_human con `reason: iterations_exhausted`. Con el default caben tres reworks.
- **Reintentos.** `run_failed` lleva `attempt`, los Runs fallidos consecutivos de la fase contando este; quien llama los cuenta desde el último `dispatch` exitoso o `resume`. Hasta `maxRetries` (default 3) la tarea vuelve a queued; el siguiente fallo la manda a needs\_human con `reason: retries_exhausted`.
- **Needs human.** `escalate` aplica desde cualquier estado no terminal salvo needs\_human, con una `EscalationReason`. El humano sale con `resume`, que vuelve al estado previo al último escalamiento (leído del `from` de ese evento) con su sub‑estado inicial, o con `cancel`. `resume` conserva la iteración salvo que el humano pida `resetIteration`, que la pone en 0 y concede un ciclo de verificación completo; sin eso, reanudar tras `iterations_exhausted` escalaría de nuevo al primer rework.
- **Conflictos en la entrega.** `delivery_conflict` regresa de verification a in\_progress sin subir la iteración: no es un rework del verificador.
- **Terminales.** completed y cancelled no aceptan ningún comando; `cancel` no aplica a completed.
- **Evento.** Toda transición se registra como `task.transitioned`, con payload `{command, from, to, verificationIteration, reason?, note?}`. El dominio valida el evento con `TaskTransitionedEvent` antes de devolverlo y responde `guard_failed` si no cumple (nota vacía o de más de 2000 caracteres, razón fuera del enum): al log solo entra lo que después se puede leer. Otros tipos de evento (por ejemplo `task.created`) se escriben con `appendEvent` y no cambian estado.
- **Persistencia.** `transitionTask` es la única vía para cambiar estado, sub‑estado o iteración. Corre en una transacción `IMMEDIATE`, que toma el lock de escritura antes de leer la tarea: aplica el dominio, hace el update condicionado al estado leído y agrega el evento. Si el evento falla, se revierte la tarea. El parámetro opcional `expected` rechaza con `stale_state` si la tarea ya no está donde quien llama la vio. Repetir un comando ya aplicado da `invalid_transition` y no duplica el evento.
- **Append‑only en la base.** La migración custom `0001_events_append_only` agrega triggers `BEFORE UPDATE` y `BEFORE DELETE` sobre `events` que abortan. Drizzle no genera triggers; la migración se creó con `drizzle-kit generate --custom` y el test de sincronía sigue pasando porque el snapshot no cambia.

## Consecuencias

- UW-07, UW-12, UW-15, UW-16, UW-17 y UW-26 mueven tareas solo con `transitionTask` y le pasan los hechos de cada guard.
- UW-08 publica el outbox a partir de los eventos `task.transitioned`; el esquema del payload ya está en `@lunasq/schemas`.
- La base no impide un `UPDATE` crudo de `tasks.state`; la regla se cumple por convención y revisión.
