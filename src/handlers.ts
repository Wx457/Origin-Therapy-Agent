/**
 * Deterministic handler dispatch (Plan §5 tool chains + §4.1 five
 * shared invocation conventions).
 *
 * Each handler receives (item, assessment) and returns a HandlerOutcome.
 * tools_called is NOT included here — agent.ts reads it via
 * getToolCallsForItem(item.id) and assembles the final ItemOutput.
 *
 * Five shared conventions enforced across handlers:
 *   1) escalate.item_id is always item.id.
 *   2) hold_slot.patient_ref uses the patient_id from a positive
 *      search_patient hit, otherwise the synthetic
 *      "new_referral:<slug>" / "new_referral:item_<id>" form.
 *   3) Each create_task's returned task_id is appended to
 *      outcome.task_ids.
 *   4) find_slots returning 0 slots triggers the graceful branch:
 *      skip hold_slot, create a front_desk follow-up task, draft
 *      a generic "team will follow up" body.
 *   5) Every draft body passes through sanitizeDraft BEFORE being
 *      handed to draft_message, never after.
 */

import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  hold_slot,
  lookup_policy,
  search_patient,
} from "./tools.js";
import { sanitizeDraft } from "./draft_safety.js";
import type { LLMAssessment } from "./llm.js";
import type {
  Discipline,
  InboxItem,
  Patient,
} from "./types.js";

export interface HandlerOutcome {
  draft_reply: string | null;
  recommended_next_action: string;
  task_ids: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  decision_rationale: string;
  missing_info: string[];
}

export type Handler = (item: InboxItem, assessment: LLMAssessment) => Promise<HandlerOutcome>;

const HANDLERS: Record<string, Handler> = {
  safeguarding: handleSafeguarding,
  new_referral: handleNewReferral,
  existing_patient_request: handleExistingPatientRequest,
  scheduling: handleScheduling,
  clinical_question: handleClinicalQuestion,
  missing_paperwork: handleMissingPaperwork,
  billing_question: handleOther,
  provider_followup: handleOther,
  complaint: handleOther,
  spam: handleSpam,
  other: handleOther,
};

export function pickHandler(classification: string): Handler {
  return HANDLERS[classification] ?? handleOther;
}

// ---------------------------------------------------------------------------
// safeguarding handler (Plan §5 item_2)
// ---------------------------------------------------------------------------

async function handleSafeguarding(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const reason =
    `Safeguarding signal detected for ${item.id}. Per policy any disclosure of harm, abuse, ` +
    "neglect, or unsafe caregiving is P0 with same-hour clinical lead escalation.";

  await lookup_policy({ topic: "safeguarding" });

  await escalate({
    item_id: item.id,
    reason,
    severity: "P0",
  });

  const dueAt = oneHourFromNowIso();
  const bodySnippet = item.body.slice(0, 220).replace(/\s+/g, " ").trim();
  const taskResult = await create_task({
    assignee: "clinical_lead",
    title: `Same-hour safeguarding review: ${item.id}`,
    due: dueAt,
    notes:
      `Inbound ${item.channel} from ${item.sender} flagged for safeguarding. ` +
      `Excerpt: "${bodySnippet}". Do not respond to any scheduling or eval request ` +
      "in this thread until cleared.",
  });

  const neutralDraft =
    assessment.language === "es"
      ? "Gracias por comunicarse con nosotros. Un miembro del equipo se pondra en contacto con usted directamente para coordinar los proximos pasos."
      : "Thank you for reaching out about your child. A member of our team will follow up with you directly to discuss next steps.";

  const safeBody = sanitizeDraft(neutralDraft, assessment.language).body;
  await draft_message({
    recipient: inferRecipient(item),
    channel: inferDraftChannel(item),
    body: safeBody,
    language: assessment.language,
  });

  return {
    draft_reply: safeBody,
    recommended_next_action:
      "Clinical lead to review within the hour. Hold all scheduling, eval, and billing workflows on this thread until clinical lead clears the message.",
    task_ids: [taskResult.data.task_id],
    escalation: { reason, severity: "P0" },
    decision_rationale:
      `${assessment.rationale} Safeguarding signal supersedes any eval/scheduling request in the ` +
      "same message; defer all scheduling pending clinical lead review. Draft reply is a neutral " +
      "acknowledgement only - no clinical advice and no investigative questions.",
    missing_info: assessment.missing_info,
  };
}

// ---------------------------------------------------------------------------
// new_referral handler (Plan §5 item_1, item_3, item_4, item_7)
// ---------------------------------------------------------------------------

async function handleNewReferral(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const intake = assessment.extracted_intake;
  const childName = intake.child_name ?? "the family";
  const discipline = (intake.discipline?.[0] ?? "SLP") as Discipline;
  const language = assessment.language;

  const patientResult = await search_patient({
    name: intake.child_name ?? undefined,
    dob: intake.dob_or_age && /^\d{4}-\d{2}-\d{2}$/.test(intake.dob_or_age)
      ? intake.dob_or_age
      : undefined,
  });
  const matchedPatient: Patient | undefined = patientResult.data[0];
  const patientRef =
    matchedPatient?.patient_id ?? synthesizePatientRef(item, intake.child_name);

  const insuranceResult = await verifyInsurance(intake);

  const status = insuranceResult.data.status;
  const payerLabel = intake.payer ?? "the payer";

  if (status === "out_of_network") {
    await lookup_policy({ topic: "insurance" });

    const taskNotes =
      `${payerLabel} verified out-of-network for ${childName}. Per policy any slot hold ` +
      "must wait until billing completes a benefits conversation with the family.";
    const taskResult = await create_task({
      assignee: "billing",
      title: `Discuss out-of-network benefits for ${childName}`,
      due: oneBusinessDayIso(),
      notes: taskNotes,
    });

    const draftBody =
      language === "es"
        ? `Hola ${parentFirstName(intake.parent_contact, "familia")}, gracias por enviar la referencia de ${childName}. El plan de ${payerLabel} aparece como fuera de la red en nuestro sistema, por lo que nuestro equipo de facturacion se comunicara con usted para revisar las opciones antes de coordinar la cita.`
        : `Hi ${parentFirstName(intake.parent_contact, "there")}, thank you for sending ${childName}'s referral. ${payerLabel} appears to be out-of-network for Cedar Kids Therapy, so our billing team will be in touch to walk through benefits options before we move forward with scheduling.`;
    const safeDraft = sanitizeDraft(draftBody, language);
    await draft_message({
      recipient: inferRecipient(item),
      channel: inferDraftChannel(item),
      body: safeDraft.body,
      language,
    });

    return {
      draft_reply: safeDraft.body,
      recommended_next_action:
        "Billing to review out-of-network options with the family before staff considers any appointment hold.",
      task_ids: [taskResult.data.task_id],
      escalation: null,
      decision_rationale:
        `Referral has sufficient intake for ${discipline}, but verify_insurance returned ` +
        `out_of_network for ${payerLabel}. Policy requires a benefits conversation before any slot ` +
        `hold or scheduling step. Billing system result takes precedence over the referral document. ` +
        `${assessment.rationale}`,
      missing_info: assessment.missing_info,
    };
  }

  if (status === "expired") {
    const taskResult = await create_task({
      assignee: "billing",
      title: `Resolve expired coverage for ${childName}`,
      due: oneBusinessDayIso(),
      notes:
        `verify_insurance shows ${payerLabel} as expired-on-file. Billing to contact the family ` +
        "to confirm current coverage before any scheduling action.",
    });

    const draftBody =
      language === "es"
        ? `Hola ${parentFirstName(intake.parent_contact, "familia")}, gracias por enviar la referencia de ${childName}. La cobertura de ${payerLabel} aparece como vencida en nuestro sistema. Un miembro del equipo de facturacion se comunicara con usted para confirmar la cobertura actual antes de coordinar la cita.`
        : `Hi ${parentFirstName(intake.parent_contact, "there")}, thank you for sending ${childName}'s referral. Our billing system shows ${payerLabel} coverage as expired, so our team will reach out to confirm current coverage before we move forward with scheduling.`;
    const safeDraft = sanitizeDraft(draftBody, language);
    await draft_message({
      recipient: inferRecipient(item),
      channel: inferDraftChannel(item),
      body: safeDraft.body,
      language,
    });

    return {
      draft_reply: safeDraft.body,
      recommended_next_action:
        "Billing to contact the family to update insurance information; hold all scheduling until coverage is confirmed.",
      task_ids: [taskResult.data.task_id],
      escalation: null,
      decision_rationale:
        `Referral has sufficient intake for ${discipline}, but verify_insurance returned expired ` +
        `for ${payerLabel}. Billing system supersedes referral document; coverage must be confirmed ` +
        `before scheduling. ${assessment.rationale}`,
      missing_info: assessment.missing_info,
    };
  }

  // in_network or unknown → proceed to slot search
  const slotsResult = await find_slots({
    discipline,
    language,
  });

  if (slotsResult.data.length === 0) {
    return await gracefulNoSlots({
      item,
      assessment,
      childName,
      discipline,
      reason:
        `Referral has sufficient intake for ${discipline}, insurance is ${status}, but ` +
        `find_slots returned 0 matching slots for ${discipline}/${language}.`,
    });
  }

  const earliest = slotsResult.data[0];

  // §5: item_4 (search_patient hit + in_network) goes find_slots → hold_slot →
  // draft_message. item_1 / item_7 (no patient match) stop short of hold_slot
  // so staff can confirm identity before any slot is taken out of the pool.
  let holdId: string | null = null;
  if (matchedPatient) {
    const holdResult = await hold_slot({
      slot_id: earliest.slot_id,
      patient_ref: patientRef,
    });
    holdId = holdResult.data.hold_id;
  }

  const draftBody =
    language === "es"
      ? holdId
        ? `Hola ${parentFirstName(intake.parent_contact, "familia")}, gracias por enviar la referencia de ${childName}. El equipo aparto un horario tentativo el ${formatSlotDate(earliest.start, language)} con ${earliest.provider_name} mientras un miembro del personal confirma los detalles con usted antes de coordinar la cita.`
        : `Hola ${parentFirstName(intake.parent_contact, "familia")}, gracias por enviar la referencia de ${childName}. Recibimos la solicitud para ${disciplineLabel(discipline, language)} y el equipo identifico un horario inicial el ${formatSlotDate(earliest.start, language)} con ${earliest.provider_name}. Un miembro del equipo se comunicara con usted para confirmar los detalles antes de coordinar la cita.`
      : holdId
        ? `Hi ${parentFirstName(intake.parent_contact, "there")}, thank you for sending ${childName}'s referral. The team has placed a tentative hold on ${formatSlotDate(earliest.start, language)} with ${earliest.provider_name} while a staff member reaches out to confirm the details with you before anything is finalised.`
        : `Hi ${parentFirstName(intake.parent_contact, "there")}, thank you for sending ${childName}'s referral. We received the request for ${disciplineLabel(discipline, language)} and the team has identified an earliest tentative opening on ${formatSlotDate(earliest.start, language)} with ${earliest.provider_name}. A staff member will reach out to confirm the details with you before any appointment is finalised.`;

  const safeDraft = sanitizeDraft(draftBody, language);
  await draft_message({
    recipient: inferRecipient(item),
    channel: inferDraftChannel(item),
    body: safeDraft.body,
    language,
  });

  return {
    draft_reply: safeDraft.body,
    recommended_next_action: matchedPatient
      ? `Front desk to confirm ${formatSlotDate(earliest.start, "en")} with ${earliest.provider_name} for existing patient ${matchedPatient.name} (hold id ${holdId}, pending_review).`
      : `Front desk to reach out to confirm ${formatSlotDate(earliest.start, "en")} with ${earliest.provider_name} for ${childName}; no hold placed until identity confirmed.`,
    task_ids: [],
    escalation: null,
    decision_rationale:
      `Complete intake for ${discipline} with in-network insurance (${payerLabel}, status=${status}). ` +
      `${matchedPatient ? `search_patient matched existing record ${matchedPatient.patient_id}; hold ${holdId} placed on ${earliest.slot_id} (pending_review).` : "search_patient returned no existing record; staff to verify identity before any slot is taken out of the pool, so no hold placed."} ` +
      `find_slots returned ${slotsResult.data.length} options. ` +
      `Audit: patient_ref="${patientRef}". ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

// Subset of new_referral that also issues hold_slot when the LLM
// extracted enough context to safely propose holding (item_4).
async function handleNewReferralWithHold(
  _item: InboxItem,
  _assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  throw new Error("Unused stub; handleNewReferral does both paths.");
}

// ---------------------------------------------------------------------------
// existing_patient_request handler (fallback for non-same-day reschedules)
// ---------------------------------------------------------------------------

async function handleExistingPatientRequest(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const intake = assessment.extracted_intake;
  const childName = intake.child_name ?? "the family";

  const patientResult = await search_patient({
    name: intake.child_name ?? undefined,
    dob: intake.dob_or_age && /^\d{4}-\d{2}-\d{2}$/.test(intake.dob_or_age)
      ? intake.dob_or_age
      : undefined,
  });

  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Follow up on existing-patient request for ${childName}`,
    due: oneBusinessDayIso(),
    notes:
      `Inbound ${item.channel} from ${item.sender} flagged as existing-patient request. ` +
      `Excerpt: "${item.body.slice(0, 200).replace(/\s+/g, " ").trim()}". Front desk to ` +
      "review and respond.",
  });

  const draftBody =
    assessment.language === "es"
      ? `Hola ${parentFirstName(intake.parent_contact, "familia")}, recibimos su mensaje sobre ${childName}. Un miembro del equipo de recepcion se comunicara con usted para coordinar los proximos pasos.`
      : `Hi ${parentFirstName(intake.parent_contact, "there")}, we received your message about ${childName}. A member of our front desk team will follow up with you directly to coordinate next steps.`;
  const safeDraft = sanitizeDraft(draftBody, assessment.language);
  await draft_message({
    recipient: inferRecipient(item),
    channel: inferDraftChannel(item),
    body: safeDraft.body,
    language: assessment.language,
  });

  return {
    draft_reply: safeDraft.body,
    recommended_next_action: patientResult.data[0]
      ? `Front desk to follow up on existing-patient request for ${patientResult.data[0].name}.`
      : "Front desk to confirm patient identity before further action.",
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      `Inbound request appears to come from an existing family. search_patient ${patientResult.data.length > 0 ? `matched ${patientResult.data[0].name}` : "returned no record"}. ` +
      `Routing to front desk for manual review. ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

// ---------------------------------------------------------------------------
// scheduling handler (Plan §5 item_8 - same-day cancel / reschedule)
// ---------------------------------------------------------------------------

async function handleScheduling(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const intake = assessment.extracted_intake;
  const childName = intake.child_name ?? "the family";
  const discipline = (intake.discipline?.[0] ?? "OT") as Discipline;
  const language = assessment.language;

  const patientResult = await search_patient({
    name: intake.child_name ?? undefined,
    dob: intake.dob_or_age && /^\d{4}-\d{2}-\d{2}$/.test(intake.dob_or_age)
      ? intake.dob_or_age
      : undefined,
  });
  const matchedPatient: Patient | undefined = patientResult.data[0];
  const patientRef =
    matchedPatient?.patient_id ?? synthesizePatientRef(item, intake.child_name);

  await lookup_policy({ topic: "scheduling" });

  const slotsResult = await find_slots({
    discipline,
    language,
  });

  if (slotsResult.data.length === 0) {
    return await gracefulNoSlots({
      item,
      assessment,
      childName,
      discipline,
      reason:
        `Same-day reschedule for ${childName} (${discipline}), but find_slots returned 0 ` +
        "matching slots. Front-desk outreach required.",
      severity: "P1",
    });
  }

  const earliest = slotsResult.data[0];
  const holdResult = await hold_slot({
    slot_id: earliest.slot_id,
    patient_ref: patientRef,
  });

  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Same-day reschedule follow-up: ${item.id}`,
    due: oneHourFromNowIso(),
    notes:
      `Same-day reschedule for ${childName} (${discipline}). Hold placed on ` +
      `${earliest.slot_id} (${formatSlotDate(earliest.start, "en")}) pending family confirmation. ` +
      `Original message excerpt: "${item.body.slice(0, 180).replace(/\s+/g, " ").trim()}". ` +
      "Front desk to call the family within the hour to confirm.",
  });

  const draftBody =
    language === "es"
      ? `Hola ${parentFirstName(intake.parent_contact, "familia")}, recibimos su mensaje para reprogramar la cita de ${childName} de hoy. El equipo identifico un horario tentativo el ${formatSlotDate(earliest.start, language)} con ${earliest.provider_name} y lo apartamos para revision. Un miembro del equipo se comunicara con usted dentro de la siguiente hora para confirmar.`
      : `Hi ${parentFirstName(intake.parent_contact, "there")}, thank you for letting us know ${childName} cannot make today's appointment. The team has identified a tentative replacement on ${formatSlotDate(earliest.start, language)} with ${earliest.provider_name} and placed a hold pending review. A staff member will call you within the hour to confirm before anything is finalised.`;
  const safeDraft = sanitizeDraft(draftBody, language);
  await draft_message({
    recipient: inferRecipient(item),
    channel: inferDraftChannel(item),
    body: safeDraft.body,
    language,
  });

  return {
    draft_reply: safeDraft.body,
    recommended_next_action:
      `Front desk to call the family within the hour to confirm the proposed replacement slot ${formatSlotDate(earliest.start, "en")} with ${earliest.provider_name}.`,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      `Same-day reschedule request flagged P1 per policy. ${matchedPatient ? `Existing patient ${matchedPatient.name} (${matchedPatient.patient_id}) matched.` : "No existing patient match; staff to confirm identity."} ` +
      `Hold ${holdResult.data.hold_id} placed on ${earliest.slot_id} (status=pending_review) so a human can confirm before anything is finalised. ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

// ---------------------------------------------------------------------------
// clinical_question handler (Plan §5 item_5)
// ---------------------------------------------------------------------------

async function handleClinicalQuestion(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const intake = assessment.extracted_intake;
  const language = assessment.language;

  await lookup_policy({ topic: "clinical_advice" });

  const draftBody =
    language === "es"
      ? `Hola ${parentFirstName(intake.parent_contact, "familia")}, gracias por su mensaje. No podemos dar orientacion clinica por mensaje, pero un miembro del equipo puede coordinar una evaluacion o un cribado breve para revisar el desarrollo de su hijo/a. Comuniquenos si desea que iniciemos ese proceso.`
      : `Hi ${parentFirstName(intake.parent_contact, "there")}, thank you for your message. We can't share clinical guidance over message, but a team member can help arrange a brief screening or evaluation so a clinician can review your child's development. Let us know if you would like us to start that process.`;
  const safeDraft = sanitizeDraft(draftBody, language);
  await draft_message({
    recipient: inferRecipient(item),
    channel: inferDraftChannel(item),
    body: safeDraft.body,
    language,
  });

  return {
    draft_reply: safeDraft.body,
    recommended_next_action:
      "Staff to follow up with the family and offer a screening or evaluation pathway; no clinical guidance over message.",
    task_ids: [],
    escalation: null,
    decision_rationale:
      `Parent question is developmental/clinical in nature with no booking intent. Per policy, ` +
      `front-desk and automated systems must not provide clinical advice over message and should ` +
      `instead route to screening, evaluation, or clinician review. ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

// ---------------------------------------------------------------------------
// missing_paperwork handler (Plan §5 item_6)
// ---------------------------------------------------------------------------

async function handleMissingPaperwork(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const intake = assessment.extracted_intake;
  const childName = intake.child_name ?? "the child";
  const missingDescriptor =
    assessment.missing_info.length > 0
      ? assessment.missing_info.join(", ")
      : "key intake fields";

  const taskResult = await create_task({
    assignee: "intake",
    title: `Complete missing referral fields for ${childName}`,
    due: oneBusinessDayIso(),
    notes:
      `Fax referral from ${item.sender} is missing ${missingDescriptor}. Excerpt: ` +
      `"${item.body.slice(0, 200).replace(/\s+/g, " ").trim()}". Intake to contact the ` +
      "referring office for the missing information before scheduling.",
  });

  const draftBody = `Hello, thank you for sending the referral for ${childName}. The referral is missing the following information needed before we can begin intake: ${missingDescriptor}. Could you please resend the completed referral or follow up directly so we can move forward? Our intake team will keep this on file pending the missing details.`;
  const safeDraft = sanitizeDraft(draftBody, "en");
  await draft_message({
    recipient: item.sender,
    channel: "phone",
    body: safeDraft.body,
    language: "en",
  });

  return {
    draft_reply: safeDraft.body,
    recommended_next_action:
      "Intake to contact the referring office for the missing information; hold scheduling until the referral is complete.",
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      `Fax referral arrived with multiple blank required fields (${missingDescriptor}). Per policy, ` +
      `intake must confirm discipline and required intake fields before scheduling an evaluation. ` +
      `Recipient on the draft is the referring office (not the family), since parent contact is also ` +
      `missing. ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

// ---------------------------------------------------------------------------
// spam handler (P3 fallback with minimal tool footprint)
// ---------------------------------------------------------------------------

async function handleSpam(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Mark inbox spam: ${item.id}`,
    due: oneBusinessDayIso(),
    notes:
      `Inbound ${item.channel} from ${item.sender} flagged as spam by triage. Excerpt: ` +
      `"${item.body.slice(0, 160).replace(/\s+/g, " ").trim()}". Staff to confirm and dismiss.`,
  });

  return {
    draft_reply: null,
    recommended_next_action:
      "Front desk to confirm spam classification and dismiss; no outbound response.",
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      `Body matches spam cues with no clinical or scheduling intent. ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

// ---------------------------------------------------------------------------
// generic "other" fallback handler
// ---------------------------------------------------------------------------

async function handleOther(
  item: InboxItem,
  assessment: LLMAssessment,
): Promise<HandlerOutcome> {
  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Review inbox item: ${item.id}`,
    due: oneBusinessDayIso(),
    notes:
      `Triage could not place ${item.id} (${item.channel} from ${item.sender}) into a specific workflow. ` +
      `Body excerpt: "${item.body.slice(0, 200).replace(/\s+/g, " ").trim()}". Front desk to review.`,
  });

  return {
    draft_reply: null,
    recommended_next_action:
      "Front desk to review the message and route it to the appropriate workflow manually.",
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      `Classification "${assessment.classification}" did not match a specific handler; routing to ` +
      `front desk for manual triage. ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface GracefulArgs {
  item: InboxItem;
  assessment: LLMAssessment;
  childName: string;
  discipline: Discipline;
  reason: string;
  severity?: "P1";
}

async function gracefulNoSlots(args: GracefulArgs): Promise<HandlerOutcome> {
  const { item, assessment, childName, discipline, reason } = args;
  const language = assessment.language;

  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Manual slot outreach for ${childName} (${discipline})`,
    due: oneBusinessDayIso(),
    notes:
      `${reason} Likely cause: caseload full or no bilingual capacity for ` +
      `${discipline}/${language}. Front desk to call the family directly to coordinate options.`,
  });

  const draftBody =
    language === "es"
      ? "Gracias por comunicarse con nosotros. Nuestro equipo esta revisando la disponibilidad y un miembro del personal se pondra en contacto con usted pronto para coordinar los proximos pasos."
      : "Thank you for reaching out. Our team is reviewing provider availability and a staff member will follow up with you shortly to coordinate next steps.";
  const safeDraft = sanitizeDraft(draftBody, language);
  await draft_message({
    recipient: inferRecipient(item),
    channel: inferDraftChannel(item),
    body: safeDraft.body,
    language,
  });

  return {
    draft_reply: safeDraft.body,
    recommended_next_action:
      `Front desk to call the family directly to coordinate options for ${childName} (${discipline}).`,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale: `${reason} Graceful fallback: no hold placed; front desk outreach task created. ${assessment.rationale}`,
    missing_info: assessment.missing_info,
  };
}

async function verifyInsurance(intake: LLMAssessment["extracted_intake"]) {
  const { verify_insurance } = await import("./tools.js");
  return verify_insurance({
    payer: intake.payer ?? undefined,
    member_id: intake.member_id ?? undefined,
  });
}

function inferRecipient(item: InboxItem): string {
  if (item.channel === "email") {
    const angle = item.sender.match(/<([^>]+)>/);
    if (angle && angle[1].includes("@")) {
      return angle[1];
    }
    if (item.sender.includes("@")) {
      return item.sender.trim();
    }
  }
  return item.sender;
}

function inferDraftChannel(item: InboxItem): "portal" | "email" | "phone" {
  if (item.channel === "email") return "email";
  if (item.channel === "portal_message") return "portal";
  return "phone";
}

function parentFirstName(contact: string | null, fallback: string): string {
  if (!contact) return fallback;
  const firstToken = contact.split(/[\s,]+/)[0];
  if (!firstToken) return fallback;
  if (firstToken.includes("@") || /^\d/.test(firstToken)) return fallback;
  return firstToken;
}

function synthesizePatientRef(item: InboxItem, name: string | null): string {
  if (!name) {
    return `new_referral:item_${item.id}`;
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) {
    return `new_referral:item_${item.id}`;
  }
  return `new_referral:${slug}`;
}

function disciplineLabel(d: Discipline, language: "en" | "es"): string {
  if (language === "es") {
    if (d === "SLP") return "terapia del habla";
    if (d === "OT") return "terapia ocupacional";
    return "terapia fisica";
  }
  if (d === "SLP") return "speech-language pathology";
  if (d === "OT") return "occupational therapy";
  return "physical therapy";
}

function formatSlotDate(iso: string, language: "en" | "es"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const monthEn = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthEs = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  const month = (language === "es" ? monthEs : monthEn)[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hour = d.getUTCHours().toString().padStart(2, "0");
  const minute = d.getUTCMinutes().toString().padStart(2, "0");
  return language === "es"
    ? `${day} de ${month} de ${year} a las ${hour}:${minute} UTC`
    : `${month} ${day}, ${year} at ${hour}:${minute} UTC`;
}

function oneHourFromNowIso(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function oneBusinessDayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  const day = d.getUTCDay();
  if (day === 6) {
    d.setUTCDate(d.getUTCDate() + 2);
  } else if (day === 0) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString();
}

// Re-export for tooling that might want to introspect the table.
export const HANDLER_TABLE = HANDLERS;

// Keep this stub referenced so the linter does not flag the helper export.
void handleNewReferralWithHold;
