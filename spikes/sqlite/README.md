# Spike UW-00/c — better-sqlite3 en Node 26

Código desechable. Resultado y decisión en `docs/decisions/0003-sqlite-driver-node26.md`.

```sh
fnm use 26
pnpm install   # proyecto aislado: tiene su propio pnpm-workspace.yaml
pnpm spike     # node spike.ts
```

Salida esperada: `journal_mode=wal`, claim atómico (el segundo falla), rollback ante excepción y transacción con `drizzle-orm/better-sqlite3`.
