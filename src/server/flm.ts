import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ModelCatalog } from "./model-catalog.ts";
import { Downloads } from "./downloads.ts";

export const contextLengths = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
export type StartOptions = { model: string; contextLength: number | null };
export type InstalledModel = { tag: string; contextLength: number; vision: boolean };
export type Phase = "stopped" | "starting" | "ready" | "stopping" | "failed" | "external";
export type DashboardState = {
  phase: Phase;
  pid: number | null;
  preload: string | null;
  contextLength: number | null;
  command: string[];
  logs: string;
  apiUrl: string;
  modelPath: string;
};

export class ControlError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function parseStartOptions(value: unknown): StartOptions {
  if (typeof value !== "object" || value === null || !("model" in value) ||
      typeof value.model !== "string" || !("contextLength" in value) ||
      !(value.contextLength === null || (typeof value.contextLength === "number" && contextLengths.includes(value.contextLength)))) {
    throw new ControlError("Choose a preload model and a supported context length.", 400);
  }
  return { model: value.model, contextLength: value.contextLength };
}

export function portIsOccupied(port: number): boolean {
  // Do not connect and immediately disconnect: FLM 1.0.9–1.0.10 can lose an I/O thread that way.
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    listener.stop(true);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") return true;
    throw error;
  }
}

// Own only the child launched here. Never adopt or signal an existing FLM process.
export class FlmServer {
  readonly port: number;
  readonly modelPath: string;
  readonly catalog: ModelCatalog;
  readonly downloads: Downloads;
  private readonly executable: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly stopTimeout: number;
  private child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private finished: Promise<void> = Promise.resolve();
  private busy = false;
  private closing = false;
  private phase: Phase = "stopped";
  private preload: string | null = null;
  private contextLength: number | null = null;
  private command: string[] = [];
  private logs = "";

  constructor(options: { port?: number; modelPath?: string; executable?: string[]; stopTimeout?: number } = {}) {
    this.port = options.port ?? 52625;
    this.modelPath = options.modelPath ?? process.env.FLM_MODEL_PATH ?? join(process.env.HOME ?? ".", "models/flm");
    this.executable = options.executable ?? ["stdbuf", "-o0", "flm"];
    this.stopTimeout = options.stopTimeout ?? 10_000;
    this.env = { ...process.env, FLM_MODEL_PATH: this.modelPath, FLM_DISABLE_UPDATE_CHECK: "1" };
    const cli = { executable: this.executable, env: this.env, stopTimeout: this.stopTimeout };
    this.catalog = new ModelCatalog(cli);
    this.downloads = new Downloads(this.catalog, cli);
  }

  private append(text: string) {
    this.logs = stripVTControlCharacters(this.logs + text).replaceAll("\r", "\n").slice(-131072);
  }

  async models(): Promise<InstalledModel[]> {
    return (await this.catalog.list()).filter(model => model.installed && model.kind === "chat")
      .map(model => ({ tag: model.tag, contextLength: model.defaultContext, vision: model.capabilities.includes("vision") }));
  }

  async state(): Promise<DashboardState> {
    const child = this.child;
    let phase = this.phase;
    if (child && phase === "starting") {
      let ready = false;
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/v1/models`, { signal: AbortSignal.timeout(2000) });
        ready = response.ok;
        await response.text();
      } catch { /* A live process is starting until its API answers. */ }
      if (this.child !== child || this.phase !== "starting") return this.state();
      this.phase = phase = ready ? "ready" : "starting";
    } else if (!child && !this.busy && portIsOccupied(this.port)) {
      phase = "external";
    }
    return { phase, pid: this.child?.pid ?? null, preload: this.preload, contextLength: this.contextLength, command: this.command,
      logs: this.logs, apiUrl: `http://127.0.0.1:${this.port}/v1`, modelPath: this.modelPath };
  }

  async start(options: StartOptions): Promise<void> {
    if (this.closing || this.busy || this.child) throw new ControlError("FLM is already running or changing state. Stop it first.");
    this.busy = true;
    this.phase = "starting";
    try {
      if (portIsOccupied(this.port)) throw new ControlError(`Port ${this.port} is already in use. Stop that server in its own terminal first.`);
      const models = await this.models();
      if (options.model && !models.some(model => model.tag === options.model)) {
        throw new ControlError("Preload must be a downloaded FLM language model. Refresh the model list.", 400);
      }
      this.preload = options.model || null;
      this.contextLength = options.contextLength;
      this.command = [...this.executable, "serve", ...(options.model ? [options.model] : []),
        "--host", "127.0.0.1", "--port", String(this.port), "--pmode", "balanced",
        "--img-pre-resize", "0", "--cors", "0",
        ...(options.contextLength === null ? [] : ["--ctx-len", String(options.contextLength)])];
      this.logs = "";
      this.append(`$ ${this.command.join(" ")}\n`);
      const child = Bun.spawn(this.command, { env: this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      this.child = child;
      const read = async (stream: ReadableStream<Uint8Array>) => {
        try {
          const decoder = new TextDecoder();
          for await (const chunk of stream) this.append(decoder.decode(chunk, { stream: true }));
          this.append(decoder.decode());
        } catch (error) { this.append(`\nLog read failed: ${error}\n`); }
      };
      this.finished = Promise.all([child.exited, read(child.stdout), read(child.stderr)]).then(([code]) => {
        this.phase = this.phase === "stopping" || code === 0 ? "stopped" : "failed";
        this.append(`\n[dashboard] FLM exited (${child.signalCode ?? code}).\n`);
        this.child = null;
      });
    } catch (error) {
      this.phase = "failed";
      this.append(`\n[dashboard] ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    } finally { this.busy = false; }
  }

  async stop(): Promise<void> {
    if (this.busy) throw new ControlError("A start or stop is already in progress.");
    const child = this.child;
    if (!child) return;
    this.busy = true;
    this.phase = "stopping";
    this.append("\n[dashboard] Stopping FLM…\n");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, this.stopTimeout);
    try {
      child.kill("SIGTERM");
      await this.finished;
    } finally {
      clearTimeout(force);
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    while (this.busy) await Bun.sleep(25);
    await Promise.all([this.stop(), this.downloads.close()]);
  }
}
