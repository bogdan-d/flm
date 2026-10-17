import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/server/dashboard.ts";
import { FlmServer } from "../src/server/flm.ts";
import { parseCatalog } from "../src/server/model-catalog.ts";
import { buildPiProvider, PiConfigSync, type PiConfigPreview } from "../src/server/pi-config.ts";

const directories: string[] = [];
const controllers: FlmServer[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(control => control.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "flm-pi-config-"));
  directories.push(directory);
  const control = new FlmServer({ executable: [process.execPath, `${import.meta.dir}/fixtures/process.ts`] });
  controllers.push(control);
  const path = join(directory, "models.json");
  return { directory, path, control, sync: new PiConfigSync(control, path) };
}

test("exports downloaded chat models only, with per-model inputs, thinking, and conservative context budgets", () => {
  // Catalog fields already interpreted by this project, not a simulated inference API.
  const entry = { model: "qwen3:0.6b", installed: true, default_context_length: 32768,
    details: { think: false, think_toggleable: true } };
  const catalog = parseCatalog({ models: [
    entry,
    { ...entry, model: "qwen3.5:9b", vlm: true, details: { think: true, think_toggleable: false } },
    { ...entry, model: "qwen3vl-flash:4b", vlm: true, details: {}, label: ["single-turn"] },
    { ...entry, model: "missing:1b", installed: false },
    { ...entry, model: "whisper-v3:turbo", details: { family: "whisper-v3" } },
    { ...entry, model: "embed-gemma:300m", label: ["embeddings"] },
  ] }, null);
  const provider = buildPiProvider(catalog, "http://127.0.0.1:12345/v1", 8192);
  expect(provider.baseUrl).toBe("http://127.0.0.1:12345/v1");
  expect(provider.models.map(model => model.id)).toEqual(["qwen3:0.6b", "qwen3.5:9b", "qwen3vl-flash:4b"]);
  expect(provider.models[0]).toMatchObject({ input: ["text"], reasoning: true, contextWindow: 8192, maxTokens: 2048,
    samplingParams: { think: true }, samplingParamsByThinkingLevel: { off: { think: false } } });
  expect(provider.models[1]).toMatchObject({ input: ["text", "image"], reasoning: true });
  expect(provider.models[1]).not.toHaveProperty("samplingParams");
  expect(provider.models[2]).toMatchObject({ reasoning: false, contextWindow: 1024, maxTokens: 256 });
  expect(buildPiProvider(catalog, provider.baseUrl, 262144).models[0]?.contextWindow).toBe(32768);
  expect(buildPiProvider(catalog, provider.baseUrl, null).models[0]?.contextWindow).toBe(32768);
  expect(() => buildPiProvider(catalog.map(model => ({ ...model, installed: false })), provider.baseUrl, null)).toThrow("No downloaded");
});

test("replaces only FLM, preserves unrelated config, and backs up exact original bytes with private permissions", async () => {
  const { directory, path, sync } = await setup();
  const original = '{ "providers": { "other": { "apiKey": "private-key", "models": [] }, "flm": { "custom": true } }, "extra": [1, 2] }\n';
  await Bun.write(path, original);
  const preview = await sync.preview();
  expect(preview.models).toEqual(["qwen3.5:9b"]);
  expect(JSON.stringify(preview)).not.toContain("private-key");
  expect(await readdir(directory)).toEqual(["models.json"]);
  const result = await sync.sync(preview.token);
  if (result.backupPath === null) throw new Error("Missing backup");
  expect(await Bun.file(result.backupPath).text()).toBe(original);
  expect((await lstat(result.backupPath)).mode & 0o777).toBe(0o600);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  const saved = await Bun.file(path).json();
  expect(saved.extra).toEqual([1, 2]);
  expect(saved.providers.other).toEqual({ apiKey: "private-key", models: [] });
  expect(saved.providers.flm.custom).toBeUndefined();
  expect(saved.providers.flm.models.map((model: { id: string }) => model.id)).toEqual(["qwen3.5:9b"]);
  await sync.sync((await sync.preview()).token);
  expect((await Bun.file(path).json()).providers.flm.models).toHaveLength(1);
  expect((await readdir(directory)).some(name => name.endsWith(".tmp"))).toBe(false);
});

test("refuses invalid config and symlinks without changing or backing up the target", async () => {
  const { directory, path, control, sync } = await setup();
  for (const invalid of ["{ broken", "[]", '{"providers":[]}', '{"providers":null}']) {
    await Bun.write(path, invalid);
    await expect(sync.preview()).rejects.toThrow();
    await expect(sync.sync("0".repeat(64))).rejects.toThrow();
    expect(await Bun.file(path).text()).toBe(invalid);
    expect(await readdir(directory)).toEqual(["models.json"]);
  }
  const link = join(directory, "linked.json");
  await symlink(path, link);
  const linkedConfig = new PiConfigSync(control, link);
  await expect(linkedConfig.preview()).rejects.toThrow("regular file");
  await expect(linkedConfig.sync("0".repeat(64))).rejects.toThrow("regular file");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
});

test("rejects stale confirmations and overlapping writes without overwriting newer edits", async () => {
  const { directory, path, sync } = await setup();
  await Bun.write(path, "{}");
  const preview = await sync.preview();
  const edited = '{"providers":{"new-provider":{"apiKey":"new-key"}}}';
  await Bun.write(path, edited);
  await expect(sync.sync(preview.token)).rejects.toThrow("changed");
  expect(await Bun.file(path).text()).toBe(edited);
  expect(await readdir(directory)).toEqual(["models.json"]);
  const fresh = await sync.preview();
  const first = sync.sync(fresh.token);
  await expect(sync.sync(fresh.token)).rejects.toThrow("already in progress");
  await first;
  expect((await readdir(directory)).filter(name => name.endsWith(".bak"))).toHaveLength(1);
  expect((await Bun.file(path).json()).providers["new-provider"]).toEqual({ apiKey: "new-key" });
});

test("Pi sync routes require same-origin confirmation and can create a missing config directory", async () => {
  const { directory, control } = await setup();
  const path = join(directory, "new-agent", "models.json");
  const dashboard = startDashboard(control, 0, new PiConfigSync(control, path));
  try {
    const url = new URL("/api/pi-config", dashboard.server.url);
    const post = (body: unknown, headers: HeadersInit = {}) => fetch(url, {
      method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const preview: PiConfigPreview = await (await fetch(url)).json();
    expect(preview.path).toBe(path);
    expect(await readdir(directory)).toEqual([]);
    expect((await post({ token: preview.token }, { Origin: "https://example.com" })).status).toBe(403);
    expect((await post({ token: preview.token }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post({ path: "/tmp/not-allowed" })).status).toBe(400);
    expect((await post({ token: "0".repeat(64) })).status).toBe(409);
    expect(await readdir(directory)).toEqual([]);
    const response = await post({ token: preview.token });
    expect(response.status).toBe(200);
    expect((await response.json()).backupPath).toBeNull();
    expect((await Bun.file(path).json()).providers.flm.models.map((model: { id: string }) => model.id)).toEqual(["qwen3.5:9b"]);
  } finally { await dashboard.close(); }
});
