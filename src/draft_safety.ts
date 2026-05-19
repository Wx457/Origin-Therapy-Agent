/**
 * Last-mile draft safety filter (Plan §4.1 / §7).
 *
 * Every outbound draft body MUST be sanitised BEFORE it reaches
 * draft_message. If the body trips a reject phrase, swap in a generic
 * neutral acknowledgement so the audit trace records a compliant draft.
 *
 * Reject categories:
 *   - CLINICAL_ADVICE: "diagnose", "you should...", "treatment plan",
 *                      "prescribe", etc. Front-desk drafts must not
 *                      give clinical advice (policy §clinical_advice).
 *   - IMPLIES_SENT_OR_BOOKED: "we sent", "appointment booked",
 *                            "scheduled for", "slot is booked". The
 *                            agent never actually sends or schedules,
 *                            so these would mislead families.
 */

const CLINICAL_ADVICE_TRIGGERS = [
  "diagnose",
  "diagnosis",
  "you should",
  "you need to",
  "treatment plan",
  "prescribe",
  "medication",
  "this means your child has",
  "your child has",
];

const IMPLIES_SENT_OR_BOOKED_TRIGGERS = [
  "we have sent",
  "message has been sent",
  "appointment booked",
  "appointment is booked",
  "scheduled for",
  "slot is booked",
  "slot booked",
  "you are booked",
  "we have scheduled",
];

const FALLBACK_EN =
  "Thank you for reaching out. A member of our team will follow up with you directly to discuss next steps.";

const FALLBACK_ES =
  "Gracias por comunicarse con nosotros. Un miembro del equipo se pondra en contacto con usted para coordinar los proximos pasos.";

export interface SanitizeResult {
  body: string;
  replaced: boolean;
  reason?: string;
}

export function sanitizeDraft(body: string, language: "en" | "es" = "en"): SanitizeResult {
  const lower = body.toLowerCase();

  for (const trigger of CLINICAL_ADVICE_TRIGGERS) {
    if (lower.includes(trigger)) {
      return {
        body: language === "es" ? FALLBACK_ES : FALLBACK_EN,
        replaced: true,
        reason: `clinical_advice trigger: "${trigger}"`,
      };
    }
  }

  for (const trigger of IMPLIES_SENT_OR_BOOKED_TRIGGERS) {
    if (lower.includes(trigger)) {
      return {
        body: language === "es" ? FALLBACK_ES : FALLBACK_EN,
        replaced: true,
        reason: `implies_sent_or_booked trigger: "${trigger}"`,
      };
    }
  }

  return { body, replaced: false };
}
