// Build del front end (UW-21): lo sirve packages/server como estáticos. En desarrollo, `pnpm dev`
// levanta Vite y manda /api al servidor de LunasQ (LUNASQ_API, por defecto el puerto 4310).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // dist/ también recibe las declaraciones de `tsc -b`; el build va en su propia carpeta.
  build: { outDir: "dist/app", emptyOutDir: true },
  server: {
    proxy: { "/api": process.env.LUNASQ_API ?? "http://localhost:4310" },
  },
});
