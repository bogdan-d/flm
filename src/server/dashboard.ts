import page from "../client/dashboard.html";
import modelsPage from "../client/models.html";
import { ControlError, FlmServer, parseStartOptions } from "./flm.ts";
import { CatalogError } from "./model-catalog.ts";

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new ControlError("Expected JSON.", 400);
  const body = await request.text();
  if (body.length > 4096) throw new ControlError("Request too large.", 413);
  try { return JSON.parse(body); } catch { throw new ControlError("Invalid JSON.", 400); }
}

export function startDashboard(flm: FlmServer, port = 9098) {
  let closing = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port, maxRequestBodySize: 4096, idleTimeout: 30, development: false,
    routes: { "/": page, "/models": modelsPage },
    async fetch(request, server) {
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const site = request.headers.get("Sec-Fetch-Site");
      const allowed = hosts.includes(request.headers.get("Host") ?? "") &&
        (site === null || site === "none" || site === "same-origin") &&
        (request.method === "GET" || hosts.some(host => request.headers.get("Origin") === `http://${host}`));
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
      if (!allowed) return json({ error: "Forbidden" }, 403);
      if (closing) return json({ error: "Dashboard is shutting down." }, 503);
      const url = new URL(request.url);
      const path = url.pathname;
      try {
        if (request.method === "GET" && path === "/api/state") return json(await flm.state());
        if (request.method === "GET" && path === "/api/models") return json({ models: await flm.models() });
        if (request.method === "GET" && path === "/api/catalog") return json({ models: await flm.catalog.list(), modelPath: flm.modelPath });
        if (request.method === "GET" && path === "/api/model-context") return json(await flm.catalog.context(url.searchParams.get("model") ?? ""));
        if (request.method === "GET" && path === "/api/download") return json(flm.downloads.snapshot());
        if (request.method === "POST" && path === "/api/pull") {
          const body = await readJson(request);
          if (typeof body !== "object" || body === null || !("model" in body) || typeof body.model !== "string") throw new CatalogError("Choose a catalog model.", 400);
          await flm.downloads.start(body.model);
          return json(flm.downloads.snapshot());
        }
        if (request.method === "POST" && path === "/api/cancel-pull") {
          await flm.downloads.cancel();
          return json(flm.downloads.snapshot());
        }
        if (request.method === "POST" && path === "/api/start") {
          await flm.start(parseStartOptions(await readJson(request)));
          return json(await flm.state());
        }
        if (request.method === "POST" && path === "/api/stop") {
          await flm.stop();
          return json(await flm.state());
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof ControlError || error instanceof CatalogError ? error.status : 500);
      }
    },
  });
  return {
    server,
    async close() {
      closing = true;
      try { await flm.close(); } finally { await server.stop(true); }
    },
  };
}
