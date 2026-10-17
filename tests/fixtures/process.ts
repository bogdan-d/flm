// A controlled child for testing dashboard ownership, not FLM API compatibility.
const args = process.argv.slice(2);
if (args.includes("list")) {
  // Fields used by the dashboard, captured from flm list --filter installed --json.
  console.log(JSON.stringify({ models: [
    { model: "qwen3.5:9b", installed: true, default_context_length: 32768, vlm: true },
    { model: "qwen3:0.6b", installed: false, default_context_length: 32768, details: { family: "qwen3", think: false, think_toggleable: true, parameter_size: "0.6B", quantization_level: "Q4_1" } },
  ] }));
} else if (args.includes("pull")) {
  if (process.env.TEST_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
  console.log(`pull arguments: ${JSON.stringify(args)}`);
  console.log("\r\x1b[K[FLM] Downloading: 42.3% (123.4MB / 291.7MB)");
  console.error("pull stderr");
  if (process.env.TEST_LOG_FLOOD === "1") console.log("x".repeat(200_000));
  setTimeout(() => process.exit(process.env.TEST_EXIT === "1" ? 7 : 0), 300);
} else {
  const portIndex = args.indexOf("--port");
  const port = Number(args[portIndex + 1]);
  if (process.env.TEST_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
  console.log("child stdout");
  console.error("child stderr");
  if (process.env.TEST_EXIT === "1") process.exit(7);
  if (process.env.TEST_LOG_FLOOD === "1") console.log("x".repeat(200_000));
  setTimeout(() => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({}) }), 80);
}
