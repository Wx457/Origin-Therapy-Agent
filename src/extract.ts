/**
 * Regex-based intake extractor (Plan §4.1).
 *
 * Only used when the LLM assessment path fails (network / parse / schema).
 * The LLM is the primary judgment surface; this file exists so a single
 * LLM outage cannot collapse the whole batch. Stays deliberately
 * conservative — prefers null over a hallucinated field.
 *
 * Field grammar guard rails (lessons from Plan §13):
 *   - child_name regex must NOT contain '.' in the character class,
 *     otherwise it eats "Emma Lee. DOB" → "Emma Lee. DOB".
 *   - parent_contact stitches label/phone/email, again excluding '.'.
 *   - payer is canonicalised (Aetna / Blue Cross Blue Shield / Kaiser /
 *     UnitedHealthcare / Medicaid / Cigna Select / Beacon / Sunrise /
 *     Pediatric Choice / Community First) so `verify_insurance` can do a
 *     lowercase substring match downstream.
 *   - preferred_language requires >= 2 Spanish markers after accent strip
 *     to avoid 1-word false positives like a stray "gracias".
 */

import type { Discipline, ExtractedIntake, InboxItem } from "./types.js";

export interface ExtractedFields extends ExtractedIntake {
  preferred_language: "en" | "es";
  blank_field_count: number;
  missing_info: string[];
}

export function extractFields(item: InboxItem): ExtractedFields {
  const body = item.body;
  const child_name = extractChildName(body);
  const dob_or_age = extractDobOrAge(body);
  const parent_contact = extractParentContact(body);
  const discipline = extractDiscipline(body);
  const diagnosis_or_concern = extractDiagnosis(body);
  const payer = extractPayer(body);
  const member_id = extractMemberId(body);
  const preferred_language = detectLanguage(body);

  const blank_field_count = countBlankFields(body);
  const missing_info = collectMissing({
    child_name,
    dob_or_age,
    parent_contact,
    discipline,
    payer,
    member_id,
  });

  return {
    child_name,
    dob_or_age,
    parent_contact,
    discipline,
    diagnosis_or_concern,
    payer,
    member_id,
    preferred_language,
    blank_field_count,
    missing_info,
  };
}

const NAME_TOKEN = "[A-Z][a-zA-Z'\\-]+";
const NAME_RUN = `${NAME_TOKEN}(?:\\s+${NAME_TOKEN})*`;
const NAME_CHILD_LABEL = new RegExp(`Child:\\s*(${NAME_RUN})`);
const NAME_FOR = new RegExp(`(?:referral|evaluation)\\s+for\\s+(${NAME_RUN})`, "i");
const NAME_MY_SON_DAUGHTER = new RegExp(
  `(?:my\\s+(?:son|daughter|child)|mi\\s+(?:hijo|hija))\\s+(${NAME_RUN})`,
  "i",
);
const NAME_ABOUT = new RegExp(`(?:about|por)\\s+(?:my|mi)\\s+(?:son|daughter|child|hijo|hija)\\s+(${NAME_RUN})`, "i");

function extractChildName(body: string): string | null {
  for (const pattern of [NAME_CHILD_LABEL, NAME_ABOUT, NAME_MY_SON_DAUGHTER, NAME_FOR]) {
    const m = body.match(pattern);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return null;
}

const DOB_ISO = /\bDOB\b[^\n]*?(\d{4}-\d{2}-\d{2})/i;
const DOB_LOOSE = /\b(\d{4}-\d{2}-\d{2})\b/;
const AGE_YEARS = /\b(?:is|tiene)\s+(\d{1,2})\s+(?:years\s+old|year\s+old|anos|años)/i;
const AGE_HE_SHE = /\b(?:he|she)\s+is\s+(\d{1,2})\b/i;

function extractDobOrAge(body: string): string | null {
  for (const pattern of [DOB_ISO, DOB_LOOSE]) {
    const m = body.match(pattern);
    if (m && m[1]) {
      return m[1];
    }
  }
  for (const pattern of [AGE_YEARS, AGE_HE_SHE]) {
    const m = body.match(pattern);
    if (m && m[1]) {
      return `${m[1]} years old`;
    }
  }
  return null;
}

const PARENT_LABEL = new RegExp(`(?:Parent|Parent\\/guardian)[:]\\s*(${NAME_RUN})`);
const PHONE = /\b(\d{3}[-.\s]\d{4}|\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4})\b/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

function extractParentContact(body: string): string | null {
  const labelMatch = body.match(PARENT_LABEL);
  const phoneMatch = body.match(PHONE);
  const emailMatch = body.match(EMAIL);

  const parts: string[] = [];
  if (labelMatch && labelMatch[1]) {
    parts.push(labelMatch[1].trim());
  }
  if (phoneMatch) {
    parts.push(phoneMatch[0]);
  }
  if (emailMatch) {
    parts.push(emailMatch[0]);
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(", ");
}

interface DisciplineCue {
  discipline: Discipline;
  cues: string[];
}

const DISCIPLINE_CUES: DisciplineCue[] = [
  {
    discipline: "SLP",
    cues: [
      "slp",
      "speech-language",
      "speech language",
      "speech therapy",
      "speech",
      "articulation",
      "habla",
      "fonoaudiologia",
    ],
  },
  {
    discipline: "OT",
    cues: [
      "occupational therapy",
      " ot ",
      "ot evaluation",
      "ot eval",
      "sensory",
      "feeding",
      "terapia ocupacional",
    ],
  },
  {
    discipline: "PT",
    cues: [
      "physical therapy",
      " pt ",
      "pt evaluation",
      "pt eval",
      "toe walking",
      "gait",
      "fisioterapia",
      "terapia fisica",
    ],
  },
];

function extractDiscipline(body: string): Discipline[] | null {
  const text = ` ${body.toLowerCase()} `;
  const hits: Discipline[] = [];
  for (const entry of DISCIPLINE_CUES) {
    if (entry.cues.some((cue) => text.includes(cue))) {
      hits.push(entry.discipline);
    }
  }
  if (hits.length === 0) {
    return null;
  }
  return Array.from(new Set(hits));
}

const DIAGNOSIS_LABELS = [
  /(?:Diagnosis(?:\/concern)?|Concern)[:]\s*([^\n.]+)/i,
];

function extractDiagnosis(body: string): string | null {
  for (const pattern of DIAGNOSIS_LABELS) {
    const m = body.match(pattern);
    if (m && m[1]) {
      const cleaned = m[1].trim();
      if (cleaned && !/^\[?blank\]?$/i.test(cleaned)) {
        return cleaned;
      }
    }
  }
  return null;
}

interface PayerCanon {
  canonical: string;
  cues: string[];
}

const PAYER_CANONS: PayerCanon[] = [
  { canonical: "Blue Cross Blue Shield", cues: ["blue cross blue shield", "bcbs", "blue cross", "bluecross"] },
  { canonical: "UnitedHealthcare", cues: ["unitedhealthcare", "united healthcare", "uhc"] },
  { canonical: "Aetna", cues: ["aetna"] },
  { canonical: "Medicaid", cues: ["medicaid"] },
  { canonical: "Kaiser", cues: ["kaiser"] },
  { canonical: "Cigna Select", cues: ["cigna select", "cigna"] },
  { canonical: "Beacon", cues: ["beacon"] },
  { canonical: "Sunrise", cues: ["sunrise"] },
  { canonical: "Pediatric Choice", cues: ["pediatric choice"] },
  { canonical: "Community First", cues: ["community first"] },
];

function extractPayer(body: string): string | null {
  const text = body.toLowerCase();
  if (/insurance:\s*\[?blank\]?/i.test(body)) {
    return null;
  }
  for (const entry of PAYER_CANONS) {
    if (entry.cues.some((cue) => text.includes(cue))) {
      const labelMatch = body.match(/Insurance[:]\s*([^\n.]+)/i);
      if (labelMatch && labelMatch[1] && !/^\[?blank\]?$/i.test(labelMatch[1].trim())) {
        return labelMatch[1].trim();
      }
      return entry.canonical;
    }
  }
  return null;
}

const MEMBER_ID = /\b([A-Z]{2,5}-\d{3,8})\b/;

function extractMemberId(body: string): string | null {
  if (/member\s*id:\s*\[?blank\]?/i.test(body)) {
    return null;
  }
  const m = body.match(MEMBER_ID);
  return m && m[1] ? m[1] : null;
}

const SPANISH_MARKERS = [
  "hola",
  "soy",
  "hijo",
  "hija",
  "gracias",
  "espanol",
  "llamo",
  "evaluacion",
  "mensaje",
  "voz",
  "telefono",
  "por favor",
  "necesita",
  "prefiero",
  "habla",
  "anos",
];

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function detectLanguage(body: string): "en" | "es" {
  const normalised = ` ${stripAccents(body).toLowerCase()} `;
  const hits = SPANISH_MARKERS.filter((marker) => normalised.includes(` ${marker} `) || normalised.includes(marker)).length;
  return hits >= 2 ? "es" : "en";
}

function countBlankFields(body: string): number {
  return (body.match(/\[blank\]/gi) || []).length;
}

function collectMissing(fields: {
  child_name: string | null;
  dob_or_age: string | null;
  parent_contact: string | null;
  discipline: Discipline[] | null;
  payer: string | null;
  member_id: string | null;
}): string[] {
  const missing: string[] = [];
  if (!fields.child_name) missing.push("child_name");
  if (!fields.dob_or_age) missing.push("dob_or_age");
  if (!fields.parent_contact) missing.push("parent_contact");
  if (!fields.discipline) missing.push("discipline");
  if (!fields.payer) missing.push("payer");
  if (!fields.member_id) missing.push("member_id");
  return missing;
}
