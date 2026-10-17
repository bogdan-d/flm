import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogModel, ContextDetails } from "../server/model-catalog.ts";
import type { DownloadState } from "../server/downloads.ts";
import type { PiConfigPreview, PiConfigResult } from "../server/pi-config.ts";
import { message, post, useApi, usePolling } from "./api.ts";
import { Header } from "./components/header.tsx";
import { LogPanel } from "./components/log-panel.tsx";
import { bytes, capabilityNames, contextLabel, ModelDetails, tokens, type Inspection } from "./components/model-details.tsx";

function Models() {
  const api = useApi();
  const [catalog, setCatalog] = useState<{ models: CatalogModel[]; modelPath: string }>({ models: [], modelPath: "" });
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState("all");
  const [capability, setCapability] = useState("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const [inspections, setInspections] = useState<Record<string, Inspection>>({});
  const pending = useRef(new Map<string, Promise<void>>());
  const [inspecting, setInspecting] = useState(false);
  const batch = useRef(false);
  const [download, setDownload] = useState<DownloadState | null>(null);
  const [connected, setConnected] = useState(false);
  const [acting, setActing] = useState(false);
  const mutation = useRef(false);
  const revision = useRef(0);
  const lastPhase = useRef<DownloadState["phase"] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncLock = useRef(false);
  const [piStatus, setPiStatus] = useState("");
  const [error, setError] = useState("");
  const { models, modelPath } = catalog;
  const selected = models.find(model => model.tag === selectedTag);
  const visible = models.filter(model => (installed === "all" || model.installed === (installed === "installed")) &&
    (capability === "all" || model.capabilities.includes(capability)) &&
    `${model.tag} ${model.family ?? ""} ${model.parameters ?? ""} ${model.quantization ?? ""} ${model.capabilities.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = acting || download?.phase === "starting" || download?.phase === "running" || download?.phase === "stopping";
  const docked = download !== null && download.phase !== "idle";

  async function loadCatalog(signal?: AbortSignal) {
    setRefreshing(true);
    try { setCatalog(await api("/api/catalog", { signal })); setLoaded(true); setError(""); }
    catch (cause) { if (!signal?.aborted) setError(message(cause)); }
    finally { setRefreshing(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [api]);
  function renderDownload(next: DownloadState) {
    const previous = lastPhase.current;
    lastPhase.current = next.phase;
    setDownload(next); setConnected(true);
    if (previous !== null && previous !== next.phase && ["completed", "failed", "cancelled"].includes(next.phase)) void loadCatalog();
  }
  usePolling(async signal => {
    const current = revision.current;
    try {
      const next = await api<DownloadState>("/api/download", { signal });
      if (!mutation.current && current === revision.current) renderDownload(next);
    } catch { if (!signal.aborted && current === revision.current) setConnected(false); }
  });
  async function inspectContext(model: CatalogModel): Promise<void> {
    if (inspections[model.tag]?.phase === "ready") return;
    const current = pending.current.get(model.tag);
    if (current) return current;
    setInspections(previous => ({ ...previous, [model.tag]: { phase: "pending" } }));
    const work = (async () => {
      try {
        const details = await api<ContextDetails>(`/api/model-context?model=${encodeURIComponent(model.tag)}`);
        setInspections(previous => ({ ...previous, [model.tag]: { phase: "ready", details } }));
      } catch (cause) { setInspections(previous => ({ ...previous, [model.tag]: { phase: "failed", error: message(cause) } })); }
      finally { pending.current.delete(model.tag); }
    })();
    pending.current.set(model.tag, work);
    return work;
  }
  async function inspectVisible() {
    if (batch.current) return;
    batch.current = true; setInspecting(true);
    const remaining = visible.slice();
    try { await Promise.all(Array.from({ length: 3 }, async () => { for (let model; (model = remaining.shift());) await inspectContext(model); })); }
    finally { batch.current = false; setInspecting(false); }
  }
  async function pull(model?: CatalogModel) {
    if (mutation.current || (model && (active || !connected))) return;
    if (model && !confirm(`Download ${model.tag}?\nPackaged estimate: ${bytes(model.downloadBytes)}\nDestination: ${modelPath}/models/\nThis runs flm pull and does not start inference.`)) return;
    revision.current++;
    mutation.current = true; setActing(true); setError("");
    try { renderDownload(await api<DownloadState>(model ? "/api/pull" : "/api/cancel-pull", post(model ? { model: model.tag } : undefined))); }
    catch (cause) { setError(message(cause)); }
    finally { revision.current++; mutation.current = false; setActing(false); }
  }
  async function syncPi() {
    if (syncLock.current) return;
    syncLock.current = true; setSyncing(true); setPiStatus("Reading downloaded models and Pi config…"); setError("");
    try {
      const preview = await api<PiConfigPreview>("/api/pi-config");
      setPiStatus("");
      if (!confirm(`Sync ${preview.models.length} downloaded conversational models to Pi?\n\nTarget: ${preview.path}\n\n${preview.models.join("\n")}\n\nReplace providers.flm only. Other providers stay unchanged.\nThe existing config will be backed up.\nContexts use conservative model defaults, capped by the managed server override and known fixed limits.`)) return;
      setPiStatus("Syncing Pi config…");
      const result = await api<PiConfigResult>("/api/pi-config", post({ token: preview.token }));
      setPiStatus(`Synced ${result.models.length} models to ${result.path}. ${result.backupPath ? `Backup: ${result.backupPath}. ` : ""}Open /model in Pi to reload. Capabilities come from the FLM catalog; Pi tool calling and vision are not verified for every model.`);
    } catch (cause) { setPiStatus(""); setError(message(cause)); }
    finally { syncLock.current = false; setSyncing(false); }
  }
  function closeDetails() {
    setSelectedTag(null);
    (opener.current?.isConnected ? opener.current : search.current)?.focus({ preventScroll: true });
  }
  return <div style={{ "--download-space": docked ? "var(--download-height)" : "0px" } as React.CSSProperties}>
    <Header page="Models" />
    <main className="pb-[calc(24px+var(--download-space))]">
      <div className="mb-3 flex flex-wrap items-center gap-4"><h2 className="text-xl font-semibold">Choose a model</h2><span role="status" className="text-muted">{loaded ? `${visible.length} of ${models.length} models · ${models.filter(model => model.installed).length} installed` : "Loading catalog…"}</span><button className="sm:ml-auto" disabled={refreshing} onClick={() => void loadCatalog()}>Refresh catalog</button><button disabled={syncing} onClick={() => void syncPi()}>Sync models to Pi</button></div>
      <p className="note">All models exposed by this installed FLM build for this hardware. Capabilities are catalog claims, not local test results.</p>
      <p className="note">Download estimates sum packaged file sizes, not RAM requirements or bytes still missing. Default context is not maximum context.</p>
      <p className="note">Use Details or "Inspect contexts" to read small model configs from Hugging Face. Config ceilings do not guarantee FLM runtime support or memory capacity.</p>
      <p className="note">{modelPath && `Download destination: ${modelPath}/models/`}</p>
      <p className="note">Sync models to Pi writes only downloaded conversational models, regardless of table filters. It replaces only the FLM provider and backs up your existing config.</p>
      <p className="note" role="status">{piStatus}</p>
      {error && <p role="alert">{error}</p>}
      {!connected && <p role="status" className="note">Dashboard disconnected or connecting. Download status is unknown; do not start a duplicate pull elsewhere.</p>}
      <div className={`mt-5 grid items-start gap-5 ${selected ? "min-[1100px]:grid-cols-[minmax(0,1fr)_340px]" : "grid-cols-1"}`}>
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="min-w-0 basis-full sm:min-w-64 sm:flex-1 sm:basis-auto">Search models<input ref={search} type="search" placeholder="Name, family, capability, quantization…" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <label>Local status<select value={installed} onChange={event => setInstalled(event.target.value)}><option value="all">All models</option><option value="installed">Installed</option><option value="missing">Not installed</option></select></label>
            <label>Capability<select value={capability} onChange={event => setCapability(event.target.value)}><option value="all">Any capability</option>{["vision", "reasoning", "tool-calling", "audio", "embeddings", "transcription", "translation", "single-turn"].map(value => <option key={value} value={value}>{capabilityNames[value]}</option>)}</select></label>
            <button disabled={inspecting || !loaded} onClick={() => void inspectVisible()}>Inspect contexts</button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="FLM model catalog">
            <table className="w-full border-collapse text-left text-[13px]"><thead><tr>{["Model", "Capabilities", "Download estimate", "Default context", "Context ceiling", "Local status", "Actions"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{visible.map(model => <tr key={model.tag}>
                <td className="min-w-52"><strong>{model.tag}</strong><small className="mt-1 block text-muted">{[model.parameters, model.quantization, model.backend].filter(Boolean).join(" · ")}</small></td>
                <td className="min-w-40">{model.capabilities.length ? model.capabilities.map(value => <span key={value} className="mr-1 mb-1 inline-block rounded border border-line bg-panel px-1.5 py-px text-[11px] whitespace-nowrap">{capabilityNames[value] ?? value}</span>) : "Text chat"}</td>
                <td>{bytes(model.downloadBytes)}</td><td>{tokens(model.defaultContext)}</td><td>{contextLabel(inspections[model.tag])}</td><td className={model.installed ? "text-accent" : ""}>{model.installed ? "Installed" : "Not installed"}</td>
                <td className="min-w-48"><div className="flex flex-wrap gap-1"><button className="compact" aria-label={`Details for ${model.tag}`} aria-controls="details" aria-expanded={selectedTag === model.tag} onClick={event => { opener.current = event.currentTarget; setSelectedTag(model.tag); void inspectContext(model); }}>Details</button><button className="compact" aria-label={`${model.installed ? "Installed" : "Download"} ${model.tag}`} disabled={active || !connected || model.installed} onClick={() => void pull(model)}>{model.installed ? "Installed" : "Download"}</button></div></td>
              </tr>)}</tbody>
            </table>
          </div>
          {loaded && !visible.length && <p className="note">No models match these filters.</p>}
          <footer>Downloads run as a separate <code>flm pull &lt;tag&gt;</code> process and never start inference. One managed download at a time. <a href="https://fastflowlm.com/docs/models/" target="_blank" rel="noreferrer">Official model cards</a></footer>
        </div>
        {selected && <ModelDetails model={selected} inspection={inspections[selected.tag]} onClose={closeDetails} />}
      </div>
    </main>
    {docked && <LogPanel docked title="Download" output={download.logs} status={`${download.model ?? ""}: ${download.phase}${download.phase === "cancelled" ? " · partial files retained" : ""}`}><button disabled={acting || !connected || !download.pid || download.phase === "stopping"} onClick={() => void pull()}>Cancel download</button></LogPanel>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<Models />);
