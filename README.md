# Origin AI Engineering Take-Home — Cedar Kids Therapy Referral Inbox Triage Agent

## 1. How to run

```bash
npm install
cp .env.example .env       # then set ANTHROPIC_API_KEY (.env is gitignored)
npx tsx scripts/check-llm-key.ts                          # optional: confirm key works end-to-end
npm run triage    -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate  -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

All flags are optional; both commands default to the paths shown. Nothing in `src/` hardcodes a path, so reviewers can rerun against hidden synthetic input. End-to-end runtime on a capped Anthropic key: **~10–15 s** for the 8-item batch.

## 2. Stack and runtime

- **Language**: TypeScript on Node LTS (≥ 18) via `tsx`. Tested on Node 24.15.0.
- **Dependencies added**: `@anthropic-ai/sdk`, `dotenv`. Nothing else; `ajv` + `tsx` were already in the starter.
- **Runtime LLM usage**: Anthropic Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`), one call per item, `temperature: 0`, assistant prefill `{` for JSON discipline. Model is overridable via `ANTHROPIC_MODEL` in `.env`. The pipeline degrades to a pure rules path on any LLM failure (see §3).
- **Concurrency**: `Promise.all` over the 8 items, no rate limiter. A single capped Anthropic key handles the peak ~4 RPS comfortably; per-item `try/catch` + rules fallback keeps the batch alive if any one LLM call fails.
- **Validation**: starter-provided `ajv` + `schema/output.schema.json`. No second schema (no Zod).
- **AI coding assistant used while building**: Cursor IDE with Claude Opus 4.7.

Starter files in `src/tools.ts`, `src/types.ts`, `src/validate.ts`, `data/`, and `schema/` are **unmodified**. New modules are listed in the Module map below.

## 3. Architecture

The agent processes each inbox item independently. A single LLM call produces a JSON assessment; a deterministic dispatcher then chooses tools. A rules-first layer runs before the LLM specifically for safeguarding, so a false negative in the LLM cannot, on its own, drop a P0.

**Pipeline (per item, inside `withItemContext(item.id, ...)`):**

1. **Step 0 · `hasSafeguardSignal`** (`src/safeguard.ts`). Two-tier keyword preflight: Tier 1 high-confidence phrases + Tier 2 weak words within a ±40-char caregiver window, with a negative-idiom filter. Can independently force `urgency="P0"` before the LLM is called.
2. **Step 1 · `assessItem`** (`src/llm.ts`). One Anthropic call, `temperature: 0`, assistant prefill `{` to force pure JSON. Returns classification, urgency, language, extracted intake, `safeguarding_signal`, and a rationale. On any failure the per-item `try/catch` falls back to `synthesizeFromRules` (`src/extract.ts` + `src/classify.ts`), so a single LLM outage does not drop the item.
3. **Step 1.5 · Hard P0 override.** If either the rules layer or the LLM flags safeguarding, classification becomes `safeguarding` and urgency becomes `P0`. Either signal is enough; both must agree to clear it.
4. **Step 2 · `pickHandler`** (`src/handlers.ts`). One handler per workflow (8 total). The dispatcher, not the LLM, decides which tools to call.
5. **Step 3 · `sanitizeDraft`** (`src/draft_safety.ts`). Runs **before** every `draft_message` so the audit trace never records an unsafe body. Clinical-advice phrases ("diagnose", "treatment plan", "you should…") and false-execution phrases ("we have sent", "appointment booked") are swapped for a neutral fallback.
6. **Step 4 · `assembleOutput`** (`src/agent.ts`). `tools_called` is `getToolCallsForItem(item.id)` unchanged, so trace and output cannot drift apart.

**Module map:**

| File | Role | Modified? |
|---|---|---|
| `src/agent.ts` | Pipeline orchestrator + `synthesizeFromRules` + `assembleOutput` | new |
| `src/safeguard.ts` | Two-tier rules-first P0 detector + inline smoke check (`npx tsx src/safeguard.ts`) | new |
| `src/llm.ts` | Anthropic call, prompt, prefill `{`, JSON validation, `LLMAssessmentError` | new |
| `src/extract.ts` | Regex-based intake extractor (used only when LLM fails) | new |
| `src/classify.ts` | Cue-table rules classifier (used only when LLM fails) | new |
| `src/handlers.ts` | 8 deterministic handlers + 5 shared invocation conventions | new |
| `src/draft_safety.ts` | Final-mile draft body filter | new |
| `src/fallback.ts` | Schema-valid minimal `ItemOutput` factory | new |
| `src/index.ts` | Starter — one line added: `import "dotenv/config";` | mod (1 line) |
| `src/tools.ts` / `src/types.ts` / `src/validate.ts` | Starter, **not modified** | — |
| `scripts/check-llm-key.ts` | One-shot smoke test for `.env` + key | new |

**Per-item tool chain:**

| Item | Classification / urgency | Tools called (in order) | Rationale highlight |
|---|---|---|---|
| `item_1` Emma Lee, BCBS PPO | `new_referral` / P2 | `search_patient` → `verify_insurance` (in_network) → `find_slots` (SLP, en) → `draft_message` | Complete fax referral; no patient match → staff to verify identity before any hold. |
| `item_2` Maria Gomez voicemail | **`safeguarding` / P0** | `lookup_policy` (safeguarding) → `escalate` (P0) → `create_task` (clinical_lead, due +1h) → `draft_message` | Tier-2 rules catch "his dad started getting rough"; all scheduling deferred pending clinical lead review. |
| `item_3` Owen Brooks, Kaiser HMO | `new_referral` / P2 | `search_patient` → `verify_insurance` (out_of_network) → `lookup_policy` (insurance) → `create_task` (billing) → `draft_message` | OON per billing → benefits conversation required before any hold. **No `hold_slot`.** |
| `item_4` Mateo Ramirez, Aetna PPO | `new_referral` / P2 | `search_patient` (**hit** `pat_mateo_ramirez_jr`) → `verify_insurance` (in_network) → `find_slots` (PT, en) → `hold_slot` → `draft_message` | Existing patient + in-network → safe to place a `pending_review` hold for staff to confirm. |
| `item_5` Jordan Kim "R sounds" | `clinical_question` / P3 | `lookup_policy` (clinical_advice) → `draft_message` | Pure developmental question; draft explicitly declines clinical guidance over message and offers a screening/evaluation pathway. |
| `item_6` Sam Taylor incomplete fax | `missing_paperwork` / P2 | `create_task` (intake) → `draft_message` (to referring office) | Four blank required fields → recipient on the draft is the referring office, not the family. |
| `item_7` Ana Lopez voicemail Spanish | `new_referral` / P2 | `search_patient` → `verify_insurance` (in_network, Medicaid) → `find_slots` (SLP, es) → `draft_message` (es) | Bilingual provider match (Lucia Morales); draft is in Spanish. |
| `item_8` Noah Patel "URGENT reschedule today" | **`scheduling` / P1** | `search_patient` (**hit** `pat_noah_patel`) → `lookup_policy` (scheduling) → `find_slots` (OT) → `hold_slot` → `create_task` (front_desk, due +1h) → `draft_message` | Same-day cancel → P1; existing patient + in-network → hold a replacement slot for human confirmation. |

**Five shared handler conventions** so trace, output, and audit stay in lockstep:

1. `escalate.item_id` is always `item.id`.
2. `hold_slot.patient_ref` uses the `patient_id` from a positive `search_patient` hit; otherwise a synthetic `new_referral:<slug>` form, never empty.
3. Every `create_task` return value contributes its `task_id` to `task_ids[]`.
4. `find_slots` returning 0 triggers a graceful branch: skip `hold_slot`, open a `front_desk` follow-up task, draft a generic "team will follow up" body.
5. Every draft body passes through `sanitizeDraft` **before** `draft_message` — never after.

**Tool coverage:** all 8 starter tools (`search_patient`, `verify_insurance`, `lookup_policy`, `find_slots`, `hold_slot`, `create_task`, `draft_message`, `escalate`) are exercised across the batch. Validator threshold is ≥ 3; we ship 8/8.

## 4. Failure modes and production eval

**Known failure modes and how this build mitigates them:**

| Failure mode | Mitigation in this build | Production addition |
|---|---|---|
| LLM misses an indirect safeguarding signal | Rules-first Tier 1 + Tier 2 preflight runs **before** the LLM; either layer can force P0 | Independent secondary safeguarding classifier (different prompt / different model) running async |
| LLM hallucinates payer / DOB | Prompt says "DO NOT INFER"; regex fallback uses literal body only | Field-level confidence scores; values below threshold go to `missing_info` instead of downstream tools |
| LLM returns malformed JSON / rate-limits / 5xx | Prefill `{` + `temp: 0` + strict validator; on throw the per-item `try/catch` falls back to rules-only assessment + standard handler; batch still passes validator | Strict JSON-mode model + bounded retry with exponential backoff; `p-limit` for explicit cap |
| Draft contains clinical advice or implies sent/booked | `sanitizeDraft` rewrites before `draft_message`; unsafe body never reaches the trace | Async LLM-judge audit on sampled drafts |
| Referral payer disagrees with billing system | `verify_insurance` wins per policy; conflict written into `decision_rationale` | Real-time billing pull |
| All providers full / no bilingual capacity (`find_slots` = 0) | Graceful branch: skip hold, open `front_desk` task, neutral draft | Capacity-trend alerting + provider load-balancing |

**Metrics I'd evaluate in production:**

- **P0 recall ≥ 99 %** on a labeled adversarial set — false negatives are the most expensive outcome.
- **P0 precision ≥ 80 %** — over-escalation floods the clinical-lead pager and trains staff to ignore it.
- **Schema pass rate = 100 %** + **LLM latency p95 < 3 s/item** (today's batch sits well inside both).
- **Draft edit distance** — how many characters staff changed after reviewing. Low edit distance = templates match reality.

**Continuous eval harness, in priority order:**

- Labeled golden set (30–100 items) committed under `eval/` and run in CI on every PR; regression below threshold fails the build.
- Adversarial paraphrasing set focused on indirect safeguarding disclosures and English/Spanish code-switching. Recall on this set is the gate.
- Async LLM-judge audit on sampled drafts: clinical-advice leakage, false "implies sent" wording, tone/cultural fit.

## 5. What I chose not to build, and why

- **Multi-turn agentic loop / LLM-driven tool use.** Two clean stages (LLM → JSON assessment, deterministic dispatcher → tool calls) keep the audit trace tight and the validator happy. 8 items don't need runtime tool choice.
- **Vercel AI SDK / LangChain / similar.** Their tool wrappers bypass `src/tools.ts`'s audit recording, which would fail the validator's trace-match check.
- **Runtime schema library (Zod / Yup).** `schema/output.schema.json` is already the contract; adding Zod just duplicates it.
- **Persistent patient DB / PDF attachment parsing.** Both are mock tooling here; either would be demo-ware.
- **Concurrency limiter (`p-limit`).** A capped Sonnet 4.5 key handles ~4 RPS comfortably; per-item `try/catch` + rules fallback already covers a real rate-limit event.

## 6. What I'd do with another 4 hours

1. **Adversarial safeguarding eval set + golden regression set** wired as a CI gate; recall < 95 % on the safeguarding subset fails the build.
2. **Dedicated secondary safeguarding classifier** running async with a different prompt; either it or the main assessment can force P0.
3. **Field-level confidence scoring** from the LLM (`extraction_confidence: { child_name: 0–1, ... }`); below-threshold values land in `missing_info` and never reach a tool call.
4. **Unit tests per module.** `safeguard.ts` already has an inline smoke check; same pattern applied to `extract.ts`, `classify.ts`, `handlers.ts`, `draft_safety.ts`, wired into `npm test`.
5. **Clarification draft on `missing_paperwork`** that lists exactly which fields are blank so the referring office can fill them in one click.
6. **Async LLM-judge audit** on sampled draft bodies across clinical-advice / "implies sent" / tone, results written into structured logs.
