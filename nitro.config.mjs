import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  preset: "vercel",
  modules: ["workflow/nitro"],
  workflow: { runtime: "nodejs22.x" },
  renderer: { template: "./dist/index.html" },
  publicAssets: [{ dir: "./dist", baseURL: "/" }],
  routes: {
    "/api/**": { handler: "./server/handler.mjs", format: "node" },
  },
  routeRules: {
    "/api/**": { headers: { "Cache-Control": "private, no-store" } },
  },
  vercel: { entryFormat: "node", functions: { runtime: "nodejs22.x", maxDuration: 300, regions: ["sin1"] } },
});
