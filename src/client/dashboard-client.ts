import type { DashboardState, InstalledModel, Phase } from "../server/flm.ts";

function element<T extends HTMLElement>(id: string, type: { new(): T }): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error(`Missing element: ${id}`);
  return result;
}
const form = element("controls", HTMLFormElement);
const model = element("model", HTMLSelectElement);
const context = element("context", HTMLSelectElement);
const start = element("start", HTMLButtonElement);
const stop = element("stop", HTMLButtonElement);
const refresh = element("refresh", HTMLButtonElement);
const follow = element("follow", HTMLInputElement);
const logs = element("logs", HTMLPreElement);
const error = element("error", HTMLParagraphElement);
const labels: Record<Phase, string> = { stopped: "Stopped", starting: "Starting", ready: "Ready", stopping: "Stopping", failed: "Exited with error", external: "Port in use outside dashboard" };
let state: DashboardState | null = null;
let busy = false;
let connected = false;
let modelsLoaded = false;

function showError(message: string) { error.textContent = message; error.hidden = !message; }
function controls() {
  const running = state?.pid !== null && state?.pid !== undefined;
  const locked = busy || running || !connected || state?.phase === "external" || state?.phase === "starting" || state?.phase === "stopping";
  start.disabled = locked || !modelsLoaded;
  model.disabled = locked || !modelsLoaded;
  context.disabled = locked;
  refresh.disabled = busy || running;
  stop.disabled = busy || !connected || !running || state?.phase === "stopping";
}
function render(next: DashboardState) {
  state = next;
  connected = true;
  if (next.pid) {
    model.value = next.preload ?? "";
    context.value = next.contextLength === null ? "" : String(next.contextLength);
  }
  const status = element("status", HTMLSpanElement);
  status.textContent = labels[next.phase];
  status.dataset.phase = next.phase;
  element("process", HTMLSpanElement).textContent = next.pid ? `PID ${next.pid}${next.preload ? ` · preload ${next.preload}` : " · no preload"}` : "No managed process";
  element("storage", HTMLParagraphElement).textContent = `Model storage: ${next.modelPath}`;
  const command = element("command", HTMLParagraphElement);
  command.hidden = !next.command.length;
  command.textContent = next.command.join(" ");
  const output = next.logs || "Start the server to see its output here.";
  if (logs.textContent !== output) {
    logs.textContent = output;
    if (follow.checked) logs.scrollTop = logs.scrollHeight;
  }
  controls();
}
async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
async function loadModels() {
  try {
    const data: { models: InstalledModel[] } = await request("/api/models");
    const selected = model.value;
    model.replaceChildren(new Option("No preload · load on first API request", ""),
      ...data.models.map(item => new Option(`${item.tag}${item.vision ? " · vision" : ""}`, item.tag)));
    if (data.models.some(item => item.tag === selected)) model.value = selected;
    if (state?.pid) model.value = state.preload ?? "";
    modelsLoaded = true;
    showError("");
  } catch (cause) { showError(String(cause)); }
  controls();
}
async function poll() {
  try { render(await request("/api/state")); }
  catch {
    connected = false;
    const status = element("status", HTMLSpanElement);
    status.textContent = "Dashboard disconnected";
    delete status.dataset.phase;
    controls();
  }
}
async function act(path: string, body?: object) {
  busy = true;
  showError("");
  controls();
  try {
    render(await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  } catch (cause) { showError(cause instanceof Error ? cause.message : String(cause)); }
  finally { busy = false; await poll(); controls(); }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  void act("/api/start", { model: model.value, contextLength: context.value ? Number(context.value) : null });
});
stop.addEventListener("click", () => { void act("/api/stop"); });
refresh.addEventListener("click", () => { void loadModels(); });
logs.addEventListener("scroll", () => { follow.checked = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 24; });
follow.addEventListener("change", () => { if (follow.checked) logs.scrollTop = logs.scrollHeight; });

await Promise.all([loadModels(), poll()]);
// One in-flight poll at a time; retain logs while the dashboard is hidden.
while (true) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (!document.hidden) await poll();
}
