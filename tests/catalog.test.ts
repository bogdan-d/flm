import { expect, test } from "bun:test";
import { contextDetails, parseCatalog } from "../src/server/model-catalog.ts";

// Relevant fields captured from FLM 1.0.9 catalogs. Tests exercise our interpretation.
const qwen = { model: "qwen3.6-moe:35b-a3b", installed: false, default_context_length: 32768,
  vlm: true, files: ["config.json", "model.q4nx"], file_url: "https://huggingface.co/api/models/FastFlowLM/Qwen3.6-35B-A3B-NPU2/tree/flm_q4k_high_precision",
  details: { parameter_size: "35B", quantization_level: "Q4_K", think: true }, label: ["vision", "reasoning", "tool-calling"] };

test("keeps context default separate from maximum and never presents partial file totals as complete", () => {
  const [model] = parseCatalog({ models: [qwen] }, { [qwen.model]: [{ path: "model.q4nx", size: 21044871704 }] });
  if (!model) throw new Error("Missing model");
  expect(model.downloadBytes).toBeNull();
  expect(model.defaultContext).toBe(32768);
  expect(model.parameters).toBe("35B");
  expect(model.sourceUrl).toBe("https://huggingface.co/FastFlowLM/Qwen3.6-35B-A3B-NPU2");
  expect(model.configUrl).toBe("https://huggingface.co/FastFlowLM/Qwen3.6-35B-A3B-NPU2/resolve/flm_q4k_high_precision/config.json");
  expect(contextDetails(model, { text_config: { max_position_embeddings: 262144 }, vision_config: { max_position_embeddings: 999 } }).tokens).toBe(262144);
  expect(contextDetails(model, { vision_config: { max_position_embeddings: 999 } }).tokens).toBeNull();
  const [sized] = parseCatalog({ models: [qwen] }, { [qwen.model]: [{ path: "model.q4nx", size: 21044871704 }, { path: "config.json", size: 4017 }] });
  expect(sized?.downloadBytes).toBe(21044875721);
});

test("a Flash runtime cap overrides its shared base model config without capping unrelated single-turn models", () => {
  const [flash, other] = parseCatalog({ models: [
    { ...qwen, model: "qwen3vl-flash:4b", default_context_length: 1024, label: ["vision", "single-turn"] },
    { ...qwen, model: "future-single-turn:4b", label: ["single-turn"] },
  ] }, null);
  if (!flash || !other) throw new Error("Missing models");
  expect(contextDetails(flash, { max_position_embeddings: 262144 }).tokens).toBe(1024);
  expect(contextDetails(flash, {}).kind).toBe("fixed");
  expect(contextDetails(other, { max_position_embeddings: 32768 }).tokens).toBe(32768);
});

test("native audio does not exclude Gemma from chat preload while auxiliary models stay separate", () => {
  const models = parseCatalog({ models: [
    { ...qwen, model: "gemma4-it:e2b", asr: true, details: { family: "gemma4e" } },
    { ...qwen, model: "whisper-v3:turbo", asr: true, details: { family: "whisper-v3" } },
    { ...qwen, model: "embed-gemma:300m", details: { family: "embed-gemma" }, label: ["embeddings"] },
  ] }, null);
  expect(models.map(model => model.kind)).toEqual(["chat", "speech", "embedding"]);
  expect(models[0]?.capabilities).toContain("audio");
});

test("rejects malformed command tags and ignores untrusted metadata link origins", () => {
  expect(() => parseCatalog({ models: [{ ...qwen, model: "--force" }] }, null)).toThrow();
  const [model] = parseCatalog({ models: [{ ...qwen, file_url: "http://127.0.0.1/private", url: "javascript:alert(1)" }] }, null);
  expect(model?.sourceUrl).toBeNull();
  expect(model?.configUrl).toBeNull();
});
