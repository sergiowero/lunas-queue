# Pass refusado por git: vuelve a implementación

**Estado:** aceptada

## Contexto

`submit_verdict` con pass rechaza con `dirty_worktree` o `head_changed` si el worktree tiene
cambios sin commitear o el `HEAD` no es el commit que pasó el gate. Esos estados los causa, casi
siempre, el implementador o el entorno (un archivo ajeno sin seguimiento, un commit que no es de
código), no el verificador. El verificador no puede commitear, descartar ni mover el `HEAD`, así
que la tarea quedaba sin salida: el verificador reportaba un fallo y la tarea no avanzaba.

## Decisión

Un pass refusado por `dirty_worktree` o `head_changed` se convierte en un reject del mismo Run:

- El handoff guardado es el del verificador con `verdict: "reject"` y un único must-fix
  `source: "approver"`, `severity: "major"`, `file` = primer archivo sucio (o `.` si es el `HEAD`) y
  `evidence` con el motivo y la lista de archivos.
- La transición es `verdict_rework`, así que la tarea vuelve a implementación (o a
  `needs_human` si llega al tope de iteraciones del proyecto).
- El implementador recibe el must-fix en `rework` de `get_task_context` y lo corrige: commitea lo
  del cambio, ignora lo generado (`.gitignore`) o lo ajeno (`.git/info/exclude`), y reenvía
  `submit_for_verification`.

Otros rechazos del pass (`test_gate_failed`, `reviewer_evidence_mismatch`, `hook_blocked`) no
cambian.

## Consecuencias

- El verificador ya no ve `dirty_worktree` ni `head_changed` en un pass; debe restaurar lo que tocó
  la prueba de reversión antes de emitirlo.
- Un pass sin gate en verde previo también vuelve a implementación, donde el agente corre
  `submit_for_verification` y genera el gate.
- Cuenta como iteración de verificación, así que el tope del proyecto sigue acotando el bucle.

Ver también los ADR uw-11-gate-tests, uw-15-mcp-tools y uw-24-archivo-evidencia.
