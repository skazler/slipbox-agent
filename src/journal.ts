/**
 * The reflective journals — the evening gratitude entry and the Sunday weekly
 * reflection.
 *
 * Ported from the Hermes `gratitude-prompt` and `weekly-reflection-prompt`
 * crons. Each ran on a schedule, DM'd a prompt, and wrote Arete's reflection
 * back into the journal when you replied. A Worker can't hold the WebSocket
 * needed to receive that reply, so each loop inverts: the cron still sends the
 * nudge, but you answer with a slash command and the reflection comes back as
 * the response.
 *
 * Both rituals are the same shape — prepend a dated entry, ask Arete to reflect
 * on it against the whole journal — so they share everything but their field
 * labels and their prompt. Arete's voice lives in the vault, not here, so
 * tuning it is an Obsidian edit rather than a redeploy.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readVault, writeFile, type Vault } from "./vault";

const RITUALS = {
  gratitude: {
    file: "Journal/Gratitude.md",
    prompt: "Systems/prompts/gratitude.md",
    fallback: "# Gratitude Journal\n\n---\n",
    commit: "gratitude",
  },
  reflection: {
    file: "Journal/Weekly Reflection.md",
    prompt: "Systems/prompts/weekly-reflection.md",
    fallback: "# Weekly Reflection Journal\n\n---\n",
    commit: "weekly reflection",
  },
} as const;

export type Ritual = keyof typeof RITUALS;

/** `[label, value]` — rendered as `**<label>:** <value>` in the entry. */
export type Fields = [string, string][];

const PROMPT_PATHS: readonly string[] = Object.values(RITUALS).map(
  (r) => r.prompt,
);

/**
 * Reflections lean hard on history — they trace arcs across weeks ("June 28 you
 * learned that softness was a costume"), which is most of what makes them worth
 * reading. So the whole journal ships, plus the inbox and slipbox for what's
 * been on his mind. Knowledge/ is excluded outright: it's a reference library
 * and has nothing to say about either ritual.
 *
 * Both journals ship for both rituals on purpose — the weekly reflection draws
 * on the gratitude entries and vice versa; they're the same life.
 */
function corpus(vault: Vault): string {
  return [...vault]
    .filter(
      ([path]) =>
        (path.startsWith("Journal/") ||
          path.startsWith("Inbox/") ||
          path.startsWith("Slipbox/")) &&
        !PROMPT_PATHS.includes(path),
    )
    .map(([path, content]) => `<file path="${path}">\n${content}\n</file>`)
    .join("\n\n");
}

/** "July 26, 2026" — the heading format both journals already use. */
function longDate(timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

/**
 * Insert a new entry directly below the header rule.
 *
 * Entries in these files are `---`-separated, unlike Review.md, so the
 * separator travels with the entry rather than being assumed between them.
 */
function prepend(journal: string, entry: string): string {
  const i = journal.indexOf("\n---\n");
  if (i === -1) return `${journal.trimEnd()}\n\n---\n\n${entry}\n`;

  const head = journal.slice(0, i + 5);
  const rest = journal.slice(i + 5).replace(/^\n+/, "");
  return `${head}\n${entry}\n\n${rest}`;
}

export interface JournalEnv {
  ANTHROPIC_API_KEY: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
  TIMEZONE: string;
}

export interface Recorded {
  reflection: string;
  /** True when today already had an entry — surfaced so a double-submit is visible. */
  duplicate: boolean;
}

/**
 * Generate the reflection, commit the entry, hand the text back for Discord.
 *
 * Order matters: the file is written before the caller replies, so a Discord
 * failure costs you the notification and never the entry.
 */
export async function record(
  env: JournalEnv,
  ritual: Ritual,
  fields: Fields,
): Promise<Recorded> {
  const spec = RITUALS[ritual];
  const vault = await readVault(env);

  const prompt = vault.get(spec.prompt);
  if (!prompt) throw new Error(`missing ${spec.prompt}`);

  const date = longDate(env.TIMEZONE);
  const journal = vault.get(spec.file) ?? spec.fallback;
  const duplicate = journal.includes(`\n## ${date}\n`);

  const written = fields
    .map(([label, value]) => `**${label}:** ${value.trim()}`)
    .join("\n\n");

  const reflection = (
    await generate(env, prompt, corpus(vault), date, written)
  ).trim();
  if (!reflection) throw new Error("empty reflection");

  const entry =
    `## ${date}\n\n${written}\n\n` +
    `**Arete's reflection:** ${reflection}\n\n` +
    `---`;

  await writeFile(
    env,
    spec.file,
    prepend(journal, entry),
    `${spec.commit}: ${date}`,
  );

  return { reflection, duplicate };
}

async function generate(
  env: JournalEnv,
  prompt: string,
  journalCorpus: string,
  date: string,
  written: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const stream = client.messages.stream({
    // Opus, not Sonnet. The daily review can be Sonnet because routing captures
    // is a tractable task; these entries' whole value is noticing that today
    // inverts a pattern running since July 5. That's the same recurrence
    // problem the weekly review spends Opus on, and it runs once a day at most.
    model: "claude-opus-5",
    max_tokens: 8000,
    system: [
      {
        type: "text",
        text:
          `Today is ${date} (${env.TIMEZONE}).\n\n` +
          `The journals and inbox follow — every past entry, so you can see ` +
          `what recurs and what today breaks.\n\n${journalCorpus}`,
      },
      { type: "text", text: prompt },
    ],
    output_config: { effort: "high" },
    messages: [
      {
        role: "user",
        content:
          `Today's entry, in his words:\n\n${written}\n\n` +
          `Write the reflection now. Output ONLY the reflection prose — no ` +
          `heading, no "**Arete's reflection:**" label, no code fences, no ` +
          `preamble. The runtime adds the label and writes the file.`,
      },
    ],
  });

  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("refused");

  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
