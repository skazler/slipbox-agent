/**
 * Nightly zettel roll-up → Journal/Weekly Review.md, then archive.
 *
 * No model call. Every `/zettel` and `/todo` capture lands in `Inbox/YYYY-MM-DD.md`.
 * Every night at 00:00 this job copies every live inbox file dated before
 * today, verbatim, into its week's Weekly Review entry (weeks run Sat–Fri),
 * split into Zettels and Todos (`/todo` captures share the inbox, marked
 * `[HH:MM] todo`), then moves those same files into Inbox/archive/.
 * Inbox/archive/ is never read — what's there was already rolled up.
 *
 * The entry is built up through the week: the first night creates it, later
 * nights append below what's there. Existing lines are never rewritten, so a
 * todo checked off mid-week stays checked. The Saturday run files Friday's
 * captures, completing the week; only that run announces it.
 *
 * Today's file (anything captured after the 00:00 run starts) is left alone:
 * it isn't rolled up or archived, and the next night's run picks it up.
 */

import { moveFile, readVault, writeFile, type Env } from "./vault";

// Entries are only ever added to, newest week on top. Every week is kept and nothing prunes this file.
const REVIEW = "Journal/Weekly Review.md";
/** Day-and-time label: smaller than <small>, and faded so it reads as metadata. */
const LABEL = "font-size:0.7em;opacity:0.4";

/** Asked of every week's captures, below the todos. */
const QUESTIONS = ["What's noise?", "What's for you?", "What's logistics?"];
const INBOX_FILE = /^Inbox\/(\d{4}-\d{2}-\d{2})\.md$/;
const COUNTS = /^\*(\d+) zettels?, (\d+) todos?, copied verbatim from Inbox\/\.\*$/m;
const NONE = "*None.*";

export interface WeekTotals {
  range: string;
  zettels: number;
  todos: number;
}

/**
 * `today` is the local YYYY-MM-DD the job fires on. Returns what this run
 * filed, plus the totals of the week that ended yesterday (null if that week
 * has no entry) — the Saturday notice reports those.
 */
export async function rollUpZettels(
  env: Env,
  today: string,
): Promise<{ zettels: number; todos: number; archived: number; lastWeek: WeekTotals | null }> {
  const vault = await readVault(env);
  let page = vault.get(REVIEW) ?? "# Weekly Review\n\n---\n";
  const before = page;

  // Live inbox files only, oldest first. ISO dates sort lexically.
  const days = [...vault.keys()]
    .map((p) => p.match(INBOX_FILE)?.[1])
    .filter((d): d is string => !!d && d < today)
    .sort();

  let zettelCount = 0;
  let todoCount = 0;
  for (const day of days) {
    const zettels: string[] = [];
    const todos: string[] = [];
    // Day and time are a quiet label, not structure — the split that
    // matters is zettel vs todo.
    const dayLabel = `<span style="${LABEL}">${fmt(day, false, true)}`;
    for (const item of parse(vault.get(`Inbox/${day}.md`)!)) {
      const when = `${dayLabel}${item.time ? ` · ${item.time}` : ""}</span>`;
      if (item.todo) {
        todos.push(`- [ ] ${item.text.replace(/\s*\n\s*/g, " ")} ${when}`);
      } else {
        // Continuation lines are indented so a multi-line zettel stays one bullet.
        zettels.push(`- ${item.text.replace(/\n(?=.)/g, "\n  ")} ${when}`);
      }
    }
    if (!zettels.length && !todos.length) continue;

    const heading = weekHeading(weekStart(day));
    const at = findEntry(page, heading);
    // A rerun after a failed archive must not file the same day twice.
    if (at && page.slice(at.start, at.end).includes(dayLabel)) continue;
    page = at
      ? page.slice(0, at.start) + addTo(page.slice(at.start, at.end), zettels, todos) + page.slice(at.end)
      : prepend(page, newEntry(heading, zettels, todos));
    zettelCount += zettels.length;
    todoCount += todos.length;
  }

  // Commit before archiving: if this throws, nothing gets moved, so
  // nothing reaches the archive without being rolled up.
  if (page !== before) {
    await writeFile(env, REVIEW, page, `zettels: ${days[0]}..${days[days.length - 1]}`);
  }
  for (const day of days) {
    await moveFile(env, `Inbox/${day}.md`, `Inbox/archive/${day}.md`, "archive inbox");
  }

  const last = weekStart(shift(today, -1));
  const entry = findEntry(page, weekHeading(last));
  const counts = entry && page.slice(entry.start, entry.end).match(COUNTS);
  const lastWeek = counts
    ? { range: weekRange(last), zettels: Number(counts[1]), todos: Number(counts[2]) }
    : null;
  return { zettels: zettelCount, todos: todoCount, archived: days.length, lastWeek };
}

/** The Saturday that starts `day`'s Sat–Fri week. */
function weekStart(day: string): string {
  const dow = new Date(day + "T12:00:00Z").getUTCDay(); // Sat = 6
  return shift(day, -((dow + 1) % 7));
}

function weekRange(start: string): string {
  return `${fmt(start, false)} – ${fmt(shift(start, 6), true)}`;
}

function weekHeading(start: string): string {
  return `## Week of ${weekRange(start)} — zettels & todos`;
}

/** The entry's span: its heading line up to the next `## ` heading or the end. */
function findEntry(page: string, heading: string): { start: number; end: number } | null {
  const i = page.indexOf(`\n${heading}\n`);
  if (i === -1) return null;
  const next = page.indexOf("\n## ", i + 1);
  return { start: i + 1, end: next === -1 ? page.length : next + 1 };
}

function newEntry(heading: string, zettels: string[], todos: string[]): string {
  const sections = [
    `### Zettels\n\n${zettels.join("\n") || NONE}`,
    `### Todos\n\n${todos.join("\n") || NONE}`,
    `### Ask yourself\n\n${QUESTIONS.map((q, n) => `${n + 1}. ${q}`).join("\n")}`,
  ];
  return `${heading}\n\n${countLine(zettels.length, todos.length)}\n\n${sections.join("\n\n")}`;
}

function countLine(zettels: number, todos: number): string {
  return `*${plural(zettels, "zettel")}, ${plural(todos, "todo")}, copied verbatim from Inbox/.*`;
}

/**
 * Append to an existing entry: new zettels at the end of Zettels, new todos at
 * the end of Todos, counts bumped. Nothing already there is rewritten.
 */
function addTo(entry: string, zettels: string[], todos: string[]): string {
  const counts = entry.match(COUNTS);
  if (counts) {
    entry = entry.replace(COUNTS, countLine(Number(counts[1]) + zettels.length, Number(counts[2]) + todos.length));
  }
  entry = appendSection(entry, "### Zettels", "### Todos", zettels);
  return appendSection(entry, "### Todos", "### Ask yourself", todos);
}

function appendSection(entry: string, section: string, nextSection: string, items: string[]): string {
  if (!items.length) return entry;
  const s = entry.indexOf(`${section}\n`);
  const e = entry.indexOf(`\n${nextSection}\n`, s);
  if (s === -1 || e === -1) throw new Error(`Weekly Review entry is missing "${section}" or "${nextSection}"`);
  const body = entry.slice(s + section.length + 1, e).trim();
  const merged = body === NONE || !body ? items.join("\n") : `${body}\n${items.join("\n")}`;
  return `${entry.slice(0, s)}${section}\n\n${merged}\n${entry.slice(e)}`;
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
