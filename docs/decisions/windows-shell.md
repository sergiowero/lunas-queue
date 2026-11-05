# Windows shell for `lunasq install` and `doctor`

- Status: accepted
- Date: 2026-11-05
- Code: `packages/adapters/src/process/real.ts`

## Context

`ShellProcessRunner` spawned `/bin/sh`, so on Windows every command failed with `spawn /bin/sh ENOENT` and `pnpm lunasq install` and `pnpm lunasq doctor` stopped at their first check. The checks are written for `sh` (`command -v`, exit code 127 for a missing command), and hooks and test gates are also `sh` commands.

## Decision

- **Git for Windows' `sh.exe` runs the commands.** LunasQ already needs git, so this adds no prerequisite. The runner asks `git --exec-path` and looks upwards for `bin/sh.exe` or `usr/bin/sh.exe`. It does not take `sh` or `bash` from the PATH: `sh` is usually not there, and `bash` may be `WindowsApps\bash.exe`, the WSL launcher, which would run the command inside a Linux distribution. Without git, the runner fails with `spawn_failed` and a message that says to install it.
- **Timeouts kill the process tree.** Windows has no process groups, so `process.kill(-pid)` does nothing there. The runner uses `taskkill /T /F` while the shell is alive. `detached` is off on Windows, where it means a new console, and `windowsHide` keeps consoles from flashing.
- **macOS and Linux do not change.**

## Consequences

- Scope: `install` and `doctor` in the repo through `pnpm lunasq <command>`. This does not declare `lunasq start` or the dispatcher supported on Windows. Still POSIX-only: `HerdrPaneRunner` (`/bin/sh` in `process/pane.ts`) and `defaultSocketPath` (`~/.config/herdr`, while herdr on Windows listens under `%APPDATA%\herdr`).
- A background child that outlives its shell on Windows loses the pipes but is not killed, because `taskkill /T` cannot reach it once the shell has exited.
- Commands run through MSYS, which rewrites POSIX-looking arguments passed to native programs. The `install` and `doctor` commands pass none.
- The test suite is not portable to Windows and CI does not run there: many tests assume `/bin/sh`, POSIX paths or `HOME`.
