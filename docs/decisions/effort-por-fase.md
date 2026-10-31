# Esfuerzo del agente por fase

**Estado:** aceptada

## Contexto

El perfil de agente de cada fase ya tenía `model` y `args`. El esfuerzo de Claude Code (`claude --effort`) solo podía pasarse dentro de `args`, como texto libre, sin validación y sin ayuda en el formulario.

## Decisión

- `AgentProfile` gana `effort?: low | medium | high | xhigh | max` (`EffortLevel` en `packages/schemas/src/project.ts`). Se aplica a las cuatro fases, incluida `verify`, que comparte el mismo perfil.
- `agentArgs` (packages/domain/src/dispatch.ts) emite `--effort <nivel>` justo después de `--model`, antes de los args del perfil.
- Un perfil con `effort` y además `--effort` (o `--effort=…`) en `args` se rechaza con `DispatchRuleError`: no hay dos fuentes para el mismo flag.
- El formulario de proyecto tiene un selector «Esfuerzo de {fase}» con «Predeterminado» (sin `effort`).

No se reserva `--effort` globalmente: los proyectos que ya lo ponen en `args` siguen funcionando.

## Consecuencias

- Sin `effort`, el comando de `claude` es idéntico al de antes.
- Al editar un proyecto, quitar el esfuerzo en el selector lo elimina del perfil (el PATCH reemplaza el perfil completo).
