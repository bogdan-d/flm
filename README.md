# flm

A small Bun dashboard for the native FastFlowLM NPU server, with a React 19 and Tailwind CSS 4 client. No Python, containers, or separate frontend server.

## Dashboard

Requires Bun and the native `flm` executable on `PATH`. Install dependencies once with `bun install`, then run from this repository:

```bash
bun run start
```

Open **http://127.0.0.1:9098**. Choose a downloaded model to preload, or leave **No preload** selected to load the model named by the first API request. Choose the context allowance and click **Start server**. Logs refresh every second, with an optional auto-follow view. **Stop** terminates only the FLM process started by this dashboard.

The default settings match the Pi example: 256K context, balanced NPU power, original image resolution, CORS disabled, and the API at `http://127.0.0.1:52625/v1`. The context override applies to every model subsequently loaded, so use **Model default** for models with different limits. Match Pi's `contextWindow` to the actual server allowance. Preloading does not lock the server to that model; API requests can switch models.

The preload selector shows installed conversational models. Use **Refresh models** after a download. The model storage root is inherited from `FLM_MODEL_PATH`, falling back to `~/models/flm`. FLM stores weights under its `models/` subdirectory. Native-audio conversational models remain eligible for preload; standalone Whisper and embedding models are separate types.

**FLM 1.0.9–1.0.10 startup caveat:** FLM opens the API port before a preload finishes loading. If a client gives up on a connection during that time, the server stops accepting connections after the load ([ROCm/FastFlowLM#762](https://github.com/ROCm/FastFlowLM/issues/762)). The dashboard's readiness check never gives up on a connection, so preloading works. Avoid time-limited health checks from other tools while a model loads.

Closing the browser tab leaves the managed server running. **Ctrl+C in the Bun terminal stops both the dashboard and its managed FLM process**, escalating to SIGKILL after 10 seconds if necessary. An API port already used by another process is shown as external; the dashboard refuses to start another server and never stops that process. Logs are volatile, capped at 131,072 characters, and reset on each start. They can include inference prompts; do not publish them unredacted. Ready means `/v1/models` answered after startup, not continuous health monitoring or validated inference. Once ready, the dashboard watches process exit rather than filling FLM's logs with health requests.

Both listeners are loopback-only. Controls check Host, Origin, and browser fetch-site headers, borrowing the security approach and compact log/control layout from the sibling `strix-halo-inference` dashboard. There is no authentication against other local processes or users. Do not expose or tunnel this control interface to an untrusted network. Metrics collection and container controls from that reference are deliberately not included.

To choose a different dashboard port:

```bash
env DASHBOARD_PORT=9097 bun run start
```

## Model catalog and downloads

Open **Models** in the navigation, or visit **http://127.0.0.1:9098/models**. The table includes every model exposed by `flm list --json` for the installed build and hardware, not preview models for other NPU generations. Search by tag, parameter size, quantization, or capability, and filter by installed status or advertised capability. Details show model type, backend, minimum FLM version, thinking-toggle metadata, source links, and the exact `flm pull` command.

Download estimates sum only the required files in FLM's packaged `model_info.json`, read from `FLM_MODELINFO_PATH` or `/usr/share/flm/model_info.json`. Missing file-size entries produce **Unknown**, not a misleading partial total. These are full-model estimates from a package snapshot, not current upstream quotes, remaining transfer bytes, parameter counts, or RAM requirements. Capabilities come from catalog flags and labels and are not a promise that every API/client workflow has been tested.

### Context information

The table always shows FLM's **default context**, which is not necessarily its maximum. Click **Details** for one model or **Inspect contexts** for the currently filtered list to inspect context ceilings. Inspections run at most three at a time in that page and are cached by the dashboard process. They fetch small `config.json` files from the model's catalog-listed Hugging Face repository; no weights are downloaded. Network failures remain visible and can be retried with Details.

For ordinary models, the ceiling is the language configuration's `max_position_embeddings` or equivalent, preferring `text_config` and never a vision encoder's context. It is labeled **config**, not a verified FLM runtime maximum or RAM guarantee. Unknown ceilings stay unknown. Four documented Flash tags have a separate fixed 1,024-token runtime cap even when their shared base configuration advertises more. See the [official model cards](https://fastflowlm.com/docs/models/) before choosing large contexts. Requests, images, history, reasoning, and output share the context allowance.

### Download, cancel, and resume

Click **Download** on a missing model and confirm its tag, estimated size, and destination. The dashboard launches `flm pull <tag>` with an argument array, not a shell. Only tags from the current FLM catalog are accepted. One managed pull runs at a time, separately from inference; the catalog refreshes when it finishes. Inspect the combined stdout/stderr log for current-file progress, final verification, or errors. FLM's percentage is for the current file transfer, not overall model completion; its progress output labels MiB as MB.

**Cancel download** terminates only the owned pull process. FLM 1.0.9 writes partial transfers to `.part` files and verifies size/hash before promoting completed files. Completed files and partial downloads are retained. Click Download again to resume with an ordinary pull; the dashboard never adds `--force` or deletes files. Resume depends on upstream range support. Avoid starting another pull of the same model outside the dashboard while one is active. The dashboard does not coordinate with other FLM processes downloading through the inference API or a terminal.

Closing the browser tab does not cancel a pull. Exiting the Bun dashboard cancels its managed pull and stops its managed inference server, with bounded SIGKILL escalation. Logs and job status are in-memory and reset when the dashboard restarts; model files remain on disk. There are deliberately no model-delete controls or automatic downloads on opening the catalog.

Verified on 2026-10-17: the native catalog exposed 44 models with complete packaged file totals. Context inspection returned config ceilings or documented fixed limits for 43, and Unknown for Whisper, whose speech decoder does not expose the same language-context fields. Browser checks covered filters, context inspection, mobile layout, and downloading the previously missing `qwen3:0.6b` model. FLM completed and verified all four files, the page changed its status to Installed, and it appeared in the server preload selector. That approximately 695 MB download was retained. Cancellation, failure, concurrent-pull rejection, and shutdown cleanup were tested with controlled child processes; a real interrupted network download/resume was not exercised.

## Sync downloaded models to Pi

On the **Models** page, click **Sync models to Pi**. Confirm the target path and model list. The sync includes only downloaded conversational models, regardless of table filters, and excludes standalone speech and embedding models. It does not download models or start inference.

The target is `~/.pi/agent/models.json`, or `models.json` under `PI_CODING_AGENT_DIR` when that environment variable is set for the dashboard process. Sync replaces only `providers.flm`, including any custom settings in that provider. Other providers and top-level settings are preserved. Existing files get a uniquely named, private `.bak` copy beside them before an atomic replacement. The success message shows the backup path. To undo a sync, restore that backup while no other application is editing the config.

Invalid JSON, invalid config structure, and symlink targets are refused without overwriting the config. If the file, downloaded model list, or relevant server settings change after confirmation, review the sync again. If no conversational models are downloaded, the existing FLM provider is left untouched. Avoid editing the config or syncing from another dashboard process during a sync.

Generated entries use catalog vision and reasoning metadata. Thinking toggles are sent only for models that advertise toggle support. Context lengths conservatively use the smaller of each model's default and the managed server's context override, with documented fixed Flash limits applied. Each response gets up to one quarter of that allowance, capped at 32,768 tokens. Larger runtime contexts require manual configuration. The provider points to this dashboard's FLM API port; syncing does not validate an external server's context settings or every model's Pi tool-calling and vision behavior.

Open **`/model` in Pi** after syncing to reload the config and select an FLM model. Sync again after downloading models or changing the managed context allowance.

### Manual configuration example

Start the native FLM server:

```bash
flm serve qwen3.6-moe:35b-a3b --host 127.0.0.1 --port 52625 --pmode balanced --ctx-len 262144 --img-pre-resize 0 --cors 0
```

Merge `providers.flm` from [examples/pi-models.example.json](examples/pi-models.example.json) into `~/.pi/agent/models.json`, preserving existing providers. Open `/model` in Pi to reload the file and select FLM. The API key is a placeholder; the server does not require authentication.

The example enables text and image input with a 262,144-token context and a chosen 32,768-token per-response output allowance. Prompt, images, tool history, reasoning, and output share the total context. FLM loads the vision weights automatically; `--img-pre-resize 0` disables its image resizing, while Pi's own attachment limits still apply.

Pi's `/thinking off` sends `think: false`; other available thinking levels send `think: true`. FLM uses an on/off toggle, not distinct effort budgets. Pi's Chat Completions integration handles streaming and tool calls without an additional model-config switch. This example has not been tested end to end for Pi vision, thinking, and tool calling.

## Development

### Project layout

```text
src/
  index.ts           # Entry point and shutdown handling
  server/            # HTTP routes, FLM lifecycle, catalog, and downloads
  client/            # React pages, HTML entry points, and Tailwind styles
    components/      # Shared navigation, logs, and model details
tests/
  fixtures/          # Controlled child processes for lifecycle tests
examples/            # Pi provider configuration
```

Bun bundles the HTML entry points in `src/client/` when the server imports them. Each page mounts its own React root; navigation uses ordinary links, without a client router. `bunfig.toml` enables `bun-plugin-tailwind`, and `src/client/dashboard.css` defines the theme and common control styles. No separate build step is required.

Browser code uses type-only imports from the server modules for API shapes; server implementation code is not bundled into the browser. Page requests are aborted on unmount. Polling waits for each response before scheduling another, pauses while the page is hidden, and ignores responses superseded by a control action.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

To test lifecycle ownership, stop escalation, input validation, and browser-origin protections:

```bash
bun test
```

The tests use a controlled child process to verify dashboard behavior, not to claim FLM API compatibility. On 2026-10-17, a separate browser check started native FLM 1.0.9 with a Qwen3.5 9B preload at 4K context, observed logs and Ready status, received `42` from a real completion, and stopped the server through the UI. Starting without a preload and loading the model on the first real completion were also verified, as was Ctrl+C cleanup of a running child. On 2026-10-24, FLM 1.0.10 with a Qwen3.6 35B preload at 256K context reached Ready after about 9 seconds without I/O-thread errors and answered a real completion. This does not validate Pi vision or tool calling, or full-context inference.

To type check:

```bash
bun check
```

The React migration was checked in Chromium at desktop and 390px mobile widths with a controlled FLM child and mocked download and Pi-sync responses. Checks covered start/stop, search and status filters, context inspection, details focus and Escape handling, log follow, download cancellation, and Pi confirmation. These checks did not run native inference, download model weights, or write the user's Pi config.
