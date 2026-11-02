# Spike UW-00/c — better-sqlite3 on Node 26

Throwaway code. Result and decision in `docs/decisions/0003-sqlite-driver-node26.md`.

```sh
fnm use 26
pnpm install   # isolated project: it has its own pnpm-workspace.yaml
pnpm spike     # node spike.ts
```

Expected output: `journal_mode=wal`, atomic claim (the second one fails), rollback on exception and a transaction with `drizzle-orm/better-sqlite3`.
