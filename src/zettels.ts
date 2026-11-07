/**
 * Weekly zettel roll-up → Journal/Zettels Review.md, then archive.
 *
 * No model call. Every `/zettel` capture lands in `Inbox/YYYY-MM-DD.md`; this
 * job copies every live inbox file dated before today, verbatim, into one
 * weekly Zettels Review entry with a heading per day, then moves those same files into
 * Inbox/archive/. Inbox/archive/ is never read — what's there was already
 * rolled up.
 *
 * Today's file (anything captured after the 00:00 run starts) is left alone:
 * it isn't rolled up or archived, and next week's run picks it up.
 */

import { moveFile, readVault, writeFile, type Env } from "./vault";

// The heading starts with "Week of", so Zettels Review.md's daily-entry pruning keeps it.
const REVIEW = "Journal/Zettels Review.md";
const INBOX_FILE = /^Inbox\/(\d{4}-\d{2}-\d{2})\.md$/;

/** `today` is the local YYYY-MM-DD the job fires on. */
export async function rollUpZettels(
  env: Env,
  today: string,
): Promise<{ count: number; archived: number; range: string; filed: boolean }> {
  const vault = await readVault(env);

  // Live inbox files only, oldest first. ISO dates sort lexically.
  const days = [...vault.keys()]
    .map((p) => p.match(INBOX_FILE)?.[1])
    .filter((d): d is string => !!d && d < today)
    .sort();
  if (!days.length) return { count: 0, archived: 0, range: "", filed: false };

  const blocks: string[] = [];
  let count = 0;
  for (const day of days) {
    const text = vault.get(`Inbox/${day}.md`)!.trim();
    if (!text) continue;
    // Stamped captures count by stamp, so a multi-paragraph zettel is one;
    // pre-stamp files fall back to blank-line-separated paragraphs.
    const stamps = text.match(/^\[\d{2}:\d{2}\]/gm)?.length ?? 0;
    count += stamps || text.split(/\n\s*\n/).length;
    blocks.push(`### ${fmt(day, true, true)}\n\n${text}`);
  }

  // Normally the previous Sat–Fri; widens if an older file is still waiting.
  const first = days[0] < shift(today, -7) ? days[0] : shift(today, -7);
  const last = shift(today, -1);
  const range = `${fmt(first, false)} – ${fmt(last, true)}`;
  const heading = `## Week of ${range} — zettels`;

  let filed = false;
  if (blocks.length) {
    const page = vault.get(REVIEW) ?? "# Zettels Review\n\n---\n";
    // A double fire or manual rerun must not duplicate the entry.
    if (!page.includes(`\n${heading}\n`)) {
      const entry =
        `${heading}\n\n` +
        `*${count} zettel${count === 1 ? "" : "s"}, copied verbatim from Inbox/.*\n\n` +
        blocks.join("\n\n");
      // Commit before archiving: if this throws, nothing gets moved, so
      // nothing reaches the archive without being rolled up.
      await writeFile(env, REVIEW, prepend(page, entry), `zettels: ${first}..${last}`);
      filed = true;
    }
  }

  for (const day of days) {
    await moveFile(env, `Inbox/${day}.md`, `Inbox/archive/${day}.md`, "archive inbox");
  }
  return { count, archived: days.length, range, filed };
}

function shift(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
}

/** "Oct 31" / "Nov 6, 2026" / "Saturday, Oct 31, 2026". Dates are UTC-anchored. */
function fmt(day: string, year: boolean, weekday = false): string {
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
    ...(weekday ? { weekday: "long" } : {}),
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
