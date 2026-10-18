/**
 * The morning news digest.
 *
 * Ported from the Hermes `morning-news-digest` cron. That job ran in Hermes'
 * agent mode with a web toolset — it searched the live web mid-run, which is
 * why its output reads better than a fixed RSS pull. The port keeps that:
 * `web_search` is a server-side tool on the Messages API, so the model runs
 * the searches itself and no feed plumbing is needed here.
 *
 * Reads and writes nothing in the vault except its own prompt. There is no
 * dedup state by design — each run asks for the last 24 hours fresh, which is
 * what Hermes did and what keeps this Worker stateless.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dc from "./discord";
import { readFile } from "./vault";
import { latestValueGoal } from "./journal";

const PROMPT = "Systems/prompts/news-digest.md";

// The server-side tool loop caps at 10 iterations and returns `pause_turn`
// rather than finishing. Resuming is just re-sending with the partial
// assistant turn appended; this bounds how many times we'll do that.
const MAX_RESUMES = 3;

export interface NewsEnv {
  ANTHROPIC_API_KEY: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
  TIMEZONE: string;
  DISCORD_WEBHOOK_UPDATES: string;
}

export async function generate(env: NewsEnv, date: string): Promise<string> {
  const prompt = await readFile(env, PROMPT);
  if (!prompt) throw new Error(`missing ${PROMPT}`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "Search for today's stories and write the digest now.\n\n" +
        "Output ONLY the digest body — no preamble, no code fences, no " +
        "closing commentary. The runtime posts your output to Discord verbatim.",
    },
  ];

  for (let resume = 0; ; resume++) {
    const stream = client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: [
        {
          type: "text",
          text: `Today is ${date} (${env.TIMEZONE}).`,
        },
        { type: "text", text: prompt },
      ],
      // Searching is the job; the writing is a 250-word summary. Medium is
      // the right rung — the expensive part is the tool loop, not reasoning.
      output_config: { effort: "medium" },
      // Dynamic filtering is built into this tool version: it filters results
      // before they reach the context window. Do NOT also declare
      // code_execution — that creates a second execution environment and
      // confuses the model.
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 12 }],
      messages,
    });

    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("refused");

    // The server ran out of tool-loop iterations mid-task. Append what it has
    // and re-send; the server picks up where it left off. No extra user turn —
    // the trailing server_tool_use block is what signals a resume.
    if (msg.stop_reason === "pause_turn") {
      if (resume >= MAX_RESUMES) {
        throw new Error(`still paused after ${MAX_RESUMES} resumes`);
      }
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!text) throw new Error("empty digest");
    return text;
  }
}

export async function post(env: NewsEnv, date: string): Promise<void> {
  try {
    let digest = await generate(env, date);

    // The week's value goal sits above the digest. Prepended here rather than
    // asked of the model, so it's verbatim and can't be dropped or reworded.
    const reflections = await readFile(env, "Journal/Weekly Reflection.md");
    const goal = reflections && latestValueGoal(reflections);
    if (goal) digest = `🎯 **This week:** ${goal}\n\n${digest}`;

    // Chunked because the word cap is a prompt instruction, not a guarantee —
    // a 2000-char overrun would otherwise be silently truncated by Discord.
    for (const part of split(digest)) {
      await dc.send(env.DISCORD_WEBHOOK_UPDATES, part);
    }
  } catch (e) {
    console.error(e);
    await dc.send(
      env.DISCORD_WEBHOOK_UPDATES,
      `⚠️ news digest failed: ${(e as Error).message}`,
    );
  }
}

/**
 * Split an over-long digest at the section break nearest its middle.
 *
 * `dc.chunk` fills the first message as full as it can, so on a typical
 * morning the overflow was one section — Semiconductors, the last one — sitting
 * alone at the top of message two. Balancing the halves keeps several sections
 * in the second message, so Semiconductors lands at its bottom. Falls back to
 * `dc.chunk` if no single break gives two halves that both fit.
 */
function split(digest: string): string[] {
  const max = 1900;
  if (digest.length <= max) return [digest];

  let best = -1;
  for (let i = digest.indexOf("\n\n"); i !== -1; i = digest.indexOf("\n\n", i + 1)) {
    const fits = i <= max && digest.length - i - 2 <= max;
    if (fits && (best === -1 || Math.abs(i - digest.length / 2) < Math.abs(best - digest.length / 2))) {
      best = i;
    }
  }
  if (best === -1) return dc.chunk(digest);
  return [digest.slice(0, best).trim(), digest.slice(best).trim()];
}
