import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "script-defer",
      includeAssets: ["in-progress.svg", "apple-touch-icon.png"],
      manifest: {
        name: "in-progress",
        short_name: "in-progress",
        description: "A local-first control plane for coding agents.",
        theme_color: "#0b0e14",
        background_color: "#0b0e14",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/apple-touch-icon.png",
            sizes: "180x180",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/in-progress.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/plugins\//],
        importScripts: ["/push-handler.js"],
        globPatterns: ["**/*.{js,css,html,svg,woff,woff2}"],
      },
    }),
  ],
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
