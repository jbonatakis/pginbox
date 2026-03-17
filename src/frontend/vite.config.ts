import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const fromConfig = (relativePath: string): string =>
  decodeURIComponent(new URL(relativePath, import.meta.url).pathname);

export default defineConfig({
  plugins: [
    svelte({
      hot: false, // avoid svelte-hmr resolution (plugin 6 + Svelte 5)
    }),
  ],
  root: fromConfig("."),
  resolve: {
    alias: {
      shared: fromConfig("../shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
