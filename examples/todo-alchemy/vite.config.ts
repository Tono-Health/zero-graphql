import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  // zero-cache calls ZERO_QUERY_URL / ZERO_MUTATE_URL as host.docker.internal.
  // Vite rejects that Host header unless it is listed here.
  server: { allowedHosts: ["host.docker.internal"] },
});
