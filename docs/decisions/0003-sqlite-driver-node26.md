# 0003 — Driver de SQLite en Node 26: better-sqlite3 13 con prebuilds N-API

- Estado: aceptada
- Fecha: 2026-10-28
- Unidad: UW-00 (spike c) · Código: `spikes/sqlite/`

## Contexto

better-sqlite3 es un módulo nativo; `docs/tech-stack.md` pedía confirmar binarios precompilados para Node 26 y dejaba `node:sqlite` como plan B detrás de Drizzle.

## Opciones

1. **better-sqlite3** + `drizzle-orm/better-sqlite3`.
2. **`node:sqlite`** (`DatabaseSync`) + el driver de Drizzle correspondiente.

## Resultado del spike

Node 26.13.0 (ABI 147), macOS arm64, pnpm 11.22.0, better-sqlite3 13.0.3, drizzle-orm 0.45.4:

- better-sqlite3 13 trae **prebuilds N-API dentro del paquete** (`prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`), independientes de la versión de Node, y declara `"gypfile": false`.
- pnpm 11 bloquea los build scripts por defecto (`ERR_PNPM_IGNORED_BUILDS`, exit 1). Si se permiten, pnpm corre `node-gyp rebuild` solo porque existe `binding.gyp` (compila con éxito, pero hace falta toolchain y es innecesario). Con **`allowBuilds: { better-sqlite3: false }`** la instalación termina en exit 0, no compila nada y el módulo carga el prebuild.
- Con el prebuild: `journal_mode=WAL` confirmado (SQLite 3.53.4), claim atómico con `UPDATE … WHERE state = 'queued'` en `db.transaction()` (el segundo claim falla), rollback ante excepción y transacción síncrona con Drizzle sobre la misma conexión. Salida en `spikes/sqlite/output.txt`; instalación, prebuilds y `node:sqlite` en `spikes/sqlite/install-log.txt`.
- `node:sqlite` carga en Node 26 sin warning experimental (SQLite 3.54.0), pero `DatabaseSync` no tiene helper de transacción y la ventaja de better-sqlite3 no cambia.

## Decisión

Mantener **better-sqlite3** (13.x) con Drizzle. En `pnpm-workspace.yaml` de la raíz se declara `allowBuilds: { better-sqlite3: false }` cuando UW-01 agregue la dependencia, para usar el prebuild sin compilar. `node:sqlite` queda como plan B sin trabajo pendiente.

## Consecuencias

- No hace falta toolchain de C++ en CI ni en las máquinas de usuarios de las plataformas con prebuild.
- Una plataforma sin prebuild (p. ej. FreeBSD) requeriría permitir el build; `lunasq doctor` puede detectar que el módulo no carga.
- Al subir de major de better-sqlite3 se repite este spike.
