import { stripVTControlCharacters } from "node:util";
import { CatalogError, ModelCatalog, type CliOptions } from "./model-catalog.ts";

export type DownloadState = {
  phase: "idle" | "starting" | "running" | "stopping" | "completed" | "failed" | "cancelled";
  model: string | null;
  pid: number | null;
  logs: string;
  command: string[];
};

export class Downloads {
  private child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private finished: Promise<void> = Promise.resolve();
  private preparing = false;
  private closing = false;
  private state: DownloadState = { phase: "idle", model: null, pid: null, logs: "", command: [] };
  constructor(private readonly catalog: ModelCatalog, private readonly cli: CliOptions) {}

  snapshot(): DownloadState { return { ...this.state }; }
  private append(text: string) {
    this.state.logs = stripVTControlCharacters(this.state.logs + text).replaceAll("\r", "\n").slice(-131072);
  }

  async start(tag: string): Promise<void> {
    if (this.closing || this.preparing || this.child) throw new CatalogError("A download is already active. Wait or cancel it first.");
    this.preparing = true;
    this.state = { phase: "starting", model: tag, pid: null, logs: "", command: [] };
    try {
      // Refresh installed state before writing into the shared model directory.
      await this.catalog.list();
      const model = await this.catalog.find(tag);
      if (model.installed) throw new CatalogError("This model is already installed. Refresh the catalog.");
      const command = [...this.cli.executable, "pull", model.tag];
      this.state.command = command;
      this.append(`$ ${command.join(" ")}\n`);
      const child = Bun.spawn(command, { env: this.cli.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      this.child = child;
      this.state.phase = "running";
      this.state.pid = child.pid;
      const read = async (stream: ReadableStream<Uint8Array>) => {
        try {
          const decoder = new TextDecoder();
          for await (const chunk of stream) this.append(decoder.decode(chunk, { stream: true }));
          this.append(decoder.decode());
        } catch (error) { this.append(`\nLog read failed: ${error}\n`); }
      };
      this.finished = Promise.all([child.exited, read(child.stdout), read(child.stderr)]).then(([code]) => {
        this.state.phase = this.state.phase === "stopping" ? "cancelled" : code === 0 ? "completed" : "failed";
        this.state.pid = null;
        this.child = null;
        this.append(`\n[dashboard] Pull ${this.state.phase} (${child.signalCode ?? code}).\n`);
      });
    } catch (error) {
      this.state.phase = "failed";
      this.append(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { this.preparing = false; }
  }

  async cancel(): Promise<void> {
    if (this.preparing) throw new CatalogError("Download is preparing. Try cancelling again in a moment.");
    const child = this.child;
    if (!child) return;
    this.state.phase = "stopping";
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, this.cli.stopTimeout ?? 10_000);
    try { child.kill("SIGTERM"); await this.finished; }
    finally { clearTimeout(force); }
  }

  async close(): Promise<void> {
    this.closing = true;
    while (this.preparing) await Bun.sleep(25);
    await this.cancel();
  }
}
