import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ControlError, type FlmServer } from "./flm.ts";
import { contextDetails, type CatalogModel } from "./model-catalog.ts";

export type PiConfigPreview = { path: string; models: string[]; token: string };
export type PiConfigResult = { path: string; models: string[]; backupPath: string | null };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function buildPiProvider(models: CatalogModel[], apiUrl: string, contextLength: number | null) {
  const installed = models.filter(model => model.installed && model.kind === "chat");
  if (!installed.length) throw new ControlError("No downloaded conversational models to sync. Your Pi config was not changed.");
  return {
    baseUrl: apiUrl, api: "openai-completions", apiKey: "flm",
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    models: installed.map(model => {
      const fixed = contextDetails(model, null);
      // Catalog defaults are conservative; config ceilings alone do not prove FLM runtime support.
      const contextWindow = Math.min(model.defaultContext, contextLength ?? model.defaultContext,
        fixed.kind === "fixed" ? fixed.tokens ?? model.defaultContext : Infinity);
      return {
        id: model.tag, name: `${model.tag} · FLM NPU`,
        reasoning: model.capabilities.includes("reasoning") || model.thinkingToggleable === true,
        input: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
        contextWindow, maxTokens: Math.max(1, Math.min(32768, Math.floor(contextWindow / 4))),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(model.thinkingToggleable === true ? {
          samplingParams: { think: true }, samplingParamsByThinkingLevel: { off: { think: false } },
        } : {}),
      };
    }),
  };
}

async function readConfig(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new ControlError(`Pi config must be a regular file, not a symlink or directory: ${path}`);
    return await Bun.file(path).text();
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

// Exclusive creation and private permissions also apply to backups, which may contain credentials.
async function writePrivate(path: string, contents: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } catch (error) {
    await unlink(path);
    throw error;
  } finally { await file.close(); }
}

export class PiConfigSync {
  readonly path: string;
  private busy = false;

  constructor(private readonly flm: FlmServer, path = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "models.json")) {
    this.path = resolve(path);
  }

  private async prepare() {
    const [models, state, original] = await Promise.all([this.flm.catalog.list(), this.flm.state(), readConfig(this.path)]);
    let config: unknown = {};
    if (original !== null) {
      try { config = JSON.parse(original); }
      catch { throw new ControlError(`Invalid JSON in ${this.path}. Fix it before syncing; nothing was changed.`); }
    }
    if (!record(config) || (config.providers !== undefined && !record(config.providers))) {
      throw new ControlError(`Pi config and its providers must be JSON objects: ${this.path}`);
    }
    const provider = buildPiProvider(models, state.apiUrl, state.contextLength);
    const contents = JSON.stringify({ ...config, providers: { ...(config.providers ?? {}), flm: provider } }, null, 2) + "\n";
    const token = new Bun.CryptoHasher("sha256").update(JSON.stringify([original, provider])).digest("hex");
    return { original, contents, preview: { path: this.path, models: provider.models.map(model => model.id), token } };
  }

  async preview(): Promise<PiConfigPreview> {
    return (await this.prepare()).preview;
  }

  async sync(token: string): Promise<PiConfigResult> {
    if (this.busy) throw new ControlError("A Pi config sync is already in progress.");
    this.busy = true;
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      const prepared = await this.prepare();
      if (token !== prepared.preview.token) throw new ControlError("Pi config, downloaded models, or server settings changed. Click Sync models to Pi again to review them.");
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writePrivate(temporary, prepared.contents);
      const backupPath = prepared.original === null ? null : `${this.path}.${new Date().toISOString().replaceAll(":", "-")}.${crypto.randomUUID()}.bak`;
      if (backupPath !== null && prepared.original !== null) await writePrivate(backupPath, prepared.original);
      if (await readConfig(this.path) !== prepared.original) throw new ControlError("Pi config changed while syncing. Nothing was overwritten; try again.");
      await rename(temporary, this.path);
      return { path: this.path, models: prepared.preview.models, backupPath };
    } finally {
      try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
      finally { this.busy = false; }
    }
  }
}
