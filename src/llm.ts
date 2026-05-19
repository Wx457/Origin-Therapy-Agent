/**
 * Anthropic Claude triage assessment (Plan §6).
 *
 * Single-shot per item. LLM returns a strict JSON object with the
 * classification, urgency, language, extracted intake fields, and
 * supporting signals. It does NOT decide which tools to call — that is
 * the dispatcher's job in agent.ts / handlers.ts.
 *
 * JSON discipline:
 *   - temperature: 0 for determinism
 *   - assistant prefill `{` (Anthropic Messages API has NO response_format
 *     equivalent; prefill is the only reliable mechanism)
 *   - if anything is off (network, parse, shape, enum) → throw
 *     LLMAssessmentError so agent.ts can fall back to synthesizeFromRules.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  Urgency,
} from "./types.js";

export interface LLMAssessment {
  classification: Classification;
  urgency: Urgency;
  language: "en" | "es";
  extracted_intake: ExtractedIntake;
  safeguarding_signal: boolean;
  same_day_cancel: boolean;
  missing_info: string[];
  rationale: string;
}

export class LLMAssessmentError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LLMAssessmentError";
  }
}

const VALID_CLASSIFICATIONS: ReadonlySet<Classification> = new Set<Classification>([
  "new_referral",
  "existing_patient_request",
  "scheduling",
  "clinical_question",
  "billing_question",
  "missing_paperwork",
  "provider_followup",
  "complaint",
  "safeguarding",
  "spam",
  "other",
]);

const VALID_URGENCIES: ReadonlySet<Urgency> = new Set<Urgency>([
  "P0",
  "P1",
  "P2",
  "P3",
]);

const VALID_DISCIPLINES: ReadonlySet<Discipline> = new Set<Discipline>(["SLP", "OT", "PT"]);

const SYSTEM_PROMPT = `You are a triage assistant for Cedar Kids Therapy, a pediatric practice
covering SLP (speech-language pathology), OT (occupational therapy), and
PT (physical therapy) for ages 0-18.

You read a single inbox message and produce a structured JSON assessment.
You do NOT decide which tools to call. You do NOT send messages. You do
NOT schedule appointments. A downstream deterministic dispatcher handles
all actions based on your assessment.

URGENCY DEFINITIONS
- P0: safeguarding (abuse / neglect / unsafe caregiving / self-harm /
      imminent harm). Same-hour clinical-lead escalation required.
- P1: same-day operational issue (e.g. same-day cancel / reschedule of
      today's appointment).
- P2: normal intake, scheduling, billing, or clinical-review workflow.
- P3: low-priority admin, FYI, spam, or generic clinical questions
      without booking intent.
Default to P2 unless there is a clear safety or same-day operational
reason. OVER-ESCALATION IS ITSELF A PRODUCTION FAILURE - do not assign
P0 unless the safeguarding signal is unambiguous.

CLASSIFICATIONS (pick exactly one):
new_referral, existing_patient_request, scheduling, clinical_question,
billing_question, missing_paperwork, provider_followup, complaint,
safeguarding, spam, other.

INSURANCE
- In-network: Aetna, Blue Cross Blue Shield, UnitedHealthcare, Medicaid.
- Out-of-network: Kaiser, Cigna Select, Beacon (require benefits
  conversation before any slot hold).
- Expired-on-file: Sunrise, Pediatric Choice, Community First.

LANGUAGE
- If the message contains >= 2 Spanish markers (after stripping accents),
  set language="es". Otherwise "en". Common markers include but are not
  limited to: hola, soy, hijo, hija, gracias, espanol, llamo, evaluacion,
  mensaje, voz, telefono, por favor, necesita, prefiero, mi, anos.

SAME-DAY CANCEL
- Set same_day_cancel=true ONLY when the message asks to cancel or
  reschedule an appointment that is today. Markers: today, today's,
  this morning, this afternoon, tonight, right now, can't make today,
  threw up at school (implies same-day illness). Otherwise false.
- A general reschedule with no day reference is NOT same_day_cancel.

SAFEGUARDING
- Look for both explicit and indirect disclosures of harm, abuse,
  neglect, or unsafe caregiving by a caregiver. Set safeguarding_signal
  to true if present. When in doubt and the signal is plausible, set it
  to true - the cost of a false negative is much higher than a false
  positive, but do not invent risk where there is none.

FIELD EXTRACTION
- Pull child_name, dob_or_age, parent_contact, discipline (array of
  SLP/OT/PT or null), diagnosis_or_concern, payer (canonical name only),
  member_id from the body. Use null for any field not explicitly
  present. DO NOT INFER fields that are not stated. Payer canonical
  names: "Aetna", "Blue Cross Blue Shield", "UnitedHealthcare",
  "Medicaid", "Kaiser", "Cigna Select", "Beacon", "Sunrise",
  "Pediatric Choice", "Community First". Keep any plan suffix the body
  provides, e.g. "Blue Cross Blue Shield PPO".

OUTPUT
Return exactly one JSON object matching this schema. No prose, no code
fences, no commentary.

{
  "classification": "<one of the 11 enums>",
  "urgency": "P0" | "P1" | "P2" | "P3",
  "language": "en" | "es",
  "extracted_intake": {
    "child_name": string | null,
    "dob_or_age": string | null,
    "parent_contact": string | null,
    "discipline": ["SLP"|"OT"|"PT", ...] | null,
    "diagnosis_or_concern": string | null,
    "payer": string | null,
    "member_id": string | null
  },
  "safeguarding_signal": boolean,
  "same_day_cancel": boolean,
  "missing_info": [string, ...],
  "rationale": "<one sentence in English explaining the assessment>"
}`;

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (cachedClient) {
    return cachedClient;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new LLMAssessmentError("ANTHROPIC_API_KEY is not set; cannot call Claude.");
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

function getModel(): string {
  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
}

export async function assessItem(item: InboxItem): Promise<LLMAssessment> {
  const userPrompt = renderUserPrompt(item);

  let rawText: string;
  try {
    const response = await getClient().messages.create({
      model: getModel(),
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: userPrompt },
        { role: "assistant", content: "{" },
      ],
    });

    rawText = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  } catch (err) {
    throw new LLMAssessmentError("Anthropic API call failed", err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(`{${rawText}`);
  } catch (err) {
    throw new LLMAssessmentError(
      `LLM returned non-JSON text: ${truncate(rawText, 160)}`,
      err,
    );
  }

  return validateAssessment(parsed);
}

function renderUserPrompt(item: InboxItem): string {
  return [
    "Inbox item to assess:",
    "",
    `channel: ${item.channel}`,
    `sender:  ${item.sender}`,
    `subject: ${item.subject}`,
    "body: |",
    item.body
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join("\n"),
    "",
    "Return only the JSON object.",
  ].join("\n");
}

function validateAssessment(raw: unknown): LLMAssessment {
  if (!raw || typeof raw !== "object") {
    throw new LLMAssessmentError("LLM JSON is not an object");
  }
  const obj = raw as Record<string, unknown>;

  const classification = obj.classification;
  if (typeof classification !== "string" || !VALID_CLASSIFICATIONS.has(classification as Classification)) {
    throw new LLMAssessmentError(`Invalid classification: ${String(classification)}`);
  }

  const urgency = obj.urgency;
  if (typeof urgency !== "string" || !VALID_URGENCIES.has(urgency as Urgency)) {
    throw new LLMAssessmentError(`Invalid urgency: ${String(urgency)}`);
  }

  const language = obj.language;
  if (language !== "en" && language !== "es") {
    throw new LLMAssessmentError(`Invalid language: ${String(language)}`);
  }

  const intake = obj.extracted_intake;
  if (!intake || typeof intake !== "object") {
    throw new LLMAssessmentError("Missing extracted_intake");
  }
  const intakeObj = intake as Record<string, unknown>;
  const extracted_intake: ExtractedIntake = {
    child_name: coerceNullableString(intakeObj.child_name, "child_name"),
    dob_or_age: coerceNullableString(intakeObj.dob_or_age, "dob_or_age"),
    parent_contact: coerceNullableString(intakeObj.parent_contact, "parent_contact"),
    discipline: coerceDiscipline(intakeObj.discipline),
    diagnosis_or_concern: coerceNullableString(intakeObj.diagnosis_or_concern, "diagnosis_or_concern"),
    payer: coerceNullableString(intakeObj.payer, "payer"),
    member_id: coerceNullableString(intakeObj.member_id, "member_id"),
  };

  const safeguarding_signal = obj.safeguarding_signal;
  if (typeof safeguarding_signal !== "boolean") {
    throw new LLMAssessmentError(`Invalid safeguarding_signal: ${String(safeguarding_signal)}`);
  }

  const same_day_cancel = obj.same_day_cancel;
  if (typeof same_day_cancel !== "boolean") {
    throw new LLMAssessmentError(`Invalid same_day_cancel: ${String(same_day_cancel)}`);
  }

  const missing_info_raw = obj.missing_info;
  if (!Array.isArray(missing_info_raw) || !missing_info_raw.every((m) => typeof m === "string")) {
    throw new LLMAssessmentError("Invalid missing_info (must be string[])");
  }

  const rationale = obj.rationale;
  if (typeof rationale !== "string" || rationale.trim() === "") {
    throw new LLMAssessmentError("Missing or empty rationale");
  }

  return {
    classification: classification as Classification,
    urgency: urgency as Urgency,
    language,
    extracted_intake,
    safeguarding_signal,
    same_day_cancel,
    missing_info: missing_info_raw as string[],
    rationale,
  };
}

function coerceNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  throw new LLMAssessmentError(`Field ${field} must be string|null, got ${typeof value}`);
}

function coerceDiscipline(value: unknown): Discipline[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new LLMAssessmentError("discipline must be array|null");
  }
  if (value.length === 0) return null;
  const result: Discipline[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !VALID_DISCIPLINES.has(entry as Discipline)) {
      throw new LLMAssessmentError(`Invalid discipline entry: ${String(entry)}`);
    }
    if (!result.includes(entry as Discipline)) {
      result.push(entry as Discipline);
    }
  }
  return result;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}
