import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { initLanguage } from "./lib/i18n.ts";
import { TabFiltersProvider } from "./lib/tab-filters.tsx";
import { initTheme } from "./lib/theme.ts";
import type { createAppRouter } from "./router.tsx";

export function App({
  router,
  queryClient,
}: {
  router: ReturnType<typeof createAppRouter>;
  queryClient: QueryClient;
}) {
  // Before painting: confirms on <html> the theme the index.html script already set.
  useLayoutEffect(initTheme, []);
  // Same for the language: the inline script already set `lang` and this only confirms it.
  useLayoutEffect(initLanguage, []);
  return (
    <QueryClientProvider client={queryClient}>
      <TabFiltersProvider>
        <RouterProvider router={router} />
      </TabFiltersProvider>
    </QueryClientProvider>
  );
}
