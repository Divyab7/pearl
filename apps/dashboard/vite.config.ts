import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PEARL_API lets a second dev server point at another backend (e.g. a UI preview harness on another port).
// /demo-api is the demo workspaces' sample-data app, mounted by the same backend.
const target = process.env.PEARL_API ?? "http://localhost:8080";

// https://vite.dev/config/server-options#server-proxy
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PEARL_UI_PORT ?? 5173),
    proxy: { "/api": target, "/demo-api": target },
  },
  // `vite preview` (production build) talks to the same backend
  preview: {
    port: Number(process.env.PEARL_PREVIEW_PORT ?? 4317),
    proxy: { "/api": target, "/demo-api": target },
  },
});
