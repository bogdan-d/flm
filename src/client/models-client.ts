import type { CatalogModel, ContextDetails } from "../server/model-catalog.ts";
import type { DownloadState } from "../server/downloads.ts";

function element<T extends HTMLElement>(id: string, type: { new(): T }): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error(`Missing element: ${id}`);
  return result;
}
const rows = element("models", HTMLTableSectionElement);
const search = element("search", HTMLInputElement);
const installed = element("installed", HTMLSelectElement);
const capability = element("capability", HTMLSelectElement);
const error = element("error", HTMLParagraphElement);
const refresh = element("refresh", HTMLButtonElement);
const inspect = element("inspect", HTMLButtonElement);
const cancel = element("cancel", HTMLButtonElement);
const logs = element("download-logs", HTMLPreElement);
const follow = element("follow", HTMLInputElement);
let detailsOpener: HTMLButtonElement | null = null;
let models: CatalogModel[] = [];
let modelPath = "";
let selected: CatalogModel | null = null;
let download: DownloadState | null = null;
let acting = false;
const contexts = new Map<string, ContextDetails>();
const contextErrors = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
const contextRows = new Map<string, HTMLTableCellElement>();
const downloadButtons = new Map<string, HTMLButtonElement>();
const capabilityNames: Record<string, string> = { "tool-calling": "Tools", "chat-transcription": "Chat transcription", "single-turn": "Single turn", "realtime-transcription": "Realtime transcription", embeddings: "Embeddings", reasoning: "Reasoning", vision: "Vision", audio: "Audio input", translation: "Translation", transcription: "Transcription" };

function showError(message: string) { error.textContent = message; error.hidden = !message; }
function tokens(value: number | null) { return value === null ? "Unknown" : value.toLocaleString(); }
function bytes(value: number | null) { return value === null ? "Unknown" : `${(value / 1e9).toFixed(2)} GB`; }
function active() { return acting || download?.phase === "starting" || download?.phase === "running" || download?.phase === "stopping"; }
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) {
    const problem: unknown = await response.json();
    throw new Error(typeof problem === "object" && problem !== null && "error" in problem && typeof problem.error === "string" ? problem.error : `HTTP ${response.status}`);
  }
  return response.json();
}
function filtered() {
  const query = search.value.trim().toLowerCase();
  return models.filter(model => (installed.value === "all" || model.installed === (installed.value === "installed")) &&
    (capability.value === "all" || model.capabilities.includes(capability.value)) &&
    `${model.tag} ${model.family ?? ""} ${model.parameters ?? ""} ${model.quantization ?? ""} ${model.capabilities.join(" ")}`.toLowerCase().includes(query));
}
function updateActions() {
  for (const [tag, button] of downloadButtons) {
    const model = models.find(model => model.tag === tag);
    button.disabled = active() || model?.installed === true;
  }
  cancel.disabled = acting || !download?.pid || download.phase === "stopping";
}
function contextCell(model: CatalogModel) {
  const cell = contextRows.get(model.tag);
  if (!cell) return;
  const value = contexts.get(model.tag);
  cell.textContent = value ? `${tokens(value.tokens)}${value.kind === "config" ? " (config)" : value.kind === "fixed" ? " (fixed)" : ""}` :
    pending.has(model.tag) ? "Inspecting…" : contextErrors.has(model.tag) ? "Unavailable · retry Details" : "Not inspected";
}
function details() {
  element("details", HTMLElement).hidden = !selected;
  for (const button of rows.querySelectorAll<HTMLButtonElement>("button[aria-controls='details']")) {
    button.setAttribute("aria-expanded", String(button === detailsOpener && selected !== null));
  }
  if (!selected) return;
  const model = selected;
  element("details-title", HTMLHeadingElement).textContent = model.tag;
  const fields = element("details-fields", HTMLDListElement);
  const context = contexts.get(model.tag);
  const entries: [string, string][] = [
    ["Type", model.kind === "chat" ? "Conversational model" : model.kind === "speech" ? "Auxiliary transcription model" : "Embedding model"],
    ["Family", model.family ?? "Unknown"], ["Parameters", model.parameters ?? "Unknown"], ["Quantization", model.quantization ?? "Unknown"],
    ["Backend", model.backend ?? "Unknown"], ["Minimum FLM", model.minimumVersion ?? "Unknown"],
    ["Packaged download total", `${bytes(model.downloadBytes)} across ${model.fileCount} files`],
    ["Default context", tokens(model.defaultContext)], ["Context ceiling", context ? tokens(context.tokens) : contextErrors.has(model.tag) ? "Unavailable" : "Inspecting…"],
    ["Thinking toggle", model.thinkingToggleable === null ? "Not specified" : model.thinkingToggleable ? "Supported" : "Not toggleable according to catalog"],
    ["Capabilities", model.capabilities.map(value => capabilityNames[value] ?? value).join(", ") || "Text chat; no additional capabilities advertised"],
    ["Pull command", `flm pull ${model.tag}`],
  ];
  fields.replaceChildren(...entries.flatMap(([key, value]) => {
    const term = document.createElement("dt"); term.textContent = key;
    const description = document.createElement("dd"); description.textContent = value;
    return [term, description];
  }));
  element("context-note", HTMLParagraphElement).textContent = context?.note ?? contextErrors.get(model.tag) ?? "Reading the model configuration without downloading weights…";
  const links = element("detail-links", HTMLParagraphElement);
  links.replaceChildren();
  for (const [label, url] of [["Model repository", model.sourceUrl], ["Context source", context?.source]] as const) {
    if (!url) continue;
    const link = document.createElement("a"); link.textContent = label; link.href = url; link.target = "_blank"; link.rel = "noreferrer";
    links.append(link, " ");
  }
}
async function inspectContext(model: CatalogModel): Promise<void> {
  if (contexts.has(model.tag)) return;
  const current = pending.get(model.tag);
  if (current) return current;
  const work = (async () => {
    try {
      contexts.set(model.tag, await request<ContextDetails>(`/api/model-context?model=${encodeURIComponent(model.tag)}`));
      contextErrors.delete(model.tag);
    } catch (cause) { contextErrors.set(model.tag, cause instanceof Error ? cause.message : String(cause)); }
    finally {
      pending.delete(model.tag);
      contextCell(model);
      if (selected?.tag === model.tag) details();
    }
  })();
  pending.set(model.tag, work);
  contextCell(model);
  return work;
}
function renderRows() {
  const visible = filtered();
  element("count", HTMLSpanElement).textContent = `${visible.length} of ${models.length} models · ${models.filter(model => model.installed).length} installed`;
  rows.replaceChildren(); contextRows.clear(); downloadButtons.clear();
  element("empty", HTMLParagraphElement).hidden = visible.length > 0;
  for (const model of visible) {
    const row = rows.insertRow();
    const name = row.insertCell();
    const tag = document.createElement("strong"); tag.textContent = model.tag;
    const subtitle = document.createElement("small"); subtitle.textContent = [model.parameters, model.quantization, model.backend].filter(Boolean).join(" · ");
    name.append(tag, subtitle);
    const capabilities = row.insertCell();
    for (const value of model.capabilities) {
      const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = capabilityNames[value] ?? value; capabilities.append(badge);
    }
    if (!model.capabilities.length) capabilities.textContent = "Text chat";
    row.insertCell().textContent = bytes(model.downloadBytes);
    row.insertCell().textContent = tokens(model.defaultContext);
    contextRows.set(model.tag, row.insertCell()); contextCell(model);
    const status = row.insertCell(); status.textContent = model.installed ? "Installed" : "Not installed"; status.className = model.installed ? "installed" : "";
    const actions = row.insertCell(); actions.className = "row-actions";
    const detail = document.createElement("button"); detail.textContent = "Details";
    detail.setAttribute("aria-controls", "details");
    detail.setAttribute("aria-expanded", String(selected?.tag === model.tag));
    detail.setAttribute("aria-label", `Details for ${model.tag}`);
    if (selected?.tag === model.tag) detailsOpener = detail;
    detail.addEventListener("click", () => {
      selected = model; detailsOpener = detail; details(); void inspectContext(model);
      element("details-title", HTMLHeadingElement).focus({ preventScroll: true });
    });
    const pull = document.createElement("button"); pull.textContent = model.installed ? "Installed" : "Download"; pull.setAttribute("aria-label", `${pull.textContent} ${model.tag}`);
    pull.addEventListener("click", () => { void downloadModel(model); });
    actions.append(detail, pull); downloadButtons.set(model.tag, pull);
  }
  updateActions();
}
async function loadCatalog() {
  refresh.disabled = true;
  try {
    const data = await request<{ models: CatalogModel[]; modelPath: string }>("/api/catalog");
    models = data.models; modelPath = data.modelPath;
    element("storage", HTMLParagraphElement).textContent = `Download destination: ${modelPath}/models/`;
    if (selected) selected = models.find(model => model.tag === selected?.tag) ?? null;
    renderRows(); details(); showError("");
  } catch (cause) { showError(cause instanceof Error ? cause.message : String(cause)); }
  finally { refresh.disabled = false; }
}
function renderDownload(next: DownloadState) {
  const previous = download;
  download = next;
  element("download", HTMLElement).hidden = next.phase === "idle";
  element("download-status", HTMLSpanElement).textContent = `${next.model ?? ""}: ${next.phase}${next.phase === "cancelled" ? " · partial files retained" : ""}`;
  if (logs.textContent !== next.logs) { logs.textContent = next.logs; if (follow.checked) logs.scrollTop = logs.scrollHeight; }
  updateActions();
  if (previous && previous.phase !== next.phase && ["completed", "failed", "cancelled"].includes(next.phase)) void loadCatalog();
}
async function downloadModel(model: CatalogModel) {
  if (active() || !confirm(`Download ${model.tag}?\nPackaged estimate: ${bytes(model.downloadBytes)}\nDestination: ${modelPath}/models/\nThis runs flm pull and does not start inference.`)) return;
  acting = true; updateActions(); showError("");
  try { renderDownload(await request<DownloadState>("/api/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: model.tag }) })); }
  catch (cause) { showError(cause instanceof Error ? cause.message : String(cause)); }
  finally { acting = false; updateActions(); }
}
cancel.addEventListener("click", async () => {
  acting = true; updateActions();
  try { renderDownload(await request<DownloadState>("/api/cancel-pull", { method: "POST" })); }
  catch (cause) { showError(String(cause)); }
  finally { acting = false; updateActions(); }
});
function closeDetails() {
  selected = null; details();
  (detailsOpener?.isConnected ? detailsOpener : search).focus({ preventScroll: true });
  detailsOpener = null;
}
element("close-details", HTMLButtonElement).addEventListener("click", closeDetails);
document.addEventListener("keydown", event => { if (event.key === "Escape" && selected) closeDetails(); });
for (const input of [search, installed, capability]) input.addEventListener("input", renderRows);
refresh.addEventListener("click", () => { void loadCatalog(); });
inspect.addEventListener("click", async () => {
  inspect.disabled = true;
  const remaining = filtered().slice();
  await Promise.all(Array.from({ length: 3 }, async () => { for (let model; (model = remaining.shift());) await inspectContext(model); }));
  inspect.disabled = false;
});
logs.addEventListener("scroll", () => { follow.checked = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 24; });
follow.addEventListener("change", () => { if (follow.checked) logs.scrollTop = logs.scrollHeight; });
await Promise.all([loadCatalog(), request<DownloadState>("/api/download").then(renderDownload).catch(cause => showError(String(cause)))]);
while (true) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (!document.hidden) {
    try { renderDownload(await request<DownloadState>("/api/download")); }
    catch { showError("Dashboard disconnected. Download status is unknown; do not start a duplicate pull elsewhere."); }
  }
}
