/**
 * Weekly zettel roll-up → Journal/Cogitations.md.
 *
 * No model call. Every `/zettel` capture lands in `Inbox/YYYY-MM-DD.md`; this
 * job collects the seven days before today, verbatim, stamps each day's
 * captures with its date, and prepends them as one Cogitations entry so the
 * week can be reviewed in a single page.
 *
 * Runs Saturday 03:00 local — before the 09:00 weekly review archives inbox
 * files older than seven days. Inbox/archive/ is read too, so a late or manual
 * run still finds files that have already been moved.
 */

import { readVault, writeFile, type Env } from "./vault";

const COGITATIONS = "Journal/Cogitations.md";

/** `today` is the local YYYY-MM-DD the job fires on. Returns zettel count. */
export async function rollUpZettels(env: Env, today: string): Promise<number> {
  const days = previousWeek(today);
  const heading = `## Week of ${fmt(days[0], false)} – ${fmt(days[6], true)} — Zettels`;

  const vault = await readVault(env);
  const page = vault.get(COGITATIONS) ?? "# Cogitations\n\n---\n";

  // A double fire (or a manual rerun) must not duplicate the entry.
  if (page.includes(`\n${heading}\n`)) return 0;

  const blocks: string[] = [];
  let count = 0;
  for (const day of days) {
    const text = (
      vault.get(`Inbox/${day}.md`) ?? vault.get(`Inbox/archive/${day}.md`)
    )?.trim();
    if (!text) continue;
    count += text.split(/\n\s*\n/).length;
    blocks.push(`### ${fmt(day, true, true)}\n\n${text}`);
  }
  if (!blocks.length) return 0;

  const entry =
    `${heading}\n\n` +
    `*${count} zettel${count === 1 ? "" : "s"}, copied verbatim from Inbox/.*\n\n` +
    `${blocks.join("\n\n")}\n\n---`;

  await writeFile(env, COGITATIONS, prepend(page, entry), `cogitations: zettels ${days[0]}..${days[6]}`);
  return count;
}

/** The seven local dates before `today`, oldest first (Sat → Fri). */
function previousWeek(today: string): string[] {
  const base = Date.parse(today + "T00:00:00Z");
  return Array.from({ length: 7 }, (_, i) =>
    new Date(base - (7 - i) * 864e5).toISOString().slice(0, 10),
  );
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
