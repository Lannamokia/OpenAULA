import { defineConfig } from "vite";

export default defineConfig({
  // Tauri expects a fixed port; fail early if it is taken.
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
