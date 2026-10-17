export type CliOptions = { executable: string[]; env: NodeJS.ProcessEnv; stopTimeout?: number };
export type CatalogModel = {
  tag: string;
  installed: boolean;
  kind: "chat" | "embedding" | "speech";
  defaultContext: number;
  parameters: string | null;
  family: string | null;
  quantization: string | null;
  backend: string | null;
  minimumVersion: string | null;
  capabilities: string[];
  thinkingToggleable: boolean | null;
  downloadBytes: number | null;
  fileCount: number;
  sourceUrl: string | null;
  configUrl: string | null;
};
export type ContextDetails = { tokens: number | null; source: string | null; kind: "config" | "fixed" | "unknown"; note: string };

export class CatalogError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function huggingFaceUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === "https://huggingface.co" && !url.username && !url.password ? url : null;
  } catch { return null; }
}

// File totals describe the packaged FLM metadata, not peak RAM or a live upstream quote.
export function parseCatalog(value: unknown, fileInfo: unknown): CatalogModel[] {
  if (!record(value) || !Array.isArray(value.models)) throw new Error("Unexpected output from flm list --json.");
  return value.models.map((item: unknown) => {
    if (!record(item) || typeof item.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(item.model) ||
        typeof item.installed !== "boolean" || !positive(item.default_context_length)) throw new Error("Invalid model entry from FLM.");
    const details = record(item.details) ? item.details : {};
    const capabilities = new Set(strings(item.label));
    if (item.vlm === true) capabilities.add("vision");
    if (item.asr === true) capabilities.add("audio");
    if (details.think === true) capabilities.add("reasoning");
    const kind = details.family === "whisper-v3" || item.model.startsWith("whisper-v3:") ? "speech" :
      details.family === "embed-gemma" || capabilities.has("embeddings") ? "embedding" : "chat";
    const files = strings(item.files);
    const info: unknown = record(fileInfo) ? fileInfo[item.model] : undefined;
    const sizes = new Map<string, number>();
    if (Array.isArray(info)) for (const file of info) {
      if (record(file) && typeof file.path === "string" && typeof file.size === "number" && file.size >= 0 && Number.isFinite(file.size)) sizes.set(file.path, file.size);
    }
    const fileUrl = huggingFaceUrl(item.file_url);
    const match = fileUrl?.pathname.match(/^\/api\/models\/([^/]+\/[^/]+)\/tree\/(.+)$/);
    const configUrl = match ? `https://huggingface.co/${match[1]}/resolve/${match[2]}/config.json` : null;
    const sourceRepo = huggingFaceUrl(item.url)?.pathname.match(/^\/([^/]+\/[^/]+)(?:\/|$)/)?.[1] ?? match?.[1];
    return {
      tag: item.model, installed: item.installed, kind, defaultContext: item.default_context_length,
      parameters: text(details.parameter_size), family: text(details.family), quantization: text(details.quantization_level), backend: text(item.backend),
      minimumVersion: text(item.flm_min_version), capabilities: [...capabilities],
      thinkingToggleable: typeof details.think_toggleable === "boolean" ? details.think_toggleable : null,
      downloadBytes: files.length && files.every(file => sizes.has(file)) ? files.reduce((total, file) => total + (sizes.get(file) ?? 0), 0) : null,
      fileCount: files.length, sourceUrl: sourceRepo ? `https://huggingface.co/${sourceRepo}` : null, configUrl,
    };
  });
}

const fixedContexts = new Set(["hy-mt2-flash:1.8b", "qwen3vl-flash:4b", "gemma4e-flash:e2b", "gemma4e-flash:e4b"]);
export function contextDetails(model: CatalogModel, config: unknown): ContextDetails {
  if (fixedContexts.has(model.tag)) return { tokens: 1024, kind: "fixed", source: "https://fastflowlm.com/docs/models/",
    note: "Documented Flash runtime limit: fixed 1,024-token, single-turn context. The base model configuration can advertise more." };
  const root = record(config) ? config : {};
  const language = record(root.text_config) ? root.text_config : root;
  const tokens = [language.max_position_embeddings, language.max_sequence_length, language.max_seq_len].find(positive) ?? null;
  return { tokens, kind: tokens === null ? "unknown" : "config", source: model.configUrl,
    note: tokens === null ? "No language-context ceiling found in this model configuration. The default is not necessarily the maximum." :
      "Architecture ceiling from the language model configuration, not a verified FLM runtime or RAM guarantee. Input, images, history, and output share context." };
}

export class ModelCatalog {
  private entries = new Map<string, CatalogModel>();
  private contexts = new Map<string, ContextDetails>();
  constructor(private readonly cli: CliOptions) {}

  async list(): Promise<CatalogModel[]> {
    const child = Bun.spawn([...this.cli.executable, "list", "--json"], {
      env: this.cli.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Cannot list FLM models: ${error.trim() || output.trim() || `exit ${code}`}`);
    const file = Bun.file(this.cli.env.FLM_MODELINFO_PATH ?? "/usr/share/flm/model_info.json");
    const info: unknown = await file.exists() ? await file.json() : null;
    const result = parseCatalog(JSON.parse(output), info);
    this.entries = new Map(result.map(model => [model.tag, model]));
    return result;
  }

  async find(tag: string): Promise<CatalogModel> {
    if (!this.entries.size) await this.list();
    const model = this.entries.get(tag);
    if (!model) throw new CatalogError("Choose a model from this FLM installation's catalog.", 400);
    return model;
  }

  async context(tag: string): Promise<ContextDetails> {
    const model = await this.find(tag);
    const cached = this.contexts.get(tag);
    if (cached) return cached;
    let result = contextDetails(model, null);
    if (result.kind !== "fixed" && model.configUrl) {
      const response = await fetch(model.configUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Cannot read model context: Hugging Face returned HTTP ${response.status}.`);
      if (Number(response.headers.get("Content-Length")) > 2_000_000) {
        await response.body?.cancel();
        throw new Error("Model configuration is too large to inspect.");
      }
      const body = await response.text();
      if (body.length > 2_000_000) throw new Error("Model configuration is too large to inspect.");
      result = contextDetails(model, JSON.parse(body));
    }
    this.contexts.set(tag, result);
    return result;
  }
}
