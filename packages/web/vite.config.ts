// Front end build: packages/server serves it as statics. In development, `pnpm dev`
// starts Vite and sends /api to the LunasQ server (LUNASQ_API, port 4310 by default).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // dist/ also receives the declarations from `tsc -b`; the build goes in its own folder.
  build: { outDir: "dist/app", emptyOutDir: true },
  server: {
    proxy: { "/api": process.env.LUNASQ_API ?? "http://localhost:4310" },
  },
});
