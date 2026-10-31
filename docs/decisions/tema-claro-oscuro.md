# Tema claro y oscuro en el front end

- Estado: aceptada
- Fecha: 2026-10-30
- Código: `packages/web/src/index.css`, `packages/web/src/lib/theme.ts`, `packages/web/src/components/theme-toggle.tsx`, `packages/web/src/components/layout.tsx`, `packages/web/index.html`, `packages/web/src/app.tsx`

## Contexto

El front end solo tenía el tema claro de shadcn/ui. Se pidió un tema oscuro con un selector en la esquina superior derecha, con iconos de luna y sol que se intercambian al hacer click, sin dependencias nuevas.

## Decisión

- **Tokens, no colores por componente.** `index.css` define los tokens de color en `@theme` (claro) y los redefine en `.dark` con los valores oscuros de shadcn/ui, más `color-scheme: dark` para los controles nativos. Los componentes ya usaban solo tokens (`bg-background`, `text-foreground`, `border-border`…), así que cambian solos. `@custom-variant dark` hace que `dark:` dependa de la clase y no de `prefers-color-scheme`. Un test exige que cada token claro tenga su par oscuro.
- **Texto sobre destructivo.** El rojo oscuro de shadcn/ui es claro y el `text-white` de las variantes destructivas de `Badge` y `Button` quedaba en 2.9:1. Se agrega `--color-destructive-foreground` (blanco en claro, casi negro en oscuro) y esas variantes lo usan. Un test calcula el contraste desde los valores `oklch` de los tokens y exige el 4.5:1 de AA en ambos temas.
- **La clase `dark` de `<html>` es el tema efectivo.** `lib/theme.ts` la lee con `useSyncExternalStore` y la cambia con `setTheme`, así el tema efectivo y la clase no pueden divergir. No hay contexto de React ni estado duplicado.
- **Resolución.** La preferencia guardada en `localStorage` (`lunasq:theme`, `"light"` o `"dark"`) si es válida; si no, `prefers-color-scheme`; si no, claro. Un valor inválido, un `localStorage` que lanza error o un entorno sin `matchMedia` caen al siguiente paso sin romper la UI. Al cargar solo se aplica el tema resuelto; se guarda únicamente cuando la persona usa el selector, así quien sigue al sistema no queda fijado.
- **Sin destello.** Un script inline en el `<head>` de `index.html` repite la resolución y pone la clase antes de que React monte. `App` vuelve a aplicar el tema en un `useLayoutEffect`, antes de pintar. El script y `lib/theme.ts` comparten regla y clave; un test ejecuta el script y comprueba que coinciden.
- **Selector.** `ThemeToggle` es un `<button>` al final del header (`ml-auto`), con `aria-label` de la acción («Cambiar a tema oscuro» / «Cambiar a tema claro») y el icono SVG inline con `aria-hidden`: luna en claro y sol en oscuro, es decir, el tema al que se cambiaría.

## Descartado

- Seguir los cambios de `prefers-color-scheme` en caliente: no se pidió y añade un listener por poco valor.
- Una librería de temas o de iconos: el alcance cabe en un módulo y dos SVG.
