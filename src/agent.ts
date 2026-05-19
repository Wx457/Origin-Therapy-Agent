/**
 * Final agent pipeline (Plan §3.1 / §4.1).
 *
 *   Step 0    hasSafeguardSignal(body)              ← rules-first preflight
 *   Step 1    assessItem(item)                       ← single LLM call
 *             (skipped when sg.hit; falls back to synthesizeFromRules
 *             on LLMAssessmentError so a single LLM outage does not
 *             collapse the batch)
 *   Step 1.5  Hard P0 override                       ← rules OR LLM
 *   Step 2    pickHandler(classification)(item, assessment)
 *   Step 3    sanitizeDraft inside each handler before draft_message
 *   Step 4    assembleOutput                         ← tools_called via
 *                                                     getToolCallsForItem
 *
 * Audit invariants:
 *   - every item-level tool call is inside withItemContext(item.id, ...)
 *   - tools_called[] is getToolCallsForItem(item.id) unchanged; handlers
 *     never construct ToolCall objects themselves
 *   - buildBatchOutput stays in src/index.ts; this module returns
 *     ItemOutput[] only
 */

import { getToolCallsForItem, withItemContext } from "./tools.js";
import { hasSafeguardSignal, type SafeguardCheck } from "./safeguard.js";
import { makeFallbackOutput } from "./fallback.js";
import { extractFields, type ExtractedFields } from "./extract.js";
import { classify } from "./classify.js";
import { assessItem, LLMAssessmentError, type LLMAssessment } from "./llm.js";
import { pickHandler, type HandlerOutcome } from "./handlers.js";
import type { InboxItem, ItemOutput } from "./types.js";

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  return Promise.all(inbox.map((item) => processItem(item)));
}

async function processItem(item: InboxItem): Promise<ItemOutput> {
  try {
    return await withItemContext(item.id, () => runPipeline(item));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[agent] pipeline failed for ${item.id}: ${reason}; emitting fallback.`);
    const toolsCalled = getToolCallsForItem(item.id);
    return makeFallbackOutput(item, reason, toolsCalled);
  }
}

async function runPipeline(item: InboxItem): Promise<ItemOutput> {
  // Step 0: rules-first safeguarding preflight.
  const sg = hasSafeguardSignal(item.body);

  // Step 1: LLM assessment (skipped when sg.hit; rules fallback on error).
  let assessment: LLMAssessment;
  if (sg.hit) {
    assessment = synthesizeFromRules(item, sg);
  } else {
    try {
      assessment = await assessItem(item);
    } catch (err) {
      const reason = err instanceof LLMAssessmentError ? err.message : String(err);
      console.warn(`[agent] LLM assessment failed for ${item.id}: ${reason}; falling back to rules.`);
      assessment = synthesizeFromRules(item);
    }
  }

  // Step 1.5: hard P0 override if either layer flagged safeguarding.
  if (sg.hit || assessment.safeguarding_signal) {
    assessment = {
      ...assessment,
      classification: "safeguarding",
      urgency: "P0",
      safeguarding_signal: true,
    };
  }

  // Step 2: deterministic handler dispatch. Steps 3/4 are inside the
  // handler + assembleOutput respectively.
  const handler = pickHandler(assessment.classification);
  const outcome = await handler(item, assessment);

  return assembleOutput(item, assessment, outcome);
}

function assembleOutput(
  item: InboxItem,
  assessment: LLMAssessment,
  outcome: HandlerOutcome,
): ItemOutput {
  return {
    item_id: item.id,
    classification: assessment.classification,
    urgency: assessment.urgency,
    requires_human_review: true,
    extracted_intake: assessment.extracted_intake,
    missing_info: outcome.missing_info ?? assessment.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: outcome.recommended_next_action,
    draft_reply: outcome.draft_reply,
    task_ids: outcome.task_ids,
    escalation: outcome.escalation,
    decision_rationale: outcome.decision_rationale,
  };
}

function synthesizeFromRules(item: InboxItem, sg?: SafeguardCheck): LLMAssessment {
  const fields = extractFields(item);
  const classification = classify(item, fields);

  const fallbackSafeguarding = Boolean(sg?.hit);
  const finalClassification = fallbackSafeguarding ? "safeguarding" : classification.classification;
  const finalUrgency = fallbackSafeguarding ? "P0" : classification.urgency;

  const rationale = fallbackSafeguarding
    ? `Safeguarding signal detected via rules pre-flight (matched: ${sg!.matched.join(", ")}).`
    : `Rules-based fallback assessment: ${classification.rationale_seed}.`;

  return {
    classification: finalClassification,
    urgency: finalUrgency,
    language: fields.preferred_language,
    extracted_intake: stripFieldsForIntake(fields),
    safeguarding_signal: fallbackSafeguarding,
    same_day_cancel: classification.same_day_cancel,
    missing_info: fields.missing_info,
    rationale,
  };
}

function stripFieldsForIntake(fields: ExtractedFields): LLMAssessment["extracted_intake"] {
  return {
    child_name: fields.child_name,
    dob_or_age: fields.dob_or_age,
    parent_contact: fields.parent_contact,
    discipline: fields.discipline,
    diagnosis_or_concern: fields.diagnosis_or_concern,
    payer: fields.payer,
    member_id: fields.member_id,
  };
}
