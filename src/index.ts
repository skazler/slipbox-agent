import * as dc from "./discord";
import {
  answer as answerGratitude,
  GRATITUDE_QUESTIONS,
  record as recordJournal,
  VALUE_GOAL,
  type Fields,
  type Question,
  type Ritual,
} from "./journal";
import { rollUpZettels } from "./zettels";
import { appendToInbox } from "./vault";

export interface Env {
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
  // #learning carries the zettel roll-up notice and both journal nudges.
  DISCORD_WEBHOOK_LEARNING: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_USER_ID: string;
  TIMEZONE: string;
  GRATITUDE_HOUR: string;
  GRATITUDE_MINUTE: string;
  REFLECT_HOUR: string;
  REFLECT_MINUTE: string;
  REFLECT_WEEKDAY: string;
  ZETTELS_HOUR: string;
  ZETTELS_MINUTE: string;
  ZETTELS_WEEKDAY: string;
}

// ---------------------------------------------------------------- capture

export default {
  /** Discord Interactions endpoint. `/zettel <text>` appends to today's inbox. */
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
      case "zettel": {
        const text = opt("text");
        if (!text) return empty("Nothing to capture.");

        ctx.waitUntil(
          appendToInbox(env, localDate(env), `[${localTime(env)}]\n${text}`).then(
            () => dc.followUp(i, `✓ ${text}`),
            (e: Error) => {
              console.error(e);
              return dc.followUp(i, `✗ capture failed: ${e.message}`);
            },
          ),
        );
        return dc.json({ type: dc.Reply.DEFERRED });
      }

      case "gratitude":
      case "long-dream":
      case "near-dream":
      case "relationships":
      case "values": {
        const text = opt("text");
        if (!text) return empty("Nothing to record.");

        ctx.waitUntil(replyToAnswer(env, i, command, text));
        return dc.json({ type: dc.Reply.DEFERRED });
      }

      case "reflect": {
        // All three are required.
        const learned = opt("learned");
        const mistake = opt("mistake");
        const value = opt("value");
        if (!learned || !mistake || !value) {
          return empty("`learned`, `mistake` and `value` are all needed.");
        }

        ctx.waitUntil(
          replyWithRecord(env, i, "reflection", [
            ["Learned", learned],
            ["Mistake", mistake],
            [VALUE_GOAL, value],
          ]),
        );
        return dc.json({ type: dc.Reply.DEFERRED });
      }

      default:
        return empty("Unknown command.");
    }
  },

  /** Cron. Wakes every 15 minutes; gates on local wall clock. */
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { minutes, weekday } = localParts(env);

    // Tolerance absorbs Cloudflare firing a minute or two late — an exact
    // match would silently skip the run. It MUST stay under half the 15-minute
    // tick spacing, or two jobs on adjacent ticks would both match the same
    // tick and the if/else below would silently drop the later branch.
    const near = (h: string, m: string) =>
      Math.abs(minutes - (Number(h) * 60 + Number(m))) <= 7;

    if (
      weekday === env.ZETTELS_WEEKDAY &&
      near(env.ZETTELS_HOUR, env.ZETTELS_MINUTE)
    ) {
      ctx.waitUntil(
        rollUpZettels(env, localDate(env)).then(
          async ({ count, archived, range, filed }) => {
            console.log(`zettel roll-up: ${count} filed to Review.md, ${archived} inbox files archived`);
            // Silent on a rerun that found the entry already written — the
            // first run already announced it.
            if (!archived) {
              await dc.send(env.DISCORD_WEBHOOK_LEARNING, "📥 Weekly zettel roll-up: inbox was empty, nothing to file.");
            } else if (filed) {
              await dc.send(
                env.DISCORD_WEBHOOK_LEARNING,
                `📥 Weekly zettel roll-up: ${count} zettel${count === 1 ? "" : "s"} (${range}) ` +
                  `copied verbatim to Journal >> Review, ${archived} inbox file${archived === 1 ? "" : "s"} archived.`,
              );
            }
          },
          async (e: Error) => {
            console.error(e);
            await dc.send(
              env.DISCORD_WEBHOOK_LEARNING,
              `⚠️ weekly zettel roll-up failed: ${e.message}`,
            );
          },
        ),
      );
    } else if (
      weekday === env.REFLECT_WEEKDAY &&
      near(env.REFLECT_HOUR, env.REFLECT_MINUTE)
    ) {
      ctx.waitUntil(dc.send(env.DISCORD_WEBHOOK_LEARNING, REFLECT_NUDGE));
    } else if (near(env.GRATITUDE_HOUR, env.GRATITUDE_MINUTE)) {
      ctx.waitUntil(dc.send(env.DISCORD_WEBHOOK_LEARNING, GRATITUDE_NUDGE));
    }
    // Otherwise this tick isn't a job time — do nothing. Most of them aren't.
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
  "🌙 Tonight:\n" +
  "• What are you grateful for today?\n" +
  "• One \"unrealistic\" long-term dream you're concretely chasing — and how?\n" +
  "• One closer-term dream you're concretely chasing — and how?\n" +
  "• How are you cultivating genuine relationships right now?\n" +
  "• How did you live in alignment with your values today — and if you didn't, how will you improve tomorrow?\n" +
  "Answer each with its own command — `/gratitude`, `/long-dream`, " +
  "`/near-dream`, `/relationships`, `/values` — in any order. The entry is " +
  "written to the journal once all five are in.";

/** The same inversion for the Sunday weekly reflection. */
const REFLECT_NUDGE =
  "🗓️ One thing you learned this week, one mistake you made, and a value " +
  "to live by this coming week.\n" +
  "Reply with `/reflect learned:<…> mistake:<…> value:<…>`.";

/** An immediate, private reply — used when a command arrives with no usable input. */
function empty(content: string): Response {
  return dc.json({
    type: dc.Reply.MESSAGE,
    data: { content, flags: dc.EPHEMERAL },
  });
}

// -------------------------------------------------------------- gratitude

/**
 * Record the entry verbatim and confirm. `record` commits before returning, so
 * a Discord failure costs the notification, never the entry.
 */
async function replyWithRecord(
  env: Env,
  i: dc.Interaction,
  ritual: Ritual,
  fields: Fields,
): Promise<void> {
  try {
    const { duplicate } = await recordJournal(env, ritual, fields);
    const note = duplicate ? " (second entry for today — both kept)" : "";
    await dc.followUp(i, `✓ Recorded to Journal >> Weekly Reflection${note}.`);
  } catch (e) {
    console.error(e);
    await dc.followUp(i, `✗ ${ritual} failed: ${(e as Error).message}`);
  }
}

/**
 * Save one gratitude answer. The first four just confirm what's still missing;
 * the fifth records the entry to the journal — no reflection comes back.
 */
async function replyToAnswer(
  env: Env,
  i: dc.Interaction,
  question: Question,
  text: string,
): Promise<void> {
  try {
    const result = await answerGratitude(env, question, text);
    if (!result.done) {
      const left = result.missing.map((q) => `\`/${q}\``).join(", ");
      await dc.followUp(
        i,
        `✓ ${GRATITUDE_QUESTIONS[question]} saved — still need ${left}.`,
      );
      return;
    }
    const note = result.duplicate ? " (second entry for today — both kept)" : "";
    await dc.followUp(i, `✓ Recorded to Journal >> Cogitations${note}.`);
  } catch (e) {
    console.error(e);
    await dc.followUp(i, `✗ gratitude failed: ${(e as Error).message}`);
  }
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

/** HH:MM (24h) in the vault's timezone — stamps each /zettel capture. */
function localTime(env: Env): string {
  const { minutes } = localParts(env);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
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
