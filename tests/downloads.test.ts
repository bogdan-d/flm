import { afterEach, expect, test } from "bun:test";
import { FlmServer } from "../src/server/flm.ts";
import { startDashboard } from "../src/server/dashboard.ts";

const controllers: FlmServer[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(control => control.close()));
  delete process.env.TEST_EXIT;
  delete process.env.TEST_IGNORE_TERM;
  delete process.env.TEST_LOG_FLOOD;
});
function controller() {
  const control = new FlmServer({ executable: [process.execPath, `${import.meta.dir}/fixtures/process.ts`], stopTimeout: 100 });
  controllers.push(control);
  return control;
}
async function finished(control: FlmServer) {
  for (let i = 0; i < 100; i++) {
    const state = control.downloads.snapshot();
    if (!state.pid && state.phase !== "starting") return state;
    await Bun.sleep(20);
  }
  throw new Error("Download child did not exit");
}

test("only catalog missing models can be pulled and overlapping pulls are rejected", async () => {
  const control = controller();
  await expect(control.downloads.start("qwen3.5:9b")).rejects.toThrow("already installed");
  await expect(control.downloads.start("not-listed; touch /tmp/no")).rejects.toThrow("catalog");
  const starting = control.downloads.start("qwen3:0.6b");
  await expect(control.downloads.start("qwen3:0.6b")).rejects.toThrow("already active");
  await starting;
  const state = await finished(control);
  expect(state.phase).toBe("completed");
  expect(state.command.slice(-2)).toEqual(["pull", "qwen3:0.6b"]);
  expect(state.logs).toContain("42.3%");
  expect(state.logs).toContain("pull stderr");
  expect(state.logs).not.toContain("\x1b");
});

test("cancel and dashboard shutdown reap a resistant pull and keep bounded diagnostics", async () => {
  process.env.TEST_IGNORE_TERM = "1";
  process.env.TEST_LOG_FLOOD = "1";
  const control = controller();
  await control.downloads.start("qwen3:0.6b");
  await Bun.sleep(50);
  const pid = control.downloads.snapshot().pid;
  if (pid === null) throw new Error("Missing child");
  await control.downloads.cancel();
  expect(control.downloads.snapshot().phase).toBe("cancelled");
  expect(control.downloads.snapshot().logs.length).toBeLessThanOrEqual(131072);
  expect(() => process.kill(pid, 0)).toThrow();
  await control.downloads.start("qwen3:0.6b");
  await control.close();
  expect(control.downloads.snapshot().pid).toBeNull();
  expect(control.downloads.snapshot().phase).toBe("cancelled");
});

test("nonzero pull exit is a failed download, not successful installation", async () => {
  process.env.TEST_EXIT = "1";
  const control = controller();
  await control.downloads.start("qwen3:0.6b");
  const state = await finished(control);
  expect(state.phase).toBe("failed");
  expect(state.logs).toContain("failed (7)");
});

test("pull routes enforce browser-origin policy and validate catalog choices", async () => {
  const control = controller();
  const dashboard = startDashboard(control, 0);
  try {
    const url = dashboard.server.url;
    const post = (model: unknown, origin = url.origin) => fetch(new URL("/api/pull", url), {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ model }),
    });
    expect((await post("qwen3:0.6b", "https://example.com")).status).toBe(403);
    expect((await post(["qwen3:0.6b"])).status).toBe(400);
    expect((await post("unknown:1b")).status).toBe(400);
    expect((await post("qwen3:0.6b")).status).toBe(200);
    expect((await fetch(new URL("/api/cancel-pull", url), { method: "POST", headers: { Origin: "https://example.com" } })).status).toBe(403);
  } finally { await dashboard.close(); }
  expect(control.downloads.snapshot().pid).toBeNull();
});
