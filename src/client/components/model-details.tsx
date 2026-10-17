import { useEffect, useRef } from "react";
import type { CatalogModel, ContextDetails } from "../../server/model-catalog.ts";

export const capabilityNames: Record<string, string> = { "tool-calling": "Tools", "chat-transcription": "Chat transcription", "single-turn": "Single turn", "realtime-transcription": "Realtime transcription", embeddings: "Embeddings", reasoning: "Reasoning", vision: "Vision", audio: "Audio input", translation: "Translation", transcription: "Transcription" };
export function tokens(value: number | null) { return value === null ? "Unknown" : value.toLocaleString(); }
export function bytes(value: number | null) { return value === null ? "Unknown" : `${(value / 1e9).toFixed(2)} GB`; }
export type Inspection = { phase: "pending" } | { phase: "ready"; details: ContextDetails } | { phase: "failed"; error: string };

export function contextLabel(inspection?: Inspection) {
  if (!inspection) return "Not inspected";
  if (inspection.phase === "pending") return "Inspecting…";
  if (inspection.phase === "failed") return "Unavailable · retry Details";
  const { tokens: count, kind } = inspection.details;
  return `${tokens(count)}${kind === "unknown" ? "" : ` (${kind})`}`;
}

export function ModelDetails({ model, inspection, onClose }: { model: CatalogModel; inspection?: Inspection; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [model.tag]);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") close.current?.click(); };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);
  const context = inspection?.phase === "ready" ? inspection.details : null;
  const fields = [
    ["Type", model.kind === "chat" ? "Conversational model" : model.kind === "speech" ? "Auxiliary transcription model" : "Embedding model"],
    ["Family", model.family ?? "Unknown"], ["Parameters", model.parameters ?? "Unknown"], ["Quantization", model.quantization ?? "Unknown"],
    ["Backend", model.backend ?? "Unknown"], ["Minimum FLM", model.minimumVersion ?? "Unknown"],
    ["Packaged download total", `${bytes(model.downloadBytes)} across ${model.fileCount} files`],
    ["Default context", tokens(model.defaultContext)], ["Context ceiling", contextLabel(inspection)],
    ["Thinking toggle", model.thinkingToggleable === null ? "Not specified" : model.thinkingToggleable ? "Supported" : "Not toggleable according to catalog"],
    ["Capabilities", model.capabilities.map(value => capabilityNames[value] ?? value).join(", ") || "Text chat; no additional capabilities advertised"],
    ["Pull command", `flm pull ${model.tag}`],
  ];
  return <aside id="details" aria-labelledby="details-title" className="fixed top-4 right-4 z-20 max-h-[calc(100dvh-32px-var(--download-space))] w-[min(380px,calc(100%-32px))] overflow-y-auto rounded-lg border border-line border-l-[3px] border-l-accent bg-panel p-4 shadow-xl min-[1100px]:sticky min-[1100px]:w-auto">
    <div className="flex items-start gap-3"><h2 ref={heading} id="details-title" tabIndex={-1} className="min-w-0 flex-1 text-base font-semibold wrap-anywhere">{model.tag}</h2><button ref={close} className="compact" aria-label="Close model details" onClick={onClose}>Close</button></div>
    <dl className="mt-4 grid gap-1">{fields.map(([label, value]) => <div key={label}><dt className="text-muted">{label}</dt><dd className="mb-2.5 wrap-anywhere">{value}</dd></div>)}</dl>
    <p className="note">{context?.note ?? (inspection?.phase === "failed" ? inspection.error : "Reading the model configuration without downloading weights…")}</p>
    <div className="flex flex-wrap gap-3">{model.sourceUrl && <a href={model.sourceUrl} target="_blank" rel="noreferrer">Model repository</a>}{context?.source && <a href={context.source} target="_blank" rel="noreferrer">Context source</a>}</div>
  </aside>;
}
