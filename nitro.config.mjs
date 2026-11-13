import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  preset: "vercel",
  modules: ["workflow/nitro"],
  workflow: { runtime: "nodejs22.x" },
  renderer: { template: "./dist/index.html" },
  publicAssets: [
    // Vite names every file in assets/ after its contents, so a browser can
    // keep each one for good instead of asking the CDN again on every visit.
    { dir: "./dist/assets", baseURL: "/assets", maxAge: 31536000 },
    { dir: "./dist", baseURL: "/" },
  ],
  routes: {
    "/api/**": { handler: "./server/handler.mjs", format: "node" },
  },
  routeRules: {
    "/api/**": { headers: { "Cache-Control": "private, no-store" } },
  },
  vercel: {
    entryFormat: "node",
    functions: { runtime: "nodejs22.x", maxDuration: 300, regions: ["sin1"] },
    // The app's own pages are the same static shell. Serve it from the CDN
    // rather than waking the function, which stays as the fallback renderer.
    config: { routes: [{ src: "^/(?:outfits|shopping)/?$", dest: "/index.html" }] },
  },
});
