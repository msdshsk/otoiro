import { defineConfig } from "vite";

// Single-file ES module for apps without a bundler (e.g. `withGlobalTauri` apps that load
// plain scripts). @tauri-apps/api is bundled in, so the file has no imports.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "otoiro-ui.js",
    },
    target: "es2022",
    minify: false,
    sourcemap: false,
    emptyOutDir: true,
  },
});
