import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const outputDir = path.resolve(".vercel/output");
const html = await readFile(path.resolve("dist/index.html"), "utf8");
assert(!html.includes("/src/main.jsx"), "The Vercel renderer must use built HTML");
assert.match(html, /src="\/assets\/index-[^"]+\.js"/, "Built JavaScript is missing from the SPA HTML");
assert.match(html, /href="\/assets\/index-[^"]+\.css"/, "Built CSS is missing from the SPA HTML");
for (const [, asset] of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) {
  assert((await stat(path.join(outputDir, "static", asset))).isFile(), `Missing deployed asset: ${asset}`);
}

// Test the actual deployed server with no source files or ancestor dependencies.
const isolatedDir = await mkdtemp(path.join(tmpdir(), "wardrobe-spa-package-"));
try {
  await cp(path.join(outputDir, "functions/__server.func"), isolatedDir, { recursive: true, dereference: true });
  await writeFile(path.join(isolatedDir, "expected.html"), html);
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { createServer, get } from "node:http";
    globalThis.fetch = async () => { throw new Error("External requests are forbidden during SPA verification"); };
    const { default: handler } = await import("./index.mjs");
    const expected = await readFile("expected.html", "utf8");
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      for (const route of ["/", "/shopping", "/outfits", "/shopping?view=saved"]) {
        const response = await new Promise((resolve, reject) => {
          get({ hostname: "127.0.0.1", port: server.address().port, path: route, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks).toString() }));
            res.on("error", reject);
          }).on("error", reject);
        });
        assert.equal(response.status, 200, route);
        assert(response.type?.startsWith("text/html"), route);
        assert.equal(response.body, expected, route + " must return Vite's built HTML");
      }
      console.log("Vercel SPA verified: direct /shopping and /outfits requests return built HTML with deployed assets");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  `], {
    cwd: isolatedDir,
    env: { PATH: process.env.PATH, NODE_ENV: "production" },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(stdout);
} finally {
  await rm(isolatedDir, { recursive: true, force: true });
}
