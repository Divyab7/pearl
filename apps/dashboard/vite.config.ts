import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/server-options#server-proxy
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PEARL_UI_PORT ?? 5173),
    // PEARL_API lets a second dev server point at another backend (e.g. a UI preview harness on another port)
    proxy: { "/api": process.env.PEARL_API ?? "http://localhost:8080" },
  },
});
