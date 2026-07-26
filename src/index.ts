import Anthropic from "@anthropic-ai/sdk";
import * as dc from "./discord";
import { record as recordJournal, type Fields, type Ritual } from "./journal";
import { post as postNewsDigest } from "./news";
import { readVault, writeFile, appendToInbox, moveFile, type Vault } from "./vault";

export interface Env {
  ANTHROPIC_API_KEY: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_USER_ID: string;
  TIMEZONE: string;
  DAILY_HOUR: string;
  DAILY_MINUTE: string;
  WEEKLY_HOUR: string;
  WEEKLY_MINUTE: string;
  WEEKLY_WEEKDAY: string;
  GRATITUDE_HOUR: string;
  GRATITUDE_MINUTE: string;
  REFLECT_HOUR: string;
  REFLECT_MINUTE: string;
  REFLECT_WEEKDAY: string;
  NEWS_HOUR: string;
  NEWS_MINUTE: string;
}

const REVIEW = "Journal/Review.md";

// ---------------------------------------------------------------- capture

export default {
  /** Discord Interactions endpoint. `/note <text>` appends to today's inbox. */
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") return new Response("ok");

    const body = await req.text();
    if (!(await dc.verify(req, body, env))) {
      // Discord sends deliberately-invalid signatures to check we reject
      // them; an endpoint that accepts them gets disabled.
      return new Response("bad signature", { status: 401 });
    }

    const i = JSON.parse(body) as dc.Interaction;

    if (i.type === dc.Type.PING) return dc.json({ type: dc.Reply.PONG });
    if (i.type !== dc.Type.APPLICATION_COMMAND) return new Response("ok");

    if (dc.callerId(i) !== env.DISCORD_USER_ID) {
      return dc.json({
        type: dc.Reply.MESSAGE,
        data: { content: "Not your slipbox.", flags: dc.EPHEMERAL },
      });
    }

    const command = i.data?.name;
    const opt = (name: string) =>
      i.data?.options?.find((o) => o.name === name)?.value?.trim();

    // Everything below needs at least two GitHub round-trips and won't fit
    // Discord's 3s deadline, so acknowledge now and edit the placeholder when
    // the work lands.
    switch (command) {
      case "note": {
        const text = opt("text");
        if (!text) return empty("Nothing to capture.");

        ctx.waitUntil(
          appendToInbox(env, localDate(env), text).then(
            () => dc.followUp(i, `✓ ${text}`),
            (e: Error) => {
              console.error(e);
              return dc.followUp(i, `✗ capture failed: ${e.message}`);
            },
          ),
        );
        return dc.json({ type: dc.Reply.DEFERRED });
      }

      case "gratitude": {
        const text = opt("text");
        if (!text) return empty("Nothing to record.");

        ctx.waitUntil(
          replyWithReflection(env, i, "gratitude", [["Grateful for", text]]),
        );
        return dc.json({ type: dc.Reply.DEFERRED });
      }

      case "reflect": {
        // Both halves are required — the reflection's whole move is reading the
        // lesson against the mistake, and Arete can't do that with one of them.
        const learned = opt("learned");
        const mistake = opt("mistake");
        if (!learned || !mistake) {
          return empty("Both `learned` and `mistake` are needed.");
        }

        ctx.waitUntil(
          replyWithReflection(env, i, "reflection", [
            ["Learned", learned],
            ["Mistake", mistake],
          ]),
        );
        return dc.json({ type: dc.Reply.DEFERRED });
      }

      default:
        return empty("Unknown command.");
    }
  },

  /** Cron. Fires at both DST candidate times; gates on local wall clock. */
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { minutes, weekday } = localParts(env);

    // Tolerance absorbs Cloudflare firing a minute or two late — an exact
    // match would silently skip the run. The two DST candidates are an hour
    // apart, so a ±10 window can't match both.
    const near = (h: string, m: string) =>
      Math.abs(minutes - (Number(h) * 60 + Number(m))) <= 10;

    if (
      weekday === env.WEEKLY_WEEKDAY &&
      near(env.WEEKLY_HOUR, env.WEEKLY_MINUTE)
    ) {
      ctx.waitUntil(run(env, "weekly"));
    } else if (near(env.DAILY_HOUR, env.DAILY_MINUTE)) {
      ctx.waitUntil(run(env, "daily"));
    } else if (
      weekday === env.REFLECT_WEEKDAY &&
      near(env.REFLECT_HOUR, env.REFLECT_MINUTE)
    ) {
      ctx.waitUntil(dc.send(env, REFLECT_NUDGE));
    } else if (near(env.GRATITUDE_HOUR, env.GRATITUDE_MINUTE)) {
      ctx.waitUntil(dc.send(env, GRATITUDE_NUDGE));
    } else if (near(env.NEWS_HOUR, env.NEWS_MINUTE)) {
      ctx.waitUntil(postNewsDigest(env, localDate(env)));
    }
    // Otherwise this is the wrong side of the DST pair — do nothing.
  },
};

/**
 * The outbound half of the ported gratitude job.
 *
 * Hermes DM'd this prompt at 19:00 and wrote the reply into the journal. The
 * Worker can only do the outbound half — the reply comes back as `/gratitude`.
 * Keeping the nudge matters more than it looks: the entry is a month-old daily
 * habit, and a ritual that depends on remembering it unprompted is a ritual
 * that lapses.
 */
const GRATITUDE_NUDGE =
  "🌙 What are you grateful for today?\n" +
  "Reply with `/gratitude <your answer>` and Arete will write back.";

/** The same inversion for the Sunday weekly reflection. */
const REFLECT_NUDGE =
  "🗓️ One thing you learned this week, and one mistake you made.\n" +
  "Reply with `/reflect learned:<…> mistake:<…>`.";

/** An immediate, private reply — used when a command arrives with no usable input. */
function empty(content: string): Response {
  return dc.json({
    type: dc.Reply.MESSAGE,
    data: { content, flags: dc.EPHEMERAL },
  });
}

// ------------------------------------------------------------------ agent

async function run(env: Env, kind: "daily" | "weekly") {
  try {
    const vault = await readVault(env);

    const promptPath = `Systems/prompts/${kind}-review.md`;
    const prompt = vault.get(promptPath);
    if (!prompt) throw new Error(`missing ${promptPath}`);

    const entry = (await generate(env, kind, prompt, vault)).trim();
    if (!entry) return;

    let review = vault.get(REVIEW) ?? "# Review\n\n---\n";
    review = prepend(review, entry);

    let pruned = "";
    if (kind === "weekly") {
      const before = countDailies(review);
      review = dropDailies(review);
      const archived = await archiveOldInbox(env, vault);
      pruned = `\n**Pruned:** ${before} daily entries folded · ${archived} inbox files archived\n`;
    }

    await writeFile(env, REVIEW, review + pruned, `${kind} review`);
    await dc.send(env, entry);
  } catch (e) {
    console.error(e);
    await dc.send(env, `⚠️ ${kind} review failed: ${(e as Error).message}`);
  }
}

// -------------------------------------------------------------- gratitude

/**
 * Record the entry, then send the reflection back in message-sized pieces.
 *
 * `record` commits before returning, so a Discord failure here costs the
 * notification and never the journal entry — the same ordering the reviews use.
 */
async function replyWithReflection(
  env: Env,
  i: dc.Interaction,
  ritual: Ritual,
  fields: Fields,
): Promise<void> {
  try {
    const { reflection, duplicate } = await recordJournal(env, ritual, fields);

    const note = duplicate ? "*(second entry for today — both kept)*\n\n" : "";
    const parts = dc.chunk(note + reflection);

    await dc.followUp(i, parts[0]);
    // Discord renders follow-ups in order, so the reflection reads continuously
    // even though it arrives as several messages.
    for (const part of parts.slice(1)) await dc.followUpMore(i, part);
  } catch (e) {
    console.error(e);
    await dc.followUp(i, `✗ ${ritual} failed: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ review

/**
 * Knowledge/ is a reference library, not thinking material — the agent needs
 * to know a note exists and roughly what it covers, never its body. Four
 * files there (PostgreSQL, Python Data Stack, FastAPI, Vue) are ~45% of the
 * vault by bytes and would dominate every prompt for nothing.
 *
 * Everything the agent actually reasons over — Inbox, Slipbox, Journal,
 * Systems, the board — ships in full.
 */
function excerpt(path: string, content: string): string {
  if (!path.startsWith("Knowledge/")) return content;
  const words = content.split(/\s+/);
  return words.length <= 200
    ? content
    : words.slice(0, 200).join(" ") + "\n…[reference note, truncated]";
}

async function generate(
  env: Env,
  kind: "daily" | "weekly",
  prompt: string,
  vault: Vault,
): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const corpus = [...vault]
    .filter(([p]) => !p.startsWith("Systems/prompts/"))
    .map(([p, c]) => `<file path="${p}">\n${excerpt(p, c)}\n</file>`)
    .join("\n\n");

  const stream = client.messages.stream({
    // Daily routing is a tractable task on Sonnet 5 and runs 7× as often.
    // The weekly pass is the one doing real work — recurrence across four
    // weeks of history — so it keeps Opus. Haiku is not an option: the
    // corpus is ~90K tokens and only just fits its 200K window today.
    model: kind === "weekly" ? "claude-opus-5" : "claude-sonnet-5",
    max_tokens: 32000,
    // No cache_control: runs are ≥24h apart, far beyond the 1h max TTL, and
    // daily/weekly are different models (caches are model-scoped). There
    // would be zero reads — only the 1.25× write premium on every run.
    system: [
      {
        type: "text",
        text: `Today is ${localDate(env)} (${env.TIMEZONE}).\n\nThe vault follows. Knowledge/ notes are truncated — they are reference material, not thinking material.\n\n${corpus}`,
      },
      { type: "text", text: prompt },
    ],
    // Recurrence detection across a growing corpus is the hard part of this
    // job; the weekly pass sees four weeks of history and gets more room.
    output_config: { effort: kind === "weekly" ? "xhigh" : "high" },
    messages: [
      {
        role: "user",
        content:
          "Produce the review entry now.\n\n" +
          "Output ONLY the markdown entry body, starting with its `## ` heading. " +
          "No preamble, no code fences, no closing commentary. The runtime " +
          "prepends your output to Journal/Review.md and performs all file " +
          "mutations — you cannot write files, so do not describe doing so.",
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

// ------------------------------------------------------------- Review.md

/** Insert a new entry directly below the header's `---` rule. */
function prepend(review: string, entry: string): string {
  const i = review.indexOf("\n---\n");
  if (i === -1) return `${review.trimEnd()}\n\n---\n\n${entry}\n`;
  const head = review.slice(0, i + 5);
  const rest = review.slice(i + 5).replace(/^\n+/, "");
  return `${head}\n${entry}\n\n${rest}`;
}

const DAILY_SECTION = /^## (?!Week of).*$/;

function sections(review: string): string[] {
  return review.split(/\n(?=## )/);
}

function countDailies(review: string): number {
  return sections(review).filter((s) => DAILY_SECTION.test(s.split("\n")[0]))
    .length;
}

/**
 * Daily entries are folded into the weekly one, then dropped. This is what
 * keeps Review.md from becoming a second pile.
 */
function dropDailies(review: string): string {
  return sections(review)
    .filter((s) => !DAILY_SECTION.test(s.split("\n")[0]))
    .join("\n");
}

// ----------------------------------------------------------------- inbox

/** Move inbox files past the 7-day window into Inbox/archive/. */
async function archiveOldInbox(env: Env, vault: Vault): Promise<number> {
  const cutoff = Date.now() - 7 * 864e5;
  let n = 0;

  for (const path of vault.keys()) {
    const m = path.match(/^Inbox\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    if (Date.parse(m[1] + "T00:00:00Z") >= cutoff) continue;

    await moveFile(env, path, `Inbox/archive/${m[1]}.md`, "archive inbox");
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ time

function localParts(env: Env) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: env.TIMEZONE,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date());

  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  // hourCycle h23 can render midnight as "24" — normalise before arithmetic.
  const hour = Number(get("hour")) % 24;
  return {
    minutes: hour * 60 + Number(get("minute")),
    weekday: get("weekday"),
  };
}

/** YYYY-MM-DD in the vault's timezone — matches the Daily Notes format. */
function localDate(env: Env): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
