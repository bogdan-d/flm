# Qwen3.8-MTP context limit in FastFlowLM

Research date: 2026-10-17. Installed FLM: 1.0.9. No inference was run, services restarted, model weights downloaded, or user configuration changed.

## Finding

**FLM currently supports at most 8,192 tokens for `qwen3.8-mtp:27b`, with a 4,096-token default.** This is a restriction of the shipped FLM engine, not the original model's native context capacity. No verified public long-context workaround or released fix was found.

The [official FLM model card](https://fastflowlm.com/docs/models/qwen/#-model-card-qwen38-27b) explicitly lists 8k maximum and 4k default. The [original Qwen model card](https://huggingface.co/Qwen/Qwen3.8-27B/blob/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0/README.md) describes 262,144 native tokens. FLM's [packaged model configuration](https://huggingface.co/FastFlowLM/Qwen3.8-27B-NPU2/blob/071def594ad89b0dadd104a117722d6090a5fa26/config.json) also contains `max_position_embeddings: 262144`. That positional metadata does not override the compiled attention layout's runtime limit.

## Exact matching upstream reports

- [Issue #765](https://github.com/ROCm/FastFlowLM/issues/765) reports the same `attn_layout`, `max_len 131200`, and `MAX_L_LIMIT` error when requesting 131,072 tokens. An [FLM collaborator's response](https://github.com/ROCm/FastFlowLM/issues/765#issuecomment-5941986000) states that the supported maximum is 8K and links the model card. The issue was closed because of that support boundary, not because a code fix was delivered.
- [Issue #767](https://github.com/ROCm/FastFlowLM/issues/767) remains open. A [report explicitly using FLM 1.0.9](https://github.com/ROCm/FastFlowLM/issues/767#issuecomment-6224171084) confirms loading at up to 8,192 tokens and the same initialization failure above it, on another XDNA2 system with 64 GB RAM.

The user-supplied Strix Halo log independently establishes that 131,072 fails on this machine. A successful 8,192-token load on this exact machine was not tested during research.

## Why the error says 16,384 but the supported maximum is 8,192

Two kinds of evidence explain the apparent contradiction:

1. **Documented CLI behavior:** [FLM rounds non-power-of-two context requests upward](https://github.com/ROCm/FastFlowLM/blob/v1.0.9/docs/docs/instructions/cli.md) to a power of two.
2. **Independent reported measurement:** [a context sweep in #767](https://github.com/ROCm/FastFlowLM/issues/767#issuecomment-6098494523) found that requests above 8,192 through 16,384 enter the 16,384 bucket, then acquire an additional 128 tokens internally. The diagnostic consequently reports `max_len 16512` and 1,032 replay chunks, beyond the 1,024 that the layout's 10-bit buffer-descriptor dimension can walk.

The supplied log is consistent with this arithmetic: `131072 + 128 = 131200`, producing 8,200 chunks. The previous power-of-two bucket, 8,192, is the usable one. Choosing 16,000 instead does not avoid upward rounding.

The rounding is documented. The sweep and explanation of internal overhead are a community reproduction, not a published engine design specification. The exact reason for the extra 128 and whether a different layout could remove the restriction remain unconfirmed.

## Fix and workaround status

- [v1.0.7's documentation](https://github.com/ROCm/FastFlowLM/blob/v1.0.7/docs/docs/models/qwen.md) already specified 8k when support was introduced. A claim that 1.0.6 supported 16k was [subsequently questioned by its own reporter](https://github.com/ROCm/FastFlowLM/issues/767#issuecomment-6106628572). There is no sound basis for recommending a downgrade.
- [v1.0.9](https://github.com/ROCm/FastFlowLM/releases/tag/v1.0.9), released October 15, is the latest published release checked. Its changes concern Linux NPU validation and Windows installer packaging, not this context limit.
- [Upstream main at `d8767c0`](https://github.com/ROCm/FastFlowLM/blob/d8767c0a08febd4037356546d2df1bba99bba76e/docs/docs/models/qwen.md) still specifies 8k. The model-specific branch was behind main. No verified larger-context fix was found in the matching issues, releases, relevant PRs, or engine history checked.
- [PR #766](https://github.com/ROCm/FastFlowLM/pull/766) adds an HRX engine, but does not claim a context expansion. Both the installed library and upstream's HRX library contain the same `attn_layout`/`MAX_L_LIMIT`/10-bit diagnostic strings. This observation is not a runtime test of HRX, nor proof that every future engine will retain the limit.

No supported escape hatch was found involving prefill chunk size, performance mode, more RAM, thinking settings, YaRN, or the packaged configuration's undocumented `addr_qk` and `addr_kv` fields. The original model already allows 128K without positional extension, so raising positional metadata would not address this failure.

The [official card](https://fastflowlm.com/docs/models/qwen/#-model-card-qwen38-27b) describes MTP speculation as engine-managed. Generation sampling can affect whether speculative decoding runs, but the failure occurs while constructing the model. There is no evidence that disabling speculation lifts the initialization limit. The restriction is established for this Qwen3.8-MTP engine, not for speculation in general or every XDNA2 model.

## Practical implication

For this FLM model, use `--ctx-len 8192` and fit prompt, tool definitions, history, images, reasoning, and output within that allowance. This is the documented supported capacity, not a locally verified inference result.

For a long-context Pi session, use another model or serving implementation with the required supported capacity. FLM's [Qwen3.6-35B-A3B card](https://fastflowlm.com/docs/models/qwen/#-model-card-qwen36-35b-a3b) advertises 256k, and #765 reports that model working at 128K on the same machine that rejected Qwen3.8. Neither establishes successful full-context inference on this host. Other runtimes require their own compatible weights; FLM's `.q4nx` files are not automatically interchangeable.

The dashboard should distinguish the documented 8K FLM runtime maximum from the 262,144-token architecture ceiling and guard incompatible global overrides. Its Pi export currently caps this model at the 4,096-token catalog default even if FLM is started at 8,192. No dashboard behavior was changed in this research.

Still unknown: the maintainers' attention-layout design rationale, any unpublished expansion work, and a specific tested fix above 8,192. A versioned engine/kernel change with an actual long-context test would be needed to establish that the restriction has been removed.
