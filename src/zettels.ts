/**
 * Weekly zettel roll-up → Journal/Zettels Review.md, then archive.
 *
 * No model call. Every `/zettel` and `/todo` capture lands in `Inbox/YYYY-MM-DD.md`; this
 * job copies every live inbox file dated before today, verbatim, into one
 * weekly Zettels Review entry split into Zettels and Todos (`/todo` captures
 * share the inbox, marked `[HH:MM] todo`), then moves those same files into
 * Inbox/archive/. Inbox/archive/ is never read — what's there was already
 * rolled up.
 *
 * Today's file (anything captured after the 00:00 run starts) is left alone:
 * it isn't rolled up or archived, and next week's run picks it up.
 */

import { moveFile, readVault, writeFile, type Env } from "./vault";

// The heading starts with "Week of", so Zettels Review.md's daily-entry pruning keeps it.
const REVIEW = "Journal/Zettels Review.md";
/** Asked of every week's captures, below the todos. */
const QUESTIONS = ["What's noise?", "What's for you?", "What's logistics?"];
const INBOX_FILE = /^Inbox\/(\d{4}-\d{2}-\d{2})\.md$/;

/** `today` is the local YYYY-MM-DD the job fires on. */
export async function rollUpZettels(
  env: Env,
  today: string,
): Promise<{ zettels: number; todos: number; archived: number; range: string; filed: boolean }> {
  const vault = await readVault(env);

  // Live inbox files only, oldest first. ISO dates sort lexically.
  const days = [...vault.keys()]
    .map((p) => p.match(INBOX_FILE)?.[1])
    .filter((d): d is string => !!d && d < today)
    .sort();
  if (!days.length) return { zettels: 0, todos: 0, archived: 0, range: "", filed: false };

  const zettels: string[] = [];
  const todos: string[] = [];
  for (const day of days) {
    for (const item of parse(vault.get(`Inbox/${day}.md`)!)) {
      // Day and time are a quiet label, not structure — the split that
      // matters is zettel vs todo.
      const when = `<small>${fmt(day, false, true)}${item.time ? ` · ${item.time}` : ""}</small>`;
      if (item.todo) {
        todos.push(`- [ ] ${item.text.replace(/\s*\n\s*/g, " ")} ${when}`);
      } else {
        // Continuation lines are indented so a multi-line zettel stays one bullet.
        zettels.push(`- ${item.text.replace(/\n(?=.)/g, "\n  ")} ${when}`);
      }
    }
  }

  // Normally the previous Sat–Fri; widens if an older file is still waiting.
  const first = days[0] < shift(today, -7) ? days[0] : shift(today, -7);
  const last = shift(today, -1);
  const range = `${fmt(first, false)} – ${fmt(last, true)}`;
  const heading = `## Week of ${range} — zettels & todos`;

  let filed = false;
  if (zettels.length || todos.length) {
    const page = vault.get(REVIEW) ?? "# Zettels Review\n\n---\n";
    // A double fire or manual rerun must not duplicate the entry.
    if (!page.includes(`\n${heading}\n`)) {
      const sections = [
        `### Zettels\n\n${zettels.join("\n") || "*None.*"}`,
        `### Todos\n\n${todos.join("\n") || "*None.*"}`,
        `### Questions to ask myself\n\n${QUESTIONS.map((q, n) => `${n + 1}. ${q}`).join("\n")}`,
      ];
      const entry =
        `${heading}\n\n` +
        `*${plural(zettels.length, "zettel")}, ${plural(todos.length, "todo")}, copied verbatim from Inbox/.*\n\n` +
        sections.join("\n\n");
      // Commit before archiving: if this throws, nothing gets moved, so
      // nothing reaches the archive without being rolled up.
      await writeFile(env, REVIEW, prepend(page, entry), `zettels: ${first}..${last}`);
      filed = true;
    }
  }

  for (const day of days) {
    await moveFile(env, `Inbox/${day}.md`, `Inbox/archive/${day}.md`, "archive inbox");
  }
  return { zettels: zettels.length, todos: todos.length, archived: days.length, range, filed };
}

const STAMP = /^\[(\d{2}:\d{2})\]( todo)?[ \t]*$/;

/**
 * Split an inbox file into captures. `/zettel` writes `[HH:MM]` on its own
 * line and `/todo` writes `[HH:MM] todo`; each capture runs to the next stamp,
 * so a multi-paragraph zettel stays one. Text before the first stamp (files
 * from before stamping) is one unstamped zettel per paragraph.
 */
function parse(file: string): { time: string; todo: boolean; text: string }[] {
  const out: { time: string; todo: boolean; text: string }[] = [];
  let cur: { time: string; todo: boolean; lines: string[] } | null = null;
  const loose: string[] = [];
  const flush = () => {
    const text = cur?.lines.join("\n").trim();
    if (cur && text) out.push({ time: cur.time, todo: cur.todo, text });
  };
  for (const line of file.split("\n")) {
    const m = line.match(STAMP);
    if (m) {
      flush();
      cur = { time: m[1], todo: !!m[2], lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      loose.push(line);
    }
  }
  flush();
  const unstamped = loose.join("\n").trim();
  const pre = unstamped
    ? unstamped.split(/\n\s*\n/).map((text) => ({ time: "", todo: false, text: text.trim() }))
    : [];
  return [...pre, ...out];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function shift(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
}

/** "Oct 31" / "Nov 6, 2026" / "Sat, Oct 31". Dates are UTC-anchored. */
function fmt(day: string, year: boolean, weekday = false): string {
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
    ...(weekday ? { weekday: "short" } : {}),
  });
}

/** Insert directly below the page header's first `---` rule. */
function prepend(page: string, entry: string): string {
  const i = page.indexOf("\n---\n");
  if (i === -1) return `${page.trimEnd()}\n\n---\n\n${entry}\n`;
  const head = page.slice(0, i + 5);
  const rest = page.slice(i + 5).replace(/^\n+/, "");
  return `${head}\n${entry}\n\n${rest}`;
}
