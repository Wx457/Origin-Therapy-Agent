/**
 * One-shot connectivity smoke test for the Anthropic API key.
 *
 *   - Verifies that .env is loaded and ANTHROPIC_API_KEY has a sane shape
 *     (non-empty, not the placeholder, correct `sk-ant-` prefix).
 *   - Issues one cheap request via @anthropic-ai/sdk to confirm the key is
 *     accepted by Anthropic and the model name is reachable.
 *
 * Usage:
 *   npx tsx scripts/check-llm-key.ts
 *
 * Output:
 *   - PASS / WARN / FAIL with HTTP status and error details when applicable.
 *   - The key itself is never printed; only the first 12 characters of the
 *     prefix are echoed back for human cross-check.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    console.error("FAIL: ANTHROPIC_API_KEY is missing. Check your .env file.");
    process.exitCode = 1;
    return;
  }
  if (apiKey.includes("REPLACE_WITH_REAL_KEY")) {
    console.error("FAIL: ANTHROPIC_API_KEY still contains the placeholder. Edit .env.");
    process.exitCode = 1;
    return;
  }
  if (!apiKey.startsWith("sk-ant-")) {
    console.error(
      `FAIL: ANTHROPIC_API_KEY does not look like an Anthropic key (prefix='${apiKey.slice(0, 8)}...').`,
    );
    process.exitCode = 1;
    return;
  }

  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

  console.log(`[smoke] Model:        ${model}`);
  console.log(`[smoke] Key prefix:   ${apiKey.slice(0, 12)}... (length=${apiKey.length})`);

  const client = new Anthropic({ apiKey });

  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 32,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: "Reply with exactly this string and nothing else: OK_FROM_CLAUDE",
        },
      ],
    });

    const elapsed = Date.now() - t0;
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    console.log(`[smoke] Latency:      ${elapsed}ms`);
    console.log(`[smoke] Stop reason:  ${response.stop_reason}`);
    console.log(
      `[smoke] Usage tokens: input=${response.usage.input_tokens} output=${response.usage.output_tokens}`,
    );
    console.log(`[smoke] Response:     ${JSON.stringify(text)}`);

    if (text.includes("OK_FROM_CLAUDE")) {
      console.log("PASS: Anthropic API key is working end-to-end.");
      return;
    }
    console.warn(
      "WARN: API call succeeded but did not return the expected sentinel. Key works, model just paraphrased.",
    );
    return;
  } catch (err) {
    console.error("FAIL: Anthropic API call failed.");
    if (err instanceof Anthropic.APIError) {
      console.error(`  status:  ${err.status}`);
      console.error(`  name:    ${err.name}`);
      console.error(`  message: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`  ${err.name}: ${err.message}`);
    } else {
      console.error(`  ${String(err)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
