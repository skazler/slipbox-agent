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
import { readFile, readVault, writeFile, type Vault } from "./vault";

/**
 * Arete's voice is defined once and loaded ahead of every ritual's own prompt.
 *
 * It used to live inside `gratitude.md`, with `weekly-reflection.md` saying "the
 * voice is the same, read that one" — which quietly made the gratitude prompt
 * the voice definition and coupled the two rituals to each other. Splitting it
 * means one file to change when the voice changes, and neither ritual depends
 * on the other.
 */
const VOICE = "Systems/prompts/arete.md";

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

/** Field label for the weekly value goal — the news digest finds it by this. */
export const VALUE_GOAL = "Value goal";

/**
 * The value goal from the most recent weekly reflection, or null if there is
 * none from the last 8 days. Entries are newest-first, so the first match is
 * the latest; the 8-day window means a skipped Sunday drops the reminder
 * instead of repeating a stale goal indefinitely.
 */
export function latestValueGoal(journal: string, now = Date.now()): string | null {
  const label = `**${VALUE_GOAL}:**`;
  const at = journal.indexOf(label);
  if (at === -1) return null;

  const heading = journal.slice(0, at).match(/\n## (.+)\n(?![\s\S]*\n## )/);
  const written = heading ? Date.parse(heading[1]) : NaN;
  if (Number.isNaN(written) || now - written > 8 * 864e5) return null;

  const goal = journal.slice(at + label.length).split("\n")[0].trim();
  return goal || null;
}

/** `[label, value]` — rendered as `**<label>:** <value>` in the entry. */
export type Fields = [string, string][];

/**
 * The gratitude entry's five questions, one slash command each, in entry order.
 *
 * They used to be five options on a single `/gratitude`, which meant writing
 * all five in one go inside Discord's command box. Answering one at a time is
 * how the nudge actually reads — so each answer lands in a draft, and the entry
 * is only written (and Arete only reflects) once the fifth arrives.
 */
export const GRATITUDE_QUESTIONS = {
  gratitude: "Grateful for",
  "long-dream": "Long-term dream",
  "near-dream": "Near-term dream",
  relationships: "Cultivating genuine relationships",
  values: "Living my values",
} as const;

export type Question = keyof typeof GRATITUDE_QUESTIONS;

/**
 * Lives under Systems/, not Journal/, so a half-answered day never reaches a
 * reflection's corpus or the weekly review.
 */
const DRAFT = "Systems/gratitude-draft.json";

interface Draft {
  date: string;
  answers: Partial<Record<Question, string>>;
}

export type Answered =
  | { done: false; missing: Question[] }
  | ({ done: true } & Recorded);

/**
 * Save one answer to today's draft; once all five are in, record the entry and
 * reset the draft. A draft from an earlier day is discarded rather than carried
 * over — yesterday's answers don't belong in tonight's entry. Re-answering a
 * question before the fifth arrives overwrites it.
 */
export async function answer(
  env: JournalEnv,
  question: Question,
  value: string,
): Promise<Answered> {
  const date = longDate(env.TIMEZONE);
  const saved = await readFile(env, DRAFT);
  const draft: Draft = saved ? JSON.parse(saved) : { date, answers: {} };
  const answers = draft.date === date ? draft.answers : {};
  answers[question] = value.trim();

  const all = Object.keys(GRATITUDE_QUESTIONS) as Question[];
  const missing = all.filter((q) => !answers[q]);

  if (missing.length) {
    await writeFile(
      env,
      DRAFT,
      JSON.stringify({ date, answers } satisfies Draft, null, 2) + "\n",
      `gratitude draft: ${question}`,
    );
    return { done: false, missing };
  }

  const recorded = await record(
    env,
    "gratitude",
    all.map((q) => [GRATITUDE_QUESTIONS[q], answers[q]!]),
  );
  // Reset only after the entry is committed, so a failed reflection keeps the
  // answers and the last command can simply be sent again.
  await writeFile(
    env,
    DRAFT,
    JSON.stringify({ date, answers: {} } satisfies Draft, null, 2) + "\n",
    `gratitude draft: reset`,
  );
  return { done: true, ...recorded };
}

const PROMPT_PATHS: readonly string[] = [
  VOICE,
  ...Object.values(RITUALS).map((r) => r.prompt),
];

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

  const voice = vault.get(VOICE);
  if (!voice) throw new Error(`missing ${VOICE}`);

  const prompt = vault.get(spec.prompt);
  if (!prompt) throw new Error(`missing ${spec.prompt}`);

  const date = longDate(env.TIMEZONE);
  const journal = vault.get(spec.file) ?? spec.fallback;
  const duplicate = journal.includes(`\n## ${date}\n`);

  const written = fields
    .map(([label, value]) => `**${label}:** ${value.trim()}`)
    .join("\n\n");

  const reflection = (
    await generate(env, voice, prompt, corpus(vault), date, written)
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
  voice: string,
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
      // Voice first, then the ritual's own rules — so a ritual can narrow or
      // add to the voice, and the ordering makes clear which wins.
      { type: "text", text: voice },
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
