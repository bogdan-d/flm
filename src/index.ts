import { startDashboard } from "./server/dashboard.ts";
import { FlmServer } from "./server/flm.ts";

const port = Number(process.env.DASHBOARD_PORT ?? 9098);
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 52625) {
  throw new Error("DASHBOARD_PORT must be a valid port other than FLM's 52625.");
}
const dashboard = startDashboard(new FlmServer(), port);
console.log(`FLM dashboard: http://127.0.0.1:${dashboard.server.port}`);
console.log("Ctrl+C stops this dashboard and the FLM server it started.");

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try { await dashboard.close(); } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
