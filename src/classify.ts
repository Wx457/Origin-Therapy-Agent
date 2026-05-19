/**
 * Rules-based classifier (Plan §4.1 decision tree).
 *
 * Used as the fallback when the LLM assessment fails or when safeguarding
 * pre-flight already short-circuited (safeguarding routing happens upstream
 * in agent.ts; this module never returns "safeguarding").
 *
 * Decision tree order matters — earlier branches dominate later ones.
 */

import type { Channel, Classification, InboxItem, Urgency } from "./types.js";
import type { ExtractedFields } from "./extract.js";

export interface ClassifyResult {
  classification: Classification;
  urgency: Urgency;
  rationale_seed: string;
  same_day_cancel: boolean;
}

const SPAM_CUES = [
  "unsubscribe",
  "click here",
  "limited offer",
  "promo code",
  "act now",
  "free trial",
  "viagra",
];

const RESCHEDULE_CUES = [
  "reschedule",
  "can't make",
  "cant make",
  "cannot make",
  "cancel",
  "move my appointment",
  "need to change",
  "throw up",
  "threw up",
  "throwing up",
];

const SAME_DAY_CUES = [
  "today",
  "today's",
  "todays",
  "this morning",
  "this afternoon",
  "tonight",
  "right now",
];

const QUESTION_ONLY_CUES = [
  "is it normal",
  "should i worry",
  "should i be worried",
  "should we wait",
  "do you think",
  "is this normal",
  "wait until",
  "before booking",
  "appreciate advice",
];

const EXISTING_PATIENT_CUES = [
  "my appointment",
  "our visit",
  "our next session",
  "our therapist",
  "my child's therapist",
  "our previous",
];

export function classify(item: InboxItem, fields: ExtractedFields): ClassifyResult {
  const text = item.body.toLowerCase();

  if (SPAM_CUES.some((cue) => text.includes(cue))) {
    return {
      classification: "spam",
      urgency: "P3",
      rationale_seed: "matched spam cues in body",
      same_day_cancel: false,
    };
  }

  const isReschedule = RESCHEDULE_CUES.some((cue) => text.includes(cue));
  const isSameDay = SAME_DAY_CUES.some((cue) => text.includes(cue));
  if (isReschedule && isSameDay) {
    return {
      classification: "scheduling",
      urgency: "P1",
      rationale_seed: "same-day reschedule cues present",
      same_day_cancel: true,
    };
  }

  if (item.channel === "fax_referral" && fields.blank_field_count >= 3) {
    return {
      classification: "missing_paperwork",
      urgency: "P2",
      rationale_seed: `fax referral with ${fields.blank_field_count} blank fields`,
      same_day_cancel: false,
    };
  }

  const isQuestionOnly = QUESTION_ONLY_CUES.some((cue) => text.includes(cue));
  const isMessagingChannel: Channel[] = ["portal_message", "email"];
  if (
    isMessagingChannel.includes(item.channel) &&
    isQuestionOnly &&
    !fields.payer &&
    !fields.member_id
  ) {
    return {
      classification: "clinical_question",
      urgency: "P3",
      rationale_seed: "messaging channel with clinical question and no insurance details",
      same_day_cancel: false,
    };
  }

  if (
    fields.child_name &&
    fields.discipline &&
    (fields.payer || fields.member_id)
  ) {
    return {
      classification: "new_referral",
      urgency: "P2",
      rationale_seed: "child + discipline + insurance present",
      same_day_cancel: false,
    };
  }

  if (isReschedule || EXISTING_PATIENT_CUES.some((cue) => text.includes(cue))) {
    return {
      classification: "existing_patient_request",
      urgency: "P2",
      rationale_seed: "reschedule or existing patient cues",
      same_day_cancel: isReschedule && isSameDay,
    };
  }

  return {
    classification: "other",
    urgency: "P2",
    rationale_seed: "no decisive cues; default routing",
    same_day_cancel: false,
  };
}
