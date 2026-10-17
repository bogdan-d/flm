import { afterEach, expect, test } from "bun:test";
import { FlmServer, portIsOccupied } from "../src/server/flm.ts";
import { startDashboard } from "../src/server/dashboard.ts";

const dashboards: ReturnType<typeof startDashboard>[] = [];
const controllers: FlmServer[] = [];
afterEach(async () => {
  await Promise.all(dashboards.splice(0).map(dashboard => dashboard.close()));
  await Promise.all(controllers.splice(0).map(controller => controller.close()));
  delete process.env.TEST_IGNORE_TERM;
  delete process.env.TEST_LOG_FLOOD;
  delete process.env.TEST_EXIT;
});

function freePort() {
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  return port;
}
function controller() {
  const control = new FlmServer({ port: freePort(), executable: [process.execPath, `${import.meta.dir}/fixtures/process.ts`], stopTimeout: 100 });
  controllers.push(control);
  return control;
}
async function ready(control: FlmServer) {
  for (let i = 0; i < 100; i++) {
    const state = await control.state();
    if (state.phase === "ready") return state;
    await Bun.sleep(20);
  }
  throw new Error("Child never became ready");
}

test("rejects concurrent starts, captures both streams, and releases the owned process and port", async () => {
  const control = controller();
  const started = control.start({ model: "qwen3.5:9b", contextLength: 262144 });
  await expect(control.start({ model: "", contextLength: null })).rejects.toThrow("already running");
  await started;
  const state = await ready(control);
  expect(state.preload).toBe("qwen3.5:9b");
  expect(state.logs).toContain("child stdout");
  expect(state.logs).toContain("child stderr");
  expect(state.command.slice(-2)).toEqual(["--ctx-len", "262144"]);
  const pid = state.pid;
  if (pid === null) throw new Error("Ready without a managed process");
  await control.stop();
  expect((await control.state()).phase).toBe("stopped");
  expect(portIsOccupied(control.port)).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow();
  await control.start({ model: "", contextLength: null });
  const restarted = await ready(control);
  expect(restarted.preload).toBeNull();
  expect(restarted.command).not.toContain("--ctx-len");
  expect(restarted.command).not.toContain("qwen3.5:9b");
});

test("refuses an occupied port and never stops the external service", async () => {
  const external = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("external") });
  const control = new FlmServer({ port: external.port });
  controllers.push(control);
  try {
    expect((await control.state()).phase).toBe("external");
    await expect(control.start({ model: "", contextLength: null })).rejects.toThrow("already in use");
    await control.close();
    expect(await (await fetch(external.url)).text()).toBe("external");
  } finally { await external.stop(true); }
});

test("port checks do not open client connections to the existing service", async () => {
  let connections = 0;
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    open(socket) { connections++; socket.end(); }, data() {},
  } });
  try {
    expect(portIsOccupied(listener.port)).toBe(true);
    await Bun.sleep(30);
    expect(connections).toBe(0);
  } finally { listener.stop(true); }
});

test("shutdown escalates for a child ignoring SIGTERM and bounds noisy output", async () => {
  process.env.TEST_IGNORE_TERM = "1";
  process.env.TEST_LOG_FLOOD = "1";
  const control = controller();
  await control.start({ model: "", contextLength: null });
  const state = await ready(control);
  expect(state.logs.length).toBeLessThanOrEqual(131072);
  await control.close();
  expect((await control.state()).pid).toBeNull();
  expect(portIsOccupied(control.port)).toBe(false);
  await expect(control.start({ model: "", contextLength: null })).rejects.toThrow();
});

test("unexpected exit preserves diagnostics and clears process ownership", async () => {
  process.env.TEST_EXIT = "1";
  const control = controller();
  await control.start({ model: "", contextLength: null });
  for (let i = 0; i < 100 && (await control.state()).pid !== null; i++) await Bun.sleep(20);
  const state = await control.state();
  expect(state.phase).toBe("failed");
  expect(state.pid).toBeNull();
  expect(state.logs).toContain("child stderr");
  expect(state.logs).toContain("exited (7)");
});

test("shutdown during startup does not leave an orphan", async () => {
  const control = controller();
  const start = control.start({ model: "", contextLength: null });
  await control.close();
  await start;
  expect((await control.state()).phase).toBe("stopped");
  expect((await control.state()).pid).toBeNull();
  expect(portIsOccupied(control.port)).toBe(false);
});

test("control API rejects cross-origin requests and invalid input before spawning", async () => {
  const control = controller();
  const dashboard = startDashboard(control, 0);
  dashboards.push(dashboard);
  const url = dashboard.server.url;
  const send = (body: unknown, headers: HeadersInit = {}) => fetch(new URL("/api/start", url), {
    method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const options = { model: "", contextLength: null };
  expect((await send(options, { Origin: "https://example.com" })).status).toBe(403);
  expect((await send(options, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await fetch(new URL("/api/state", url), { headers: { Host: "evil.example" } })).status).toBe(403);
  expect((await send({ ...options, contextLength: "262144" })).status).toBe(400);
  expect((await send({ ...options, model: "not-downloaded; touch /tmp/no" })).status).toBe(400);
  expect((await control.state()).pid).toBeNull();
  expect((await send(options)).status).toBe(200);
  await ready(control);
  await dashboard.close();
  dashboards.splice(dashboards.indexOf(dashboard), 1);
  expect(portIsOccupied(control.port)).toBe(false);
});
