/**
 * Discord transport.
 *
 * Notifications go out through a channel webhook. Capture comes in through an
 * Interactions endpoint — a Worker can't hold the persistent WebSocket a
 * Discord bot needs for DMs, so a `/note` slash command is the only inbound
 * path available to us.
 */

export interface DiscordEnv {
  DISCORD_WEBHOOK_URL: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_USER_ID: string;
}

/** Discord hard-caps a message at 2000 characters. */
const MAX = 2000;

/**
 * Outbound only, so it asks for the webhook and nothing else — jobs that never
 * handle an interaction shouldn't have to carry the verification keys just to
 * post a message.
 */
export async function send(
  env: Pick<DiscordEnv, "DISCORD_WEBHOOK_URL">,
  text: string,
): Promise<void> {
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: text.length > MAX ? text.slice(0, MAX - 1) + "…" : text,
      // Wikilinks and bare URLs would otherwise unfurl into preview cards and
      // bury the questions.
      flags: 4, // SUPPRESS_EMBEDS
    }),
  });
  // A push failure must not fail the run — the review is already committed.
  if (!res.ok) console.error(`discord ${res.status}: ${await res.text()}`);
}

// ------------------------------------------------------- interactions

export const Type = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

export const Reply = {
  PONG: 1,
  MESSAGE: 4,
  DEFERRED: 5,
} as const;

export const EPHEMERAL = 64;

export interface Interaction {
  type: number;
  id: string;
  token: string;
  application_id: string;
  data?: {
    name: string;
    options?: { name: string; value: string }[];
  };
  member?: { user: { id: string } };
  user?: { id: string };
}

/**
 * Discord signs every request and *requires* rejection of bad signatures —
 * it periodically sends deliberately invalid ones, and an endpoint that
 * accepts them gets disabled.
 */
export async function verify(req: Request, body: string, env: DiscordEnv) {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hex(env.DISCORD_PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hex(sig),
      new TextEncoder().encode(ts + body),
    );
  } catch (e) {
    console.error("signature verify failed", e);
    return false;
  }
}

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Edit the deferred "thinking…" placeholder once the work is actually done.
 * We defer rather than replying inline because Discord kills an interaction
 * that doesn't answer within 3s, and a capture is two GitHub round-trips.
 */
export async function followUp(
  interaction: Interaction,
  text: string,
): Promise<void> {
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    },
  );
  if (!res.ok) console.error(`followUp ${res.status}: ${await res.text()}`);
}

/**
 * Post an ADDITIONAL follow-up message. `followUp` edits the one placeholder
 * and so tops out at 2000 characters; a gratitude reflection is routinely
 * longer than that, and truncating the thing you're meant to sit with defeats
 * the point.
 */
export async function followUpMore(
  interaction: Interaction,
  text: string,
): Promise<void> {
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    },
  );
  if (!res.ok) console.error(`followUpMore ${res.status}: ${await res.text()}`);
}

/**
 * Split text into message-sized pieces, breaking at paragraph boundaries where
 * possible and sentence boundaries otherwise. Mid-word splits read as a bug.
 */
export function chunk(text: string, max = MAX - 100): string[] {
  const out: string[] = [];
  let rest = text.trim();

  while (rest.length > max) {
    const window = rest.slice(0, max);
    // Prefer a paragraph break, then a sentence end, then any whitespace.
    const cut =
      window.lastIndexOf("\n\n") + 1 ||
      window.search(/\.[^.]*$/) + 1 ||
      window.lastIndexOf(" ") + 1 ||
      max;

    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) out.push(rest);
  return out;
}

/** The user id from either a guild command or a DM. */
export function callerId(i: Interaction): string | undefined {
  return i.member?.user.id ?? i.user?.id;
}
