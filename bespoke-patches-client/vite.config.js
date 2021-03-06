import reactRefresh from "@vitejs/plugin-react-refresh";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";

// https://vitejs.dev/config/
export default defineConfig({
  // This changes the out put dir from dist to build
  // comment this out if that isn't relevant for your project
  build: {
    outDir: "build",
    sourcemap: true
  },
  plugins: [reactRefresh(), svgr()],
  server: {
    proxy: {
      "/graphql": "http://localhost:8000",
      "/files": "http://localhost:8000",
    },
  },
});
