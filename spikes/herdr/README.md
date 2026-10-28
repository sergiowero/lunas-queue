# Spike UW-00/d — herdr 0.9.5 (protocol 22)

Código desechable. Resultado y decisión en `docs/decisions/0004-herdr-version-y-cli.md`.

Todo corre en una sesión aislada (`lunasq-spike`), nunca en la sesión por defecto:

```sh
herdr --session lunasq-spike server &          # servidor headless aislado
source step.sh                                  # step <nombre> <args>: corre herdr y guarda outputs/<nombre>.{txt,json,stderr}
node subscribe.ts <socket> outputs/events.ndjson ['[{"type":"pane.agent_status_changed","pane_id":"w2:p2"}]'] [--slow=<ms>]
node flood.ts <socket> <workspace_id> <n> <lote>   # ráfaga de workspace.report_metadata para provocar backpressure
herdr --session lunasq-spike server stop && herdr session delete lunasq-spike
```

`outputs/` guarda la salida real de cada paso del flujo del dispatcher (01–22), el schema de la API (`api-schema.json`), la skill oficial (`herdr-skill.md`) y los eventos capturados (`events*.ndjson`). El socket de la sesión es `~/.config/herdr/sessions/lunasq-spike/herdr.sock`.
