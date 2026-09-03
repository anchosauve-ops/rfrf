import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@core": fileURLToPath(new URL("./src/core", import.meta.url)) },
  },
  build: { outDir: "dist/web", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
