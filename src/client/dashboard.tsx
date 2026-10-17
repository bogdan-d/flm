import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardState, InstalledModel, Phase } from "../server/flm.ts";
import { message, post, useApi, usePolling } from "./api.ts";
import { Header } from "./components/header.tsx";
import { LogPanel } from "./components/log-panel.tsx";

const labels: Record<Phase, string> = { stopped: "Stopped", starting: "Starting", ready: "Ready", stopping: "Stopping", failed: "Exited with error", external: "Port in use outside dashboard" };
const contexts = [4096, 8192, 16384, 32768, 65536, 131072, 262144];

function Dashboard() {
  const api = useApi();
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState<InstalledModel[] | null>(null);
  const [model, setModel] = useState("");
  const [context, setContext] = useState("262144");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const revision = useRef(0);
  const [refreshing, setRefreshing] = useState(false);

  async function loadModels(signal?: AbortSignal) {
    setRefreshing(true);
    try {
      const data = await api<{ models: InstalledModel[] }>("/api/models", { signal });
      setModels(data.models);
      setModel(current => data.models.some(item => item.tag === current) ? current : "");
      setError("");
    } catch (cause) { if (!signal?.aborted) setError(message(cause)); }
    finally { setRefreshing(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [api]);
  async function poll(signal?: AbortSignal) {
    const current = revision.current;
    try {
      const next = await api<DashboardState>("/api/state", { signal });
      if (!mutation.current && current === revision.current) { setState(next); setConnected(true); }
    } catch { if (!signal?.aborted && current === revision.current) setConnected(false); }
  }
  usePolling(poll);
  async function act(path: string) {
    if (mutation.current) return;
    revision.current++;
    mutation.current = true; setBusy(true); setError("");
    try {
      const next = await api<DashboardState>(path, post({ model, contextLength: context ? Number(context) : null }));
      setState(next); setConnected(true);
      if (next.pid) { setModel(next.preload ?? ""); setContext(next.contextLength === null ? "" : String(next.contextLength)); }
    } catch (cause) { setError(message(cause)); }
    finally { revision.current++; mutation.current = false; setBusy(false); await poll(); }
  }
  const running = state?.pid != null;
  const locked = busy || running || !connected || state?.phase === "external" || state?.phase === "starting" || state?.phase === "stopping";
  const phase = connected ? state?.phase : undefined;
  return <>
    <Header page="Server">
      <span role="status" className={`inline-flex items-center gap-2 before:size-2 before:rounded-full before:bg-current ${phase === "ready" ? "text-accent" : phase === "failed" || phase === "external" ? "text-bad" : "text-muted"}`}>{connected && state ? labels[state.phase] : state ? "Dashboard disconnected" : "Connecting"}</span>
      <a className="sm:ml-auto" href={`${state?.apiUrl ?? "http://127.0.0.1:52625/v1"}/models`} target="_blank" rel="noreferrer">{(state?.apiUrl ?? "http://127.0.0.1:52625/v1").replace("http://", "")}</a>
    </Header>
    <main>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void act("/api/start"); }}>
        <label className="min-w-0 basis-full sm:min-w-72 sm:flex-1 sm:basis-auto">Preload model
          <select value={running ? state.preload ?? "" : model} disabled={locked || models === null} onChange={event => setModel(event.target.value)}>
            <option value="">No preload · load on first API request</option>
            {models?.map(item => <option key={item.tag} value={item.tag}>{item.tag}{item.vision ? " · vision" : ""}</option>)}
          </select>
        </label>
        <label>Context per model<select value={running ? state.contextLength === null ? "" : String(state.contextLength) : context} disabled={locked} onChange={event => setContext(event.target.value)}>
          <option value="">Model default</option>{contexts.map(size => <option key={size} value={size}>{size / 1024}K</option>)}
        </select></label>
        <button type="button" disabled={busy || running || refreshing} onClick={() => void loadModels()}>Refresh models</button>
        <button className="primary" type="submit" disabled={locked || models === null}>Start server</button>
        <button type="button" disabled={busy || !connected || !running || state?.phase === "stopping"} onClick={() => void act("/api/stop")}>Stop</button>
      </form>
      <p className="note">Balanced power · loopback only · original image resolution. Preload is not a model lock; API requests can switch models.</p>
      <p className="note">Context applies to every model loaded by this server. Choose "Model default" for models with different limits.</p>
      <p className="note">Known FLM 1.0.9 issue: preloading can leave the API unresponsive. Use "No preload" and let the first API request load the model.</p>
      <p className="note">{state && `Model storage: ${state.modelPath}`}</p>
      {error && <p role="alert">{error}</p>}
      <LogPanel title="Server logs" output={state?.logs || "Start the server to see its output here."} command={state?.command} status={running ? `PID ${state.pid} · ${state.preload ? `preload ${state.preload}` : "no preload"}` : "No managed process"} />
      <footer>Only downloaded language models are offered for preload. Closing this tab leaves FLM running; exiting the Bun dashboard stops it.</footer>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<Dashboard />);
