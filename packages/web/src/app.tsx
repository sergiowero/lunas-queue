import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { initTheme } from "./lib/theme.ts";
import type { createAppRouter } from "./router.tsx";

export function App({
  router,
  queryClient,
}: {
  router: ReturnType<typeof createAppRouter>;
  queryClient: QueryClient;
}) {
  // Antes de pintar: confirma en <html> el tema que ya puso el script de index.html.
  useLayoutEffect(initTheme, []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
