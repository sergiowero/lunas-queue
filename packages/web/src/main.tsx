import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ApiError } from "./lib/api.ts";
import { createAppRouter } from "./router.tsx";
import "./index.css";

// Las actualizaciones llegan por SSE (lib/live.ts); el refresco periódico solo cubre un stream
// caído. Ver ADR uw-21-front-end.
const REFRESH_MS = 30_000;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: REFRESH_MS,
      staleTime: 1000,
      // Un 4xx no cambia al reintentar: «la tarea no existe» se muestra de inmediato.
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status < 500) && failures < 3,
    },
  },
});
const router = createAppRouter({ queryClient });

const root = document.getElementById("root");
if (!root) throw new Error("falta #root en index.html");
createRoot(root).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
