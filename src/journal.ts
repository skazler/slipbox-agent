/**
 * The journals — the evening gratitude entry (Journal/Cogitations.md) and the
 * Sunday weekly reflection (Journal/Weekly Reflection.md).
 *
 * Both are record-only: the cron sends the nudge, you answer with slash
 * commands, and the entry is written verbatim. No model reads or comments on
 * either.
 */

import { readFile, writeFile } from "./vault";

const RITUALS = {
  gratitude: {
    // Gratitude was collapsed into Cogitations: one daily journal, not two.
    file: "Journal/Cogitations.md",
    fallback: "# Cogitations\n\n---\n",
    commit: "cogitations",
  },
  reflection: {
    file: "Journal/Weekly Reflection.md",
    fallback: "# Weekly Reflection Journal\n\n---\n",
    commit: "weekly reflection",
  },
} as const;

export type Ritual = keyof typeof RITUALS;

/** Field label for the weekly value goal. */
export const VALUE_GOAL = "Value goal";

/** `[label, value]` — rendered as `**<label>:** <value>` in the entry. */
export type Fields = [string, string][];

/**
 * The gratitude entry's five questions, one slash command each, in entry order.
 *
 * They used to be five options on a single `/gratitude`, which meant writing
 * all five in one go inside Discord's command box. Answering one at a time is
 * how the nudge actually reads — so each answer lands in a draft, and the entry
 * is only written once the fifth arrives.
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
  // Reset only after the entry is committed, so a failed write keeps the
  // answers and the last command can simply be sent again.
  await writeFile(
    env,
    DRAFT,
    JSON.stringify({ date, answers: {} } satisfies Draft, null, 2) + "\n",
    `gratitude draft: reset`,
  );
  return { done: true, ...recorded };
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
 * Entries in these files are `---`-separated, unlike Zettels Review.md, so the
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
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
  TIMEZONE: string;
}

export interface Recorded {
  /** True when today already had an entry — surfaced so a double-submit is visible. */
  duplicate: boolean;
}

/**
 * Commit the entry verbatim. No vault read, no model call.
 *
 * The file is written before the caller replies, so a Discord failure costs
 * the notification and never the entry.
 */
export async function record(
  env: JournalEnv,
  ritual: Ritual,
  fields: Fields,
): Promise<Recorded> {
  const spec = RITUALS[ritual];
  const date = longDate(env.TIMEZONE);

  const written = fields
    .map(([label, value]) => `**${label}:** ${value.trim()}`)
    .join("\n\n");

  const journal = (await readFile(env, spec.file)) ?? spec.fallback;
  const duplicate = journal.includes(`\n## ${date}\n`);
  await writeFile(
    env,
    spec.file,
    prepend(journal, `## ${date}\n\n${written}\n\n---`),
    `${spec.commit}: ${date}`,
  );
  return { duplicate };
}
