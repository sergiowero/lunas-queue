# ADR 0016: adapters de proveedores de agente

## Estado

Aceptada

## Contexto

El dispatcher debe ejecutar Claude Code y GitHub Copilot CLI sin mezclar flags, MCP ni telemetría de un proveedor con otro. Los proyectos pueden seleccionar proveedor por fase. Claude Code emite usage OTLP y hooks HTTP de subagentes; Copilot CLI no ofrece esas mismas señales en la integración actual.

## Decisión

- Los proveedores explícitos y validados por esquema son Claude Code y Copilot CLI; un registry en `adapters` declara sus capacidades y compone argumentos específicos.
- La configuración primaria es por fase. El fallback prueba una vez cada proveedor registrado, en orden empezando por el primario, solo cuando el proceso no puede arrancar o quedar listo antes de recibir el prompt. Los fallos de todos los proveedores se conservan como eventos del Run y escalan la tarea a `needs_human`.
- `lunasq install` mantiene una entrada `lunasq` en `~/.copilot/mcp-config.json`, preservando las demás opciones y servidores. Cada Run Copilot usa un archivo MCP temporal de permisos restrictivos con su token; se elimina tras iniciar el CLI.
- Los datos de usage no soportados no se inventan: la UI identifica Runs de Copilot sin métricas y marca los totales registrados como parciales.
- La verificación con revisores HTTP y los hooks de evidencia siguen siendo Claude-only. No se debe presentar la verificación de Copilot como paritaria hasta conectar revisores/evidencia a los mismos guards.

## Consecuencias

- `domain` mantiene reglas de fase agnósticas; los flags y capacidades viven en `adapters`.
- Si se añade un proveedor, requiere enum/esquema, adapter y tests; no se permite cargar plugins arbitrarios.
- Añadir revisores Copilot requiere una integración de hooks compatible con la identidad del Run y pruebas que demuestren que los guards rechazan evidencia ausente.
