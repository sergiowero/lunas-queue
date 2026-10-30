---
name: lunasq-setup
description: Deja LunasQ listo y corriendo en esta máquina (Node 26, pnpm install, lunasq install/doctor, lunasq start, front end con Vite). Úsalo cuando pidan configurar el proyecto, arrancarlo, levantar el servidor o la UI, o diagnosticar por qué no corre.
---

# lunasq-setup

Corre los pasos en orden y detente en el primer fallo: repórtalo con su salida y la acción que propone `doctor`. Todo desde la raíz del repo.

## 1. Node 26

`package.json` exige `node >=26` (`.node-version`) y `doctor` falla con menos. El PATH puede traer otro Node (`/opt/homebrew/bin/node`).

```sh
node -v          # debe ser v26.x
```

Si no es 26, usa fnm (instalado en esta máquina): `fnm install 26 && fnm use 26`, y repite el comando en el mismo shell con `eval "$(fnm env)" && fnm use 26 && <comando>`. Si no hay fnm, avisa al usuario.

## 2. Dependencias

```sh
pnpm install
```

pnpm está fijado en `packageManager`. better-sqlite3 usa prebuilds (no compila); si `doctor` dice que no carga, es un problema de plataforma (ADR 0003).

## 3. Requisitos de la máquina

```sh
pnpm lunasq doctor
```

Necesita herdr ≥ 0.9.5 con su servidor corriendo, Claude Code ≥ 2.1.312 y `gh auth login` hecho. `lunasq install` no instala esos tres: si faltan, pídele al usuario que los instale (herdr: `herdr status --json`; gh: `gh auth login`).

## 4. Instalar (una vez, idempotente)

```sh
pnpm lunasq install [--port <n>]
```

Escribe `~/.lunasq/` (`config.json`, `mcp.json`, `claude-settings.json`, base SQLite) y copia skills/subagentes a `~/.claude/`. Repetirlo no cambia nada. Luego `pnpm lunasq doctor` debe salir en verde (solo avisos son aceptables). Puerto por defecto: 7360.

Para no tocar el entorno real: `LUNASQ_HOME=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d) pnpm lunasq install` y usa las mismas variables en `doctor` y `start`.

## 5. Arrancar

```sh
pnpm lunasq start
```

Imprime `LunasQ en http://127.0.0.1:<puerto>`; se detiene con Ctrl-C. Es un proceso largo: córrelo en background (`run_in_background`). Comprueba que vive:

```sh
curl -s http://127.0.0.1:7360/api/projects
```

Errores típicos: `LunasQ no está instalado` → paso 4; puerto ocupado → `lunasq install --port <otro>` o libera el puerto.

## 6. Front end (opcional)

`lunasq start` hoy no monta el build del front end (`webRoot` no se pasa desde `startRuntime`), así que la UI se corre con Vite apuntando al servidor:

```sh
LUNASQ_API=http://127.0.0.1:7360 pnpm --filter @lunasq/web dev
```

`LUNASQ_API` es necesario: el proxy de `vite.config.ts` usa 4310 por defecto, no el 7360 de `start`. Vite imprime la URL (normalmente `http://localhost:5173`).

## Verificación del repo

Antes de un PR (ver `AGENTS.md`): `pnpm typecheck && pnpm lint && pnpm test`. Pruebas contra herdr/Claude/gh reales, aparte: `pnpm --filter @lunasq/server test:herdr` (también `test:claude`, `test:usage`, `test:skills`).
