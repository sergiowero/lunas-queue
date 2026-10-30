import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import "./index.css";

// Refresco periódico mientras la invalidación por SSE llega con la bandeja (UW-27); ver
// ADR uw-21-front-end.
const REFRESH_MS = 3000;

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: REFRESH_MS, staleTime: 1000 } },
});
const router = createAppRouter({ queryClient });

const root = document.getElementById("root");
if (!root) throw new Error("falta #root en index.html");
createRoot(root).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
