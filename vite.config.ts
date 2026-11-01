import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri 会以固定端口跑 dev server，这里保持 strictPort 避免端口漂移
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // 两个入口：主界面 index.html、灵动岛胶囊 island.html
    rollupOptions: {
      input: {
        main: "index.html",
        island: "island.html",
      },
    },
  },
});
