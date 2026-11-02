# Repo in English and an ES/EN language selector in the UI

- Status: accepted
- Date: 2026-11-02
- Code: `packages/web/src/lib/i18n.ts`, `packages/web/src/lib/dictionary/` (`es.ts`, `en.ts`, `index.ts`), `packages/web/src/lib/error-text.ts`, `packages/web/src/components/language-toggle.tsx`, `packages/web/index.html`, `packages/web/src/lib/format.ts`

## Context

The repo was written in Spanish: comments, tests, docs, ADRs, skills, agents and the messages of the API, the MCP and the CLI. The UI was Spanish only. The project is opened to people who do not read Spanish, while its main user prefers the UI in Spanish.

## Decision

- **The repo is written in English.** Code comments, JSDoc, test names, docs, ADRs, `AGENTS.md`, `README.md`, the skills and agents in `assets/`, and the messages of the HTTP API, the MCP and the CLI. File names, ADR names, error codes, event names, localStorage keys and the persisted data do not change.
- **The UI is bilingual, Spanish by default.** A button at the top right of the header, next to the theme toggle, switches between Spanish and English. It shows the current language ("ES" or "EN") with an outline flag (Mexico for ES, USA for EN).
- **No i18n library.** The texts live in two typed dictionaries, `packages/web/src/lib/dictionary/es.ts` and `en.ts`, with `es.ts` defining the shape. A test requires both to have the same keys, so a new UI text goes into both. The code reads them through `lib/i18n.ts`.
- **`<html lang>` is the source of truth**, as the theme class is for the theme (see [tema-claro-oscuro](tema-claro-oscuro.md)). `lib/i18n.ts` reads it with `useSyncExternalStore` and changes it with `setLanguage`, so the effective language and the attribute cannot diverge. An inline script in `index.html` resolves the language before React mounts, so there is no flash of the wrong language.
- **Resolution.** The preference stored in `localStorage` under `lunasq:lang` (`"es"` or `"en"`) if valid; otherwise Spanish. The browser's language is not consulted. An invalid value or a `localStorage` that throws falls back to Spanish without breaking the UI. The preference is saved only when the person uses the button.
- **Dates and numbers** follow the language (`lib/format.ts`).
- **API errors are translated in the UI by code.** The API answers `{ error, message }` with an English `message`. The UI shows the dictionary's text for `error` through `apiErrors` (`lib/error-text.ts`) and falls back to the English `message` when the code has no entry, so codes whose message carries variable details (field paths, ids, git output) keep showing the server's text. `apiErrors` covers the codes whose message has no variable detail: `invalid_json`, `invalid_input`, `not_found`, `forbidden_origin`, `evidence_not_found`, `no_pane`, `focus_unavailable`, `agent_gone`, `answering_unavailable`, `not_blocked` and `has_tasks`.
- **Not translated.** Data written by people or agents (intents, specs, questions, handoffs, evidence files) stays as written. `lunasq/tasks/*.md`, the evidence archives of tasks already delivered, are historical and are left untouched. The PNG diagrams in `docs/images` keep their Spanish text.

## Consequences

- A new UI text needs an entry in both dictionaries; the key‑parity test fails otherwise.
- A new API error code that should be translated needs an entry in `apiErrors`; without it the UI shows the English message, which is still correct.
- Tests that assert on UI text run against the default (Spanish) dictionary, unless they set the language explicitly.
- The agents and skills read English instructions; the human‑facing UI language does not affect them.
