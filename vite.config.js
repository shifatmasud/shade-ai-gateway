import { defineConfig } from "vite"

export default defineConfig({
  root: "dashboard",
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
})
