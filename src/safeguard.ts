/**
 * Rules-first safeguarding pre-flight (Plan §4.1).
 *
 * Two tiers + a negative-context filter:
 *   - Tier 1: high-confidence phrases that fire on substring match.
 *   - Tier 2: weak words that only fire when a caregiver token sits
 *             within ±40 characters of the match.
 *   - Negative filter: idioms like "rough day" / "hit a milestone" that
 *             would otherwise trigger Tier 2 are suppressed.
 *
 * P0 recall floor is enforced by an inline smoke check (run with
 * `npx tsx src/safeguard.ts`). Tier 2 is the only line of defense for
 * item_2 in the visible inbox, so the smoke check is non-optional.
 */

import { fileURLToPath } from "node:url";

export interface SafeguardCheck {
  hit: boolean;
  matched: string[];
  tier: 1 | 2 | null;
}

const TIER_1_PHRASES = [
  "abuse",
  "abusing",
  "neglect",
  "neglected",
  "unsafe",
  "bruise",
  "bruised",
  "threatened",
  "threatening",
  "self-harm",
  "self harm",
  "suicidal",
  "wants to die",
  "hits him",
  "hits her",
  "hit her",
  "hit him",
  "mandated report",
  "cps",
  "won't eat for days",
  "wont eat for days",
];

const TIER_2_WEAK_WORDS = ["rough", "hurt", "scared", "hit"];

const CAREGIVER_TOKENS = [
  "dad",
  "mom",
  "father",
  "mother",
  "stepdad",
  "stepmom",
  "babysitter",
  "uncle",
  "aunt",
  "boyfriend",
  "partner",
  "guardian",
];

const NEGATIVE_PHRASES = [
  "rough day",
  "rough patch",
  "rough night",
  "hit a milestone",
  "hurt feelings",
  "scared of the dark",
  "hurt myself laughing",
];

const NEGATIVE_WINDOW = 20;
const TIER_2_WINDOW = 40;

export function hasSafeguardSignal(body: string): SafeguardCheck {
  const text = body.toLowerCase();

  const tier1Matches: string[] = [];
  for (const phrase of TIER_1_PHRASES) {
    const idx = text.indexOf(phrase);
    if (idx === -1) {
      continue;
    }
    if (isNegativeContext(text, idx, phrase.length)) {
      continue;
    }
    tier1Matches.push(phrase);
  }
  if (tier1Matches.length > 0) {
    return { hit: true, matched: tier1Matches, tier: 1 };
  }

  const tier2Matches: string[] = [];
  for (const weak of TIER_2_WEAK_WORDS) {
    let cursor = 0;
    while (cursor < text.length) {
      const idx = text.indexOf(weak, cursor);
      if (idx === -1) {
        break;
      }
      cursor = idx + weak.length;

      if (!isWordBoundary(text, idx, weak.length)) {
        continue;
      }

      const windowStart = Math.max(0, idx - TIER_2_WINDOW);
      const windowEnd = Math.min(text.length, idx + weak.length + TIER_2_WINDOW);
      const window = text.slice(windowStart, windowEnd);

      const caregiverHit = CAREGIVER_TOKENS.find((cg) => containsWord(window, cg));
      if (!caregiverHit) {
        continue;
      }

      if (isNegativeContext(text, idx, weak.length)) {
        continue;
      }

      tier2Matches.push(`${weak}+${caregiverHit}`);
    }
  }
  if (tier2Matches.length > 0) {
    return { hit: true, matched: tier2Matches, tier: 2 };
  }

  return { hit: false, matched: [], tier: null };
}

function isNegativeContext(text: string, idx: number, length: number): boolean {
  for (const neg of NEGATIVE_PHRASES) {
    let cursor = 0;
    while (cursor < text.length) {
      const negIdx = text.indexOf(neg, cursor);
      if (negIdx === -1) {
        break;
      }
      cursor = negIdx + neg.length;

      const overlaps = negIdx < idx + length && negIdx + neg.length > idx;
      const distance = Math.min(
        Math.abs(negIdx - (idx + length)),
        Math.abs(idx - (negIdx + neg.length)),
      );
      if (overlaps || distance <= NEGATIVE_WINDOW) {
        return true;
      }
    }
  }
  return false;
}

function isWordBoundary(text: string, idx: number, length: number): boolean {
  const before = idx === 0 ? "" : text[idx - 1];
  const after = idx + length >= text.length ? "" : text[idx + length];
  const isLetter = (ch: string): boolean => /[a-z0-9]/.test(ch);
  return !isLetter(before) && !isLetter(after);
}

function containsWord(haystack: string, needle: string): boolean {
  let cursor = 0;
  while (cursor < haystack.length) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) {
      return false;
    }
    cursor = idx + needle.length;
    if (isWordBoundary(haystack, idx, needle.length)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline smoke check — `npx tsx src/safeguard.ts`
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  try {
    const here = fileURLToPath(import.meta.url);
    const main = process.argv[1] ?? "";
    return here === main;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  interface Fixture {
    name: string;
    body: string;
    expectHit: boolean;
    expectTier?: 1 | 2;
  }

  const fixtures: Fixture[] = [
    {
      name: "item_2 voicemail (dad getting rough)",
      body: "Transcript: Hi, this is Maria Gomez calling about my son Leo, he is 6. I wanted to ask about speech therapy openings. He has been more clingy since his dad started getting rough with him during weekends, anyway can we get him in for an eval next Tuesday? Please call me at 555-0102.",
      expectHit: true,
      expectTier: 2,
    },
    {
      name: "item_5 portal (R sounds clinical question)",
      body: "Hi, is it normal that my 4-year-old Ava still can't say her R sounds? Should I be worried, or should we wait until kindergarten?",
      expectHit: false,
    },
    {
      name: "negative idiom (rough day at the park)",
      body: "We had a rough day at the park with my dad and mom — Leo did not want to leave the swings.",
      expectHit: false,
    },
    {
      name: "explicit Tier 1 (the babysitter hit her)",
      body: "The babysitter hit her at pickup and we are very upset.",
      expectHit: true,
      expectTier: 1,
    },
    {
      name: "item_1 fax referral (no safeguarding)",
      body: "Fax referral from Dr. Priya Nair. Child: Emma Lee. DOB: 2018-09-04. Parent: Daniel Lee, 555-0101.",
      expectHit: false,
    },
    {
      name: "item_8 same-day reschedule (no safeguarding)",
      body: "URGENT!!! Noah Patel threw up at school and I can't make today's 3pm OT appointment. Please reschedule!!!",
      expectHit: false,
    },
  ];

  let failed = 0;
  for (const fixture of fixtures) {
    const result = hasSafeguardSignal(fixture.body);
    const hitOk = result.hit === fixture.expectHit;
    const tierOk = !fixture.expectHit || result.tier === fixture.expectTier;
    if (hitOk && tierOk) {
      console.log(`PASS  ${fixture.name}  →  hit=${result.hit} tier=${result.tier ?? "-"}`);
    } else {
      failed += 1;
      console.error(
        `FAIL  ${fixture.name}  →  expected hit=${fixture.expectHit} tier=${
          fixture.expectTier ?? "-"
        }, got hit=${result.hit} tier=${result.tier ?? "-"} matched=[${result.matched.join(", ")}]`,
      );
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} fixture(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll safeguard smoke fixtures passed.");
  }
}
