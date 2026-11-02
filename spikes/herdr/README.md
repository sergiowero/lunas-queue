# Spike UW-00/d — herdr 0.9.5 (protocol 22)

Throwaway code. Result and decision in `docs/decisions/0004-herdr-version-y-cli.md`.

Everything runs in an isolated session (`lunasq-spike`), never in the default session:

```sh
herdr --session lunasq-spike server &          # isolated headless server
source step.sh                                  # step <name> <args>: runs herdr and saves outputs/<name>.{txt,json,stderr}
node subscribe.ts <socket> outputs/events.ndjson ['[{"type":"pane.agent_status_changed","pane_id":"w2:p2"}]'] [--slow=<ms>]
node flood.ts <socket> <workspace_id> <n> <batch>   # burst of workspace.report_metadata to provoke backpressure
herdr --session lunasq-spike server stop && herdr session delete lunasq-spike
```

`outputs/` holds the real output of each step of the dispatcher flow (01–22), the API schema (`api-schema.json`) and the captured events (`events*.ndjson`). The session's socket is `~/.config/herdr/sessions/lunasq-spike/herdr.sock`.
