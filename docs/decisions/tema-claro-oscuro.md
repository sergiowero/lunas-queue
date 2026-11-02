# Light and dark theme in the front end

- Status: accepted
- Date: 2026-10-30
- Code: `packages/web/src/index.css`, `packages/web/src/lib/theme.ts`, `packages/web/src/components/theme-toggle.tsx`, `packages/web/src/components/layout.tsx`, `packages/web/index.html`, `packages/web/src/app.tsx`

## Context

The front end only had shadcn/ui's light theme. A dark theme was requested with a selector in the top‑right corner, with moon and sun icons that swap on click, without new dependencies.

## Decision

- **Tokens, not per‑component colors.** `index.css` defines the color tokens in `@theme` (light) and redefines them in `.dark` with shadcn/ui's dark values, plus `color-scheme: dark` for native controls. The components already used only tokens (`bg-background`, `text-foreground`, `border-border`…), so they change on their own. `@custom-variant dark` makes `dark:` depend on the class and not on `prefers-color-scheme`. A test requires every light token to have its dark pair.
- **Text on destructive.** shadcn/ui's dark red is light and the `text-white` of `Badge` and `Button`'s destructive variants was at 2.9:1. `--color-destructive-foreground` is added (white in light, almost black in dark) and those variants use it. A test computes the contrast from the tokens' `oklch` values and requires AA's 4.5:1 in both themes.
- **The `dark` class on `<html>` is the effective theme.** `lib/theme.ts` reads it with `useSyncExternalStore` and changes it with `setTheme`, so the effective theme and the class cannot diverge. There is no React context or duplicated state.
- **Resolution.** The preference saved in `localStorage` (`lunasq:theme`, `"light"` or `"dark"`) if valid; otherwise `prefers-color-scheme`; otherwise light. An invalid value, a `localStorage` that throws or an environment without `matchMedia` fall to the next step without breaking the UI. On load only the resolved theme is applied; it is saved only when the person uses the selector, so someone who follows the system is not pinned.
- **No flash.** An inline script in `index.html`'s `<head>` repeats the resolution and sets the class before React mounts. `App` applies the theme again in a `useLayoutEffect`, before painting. The script and `lib/theme.ts` share rule and key; a test runs the script and checks that they match.
- **Selector.** `ThemeToggle` is a `<button>` at the end of the header (the action group's `ml-auto` is carried by the Nueva tarea button), with an `aria-label` of the action («Cambiar a tema oscuro» / «Cambiar a tema claro») and the inline SVG icon with `aria-hidden`: moon in light and sun in dark, that is, the theme it would switch to.
- **Switch animation.** `setTheme(theme, origin)` uses the View Transitions API to reveal the new theme with a circle that grows from the button's center (`clip-path` on `::view-transition-new(root)`, 480 ms; center and radius in viewport percentages because Brave does not respect `px` there and the circle came out from the top to the center), the same effect as moonlight-task-queue's web-ui. Without View Transitions the temporary class `theme-transition` is applied, which fades colors for 300 ms. If the theme does not change or there is `prefers-reduced-motion`, it is applied directly. `flushSync` leaves the button's icon updated inside the capture.

## Discarded

- Following `prefers-color-scheme` changes live: it was not requested and adds a listener for little value.
- A theme or icon library: the scope fits in one module and two SVGs.
