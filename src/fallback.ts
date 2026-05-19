/**
 * Per-item fallback factory (Plan §4.1).
 *
 * Returns a schema-valid minimal ItemOutput. Used in two situations:
 *   1) per-item try/catch caught an unexpected error inside the pipeline;
 *   2) (M1 only) the agent has not yet implemented a handler for an item
 *      that didn't trip the safeguard pre-flight — we still need to emit
 *      a valid output for every inbox item.
 *
 * The fallback preserves whatever tool calls were already recorded for
 * the item so audit trace + output stay in sync.
 */

import type { InboxItem, ItemOutput, ToolCall } from "./types.js";

export function makeFallbackOutput(
  item: InboxItem,
  reason: string,
  toolsCalled: ToolCall[] = [],
): ItemOutput {
  return {
    item_id: item.id,
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: [],
    tools_called: toolsCalled,
    recommended_next_action:
      "Staff to review this inbox item manually and route to the appropriate workflow.",
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Fallback path triggered: ${reason}`,
  };
}
