import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(
        new URL("./mobius/packages/web-core/src", import.meta.url),
      ),
    },
  },
  server: {
    allowedHosts: [".trycloudflare.com"],
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});
