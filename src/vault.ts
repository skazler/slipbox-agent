/**
 * Vault access over the GitHub API.
 *
 * Reading the whole vault is ONE subrequest: we pull the repo tarball and
 * untar it in the Worker. Fetching files individually would be 40+ calls and
 * would break the 50-subrequest limit on the Workers free plan once Slipbox/
 * grows.
 */

const API = "https://api.github.com";

export interface Env {
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
}

function headers(env: Env, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects API requests without a User-Agent.
    "User-Agent": "slipbox-agent",
    ...extra,
  };
}

/** path -> file contents, for every text file in the repo. */
export type Vault = Map<string, string>;

export async function readVault(env: Env): Promise<Vault> {
  const res = await fetch(
    `${API}/repos/${env.GITHUB_REPO}/tarball/${env.GITHUB_BRANCH}`,
    { headers: headers(env) },
  );
  if (!res.ok) throw new Error(`tarball ${res.status}: ${await res.text()}`);

  const gunzipped = res.body!.pipeThrough(new DecompressionStream("gzip"));
  return untar(new Uint8Array(await new Response(gunzipped).arrayBuffer()));
}

/**
 * Minimal tar reader.
 *
 * GitHub emits ustar, not pax: paths longer than 100 bytes are split across
 * the `prefix` field (offset 345) and `name` (offset 0). Reading `name`
 * alone silently truncates every deep path — which is most of Knowledge/.
 * pax extended headers are handled too, since other tar producers use them.
 */
function untar(buf: Uint8Array): Vault {
  const out: Vault = new Map();
  const dec = new TextDecoder();
  const str = (o: number, n: number) =>
    dec.decode(buf.subarray(o, o + n)).replace(/\0.*$/, "").trim();

  let pos = 0;
  let paxPath: string | null = null;

  while (pos + 512 <= buf.length) {
    // Two consecutive zero blocks terminate the archive.
    if (buf[pos] === 0) break;

    const prefix = str(pos + 345, 155);
    const name = str(pos, 100);
    const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    const size = parseInt(str(pos + 124, 12) || "0", 8);
    const type = String.fromCharCode(buf[pos + 156]);
    const body = pos + 512;
    const next = body + Math.ceil(size / 512) * 512;
    paxPath = null;

    if (type === "x" || type === "X") {
      // pax header: records look like "<len> path=<value>\n"
      const m = dec
        .decode(buf.subarray(body, body + size))
        .match(/\d+ path=(.*)\n/);
      if (m) paxPath = m[1];
    } else if (type === "0" || type === "\0") {
      // Strip GitHub's "<owner>-<repo>-<sha>/" wrapper directory.
      const path = full.split("/").slice(1).join("/");
      if (path && isText(path)) {
        out.set(path, dec.decode(buf.subarray(body, body + size)));
      }
    }

    pos = next;
  }
  return out;
}

function isText(path: string) {
  return /\.(md|txt|json|canvas)$/i.test(path) && !path.startsWith(".obsidian/");
}

/**
 * Read one file. For jobs that need a single prompt rather than the corpus —
 * pulling the whole tarball to read 6KB is a lot of wasted bytes on a job that
 * never reasons over the vault.
 */
export async function readFile(env: Env, path: string): Promise<string | null> {
  const res = await fetch(
    `${API}/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${env.GITHUB_BRANCH}`,
    { headers: headers(env) },
  );
  if (!res.ok) return null;

  const { content } = (await res.json()) as { content: string };
  return b64decode(content);
}

/** Create or update a single file. Read-modify-write; last writer wins. */
export async function writeFile(
  env: Env,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const url = `${API}/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;

  // Need the blob sha to update an existing file; absent means create.
  const head = await fetch(`${url}?ref=${env.GITHUB_BRANCH}`, {
    headers: headers(env),
  });
  const sha = head.ok ? ((await head.json()) as { sha: string }).sha : undefined;

  const res = await fetch(url, {
    method: "PUT",
    headers: headers(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      message,
      content: b64encode(content),
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`write ${path} ${res.status}: ${await res.text()}`);
}

/** UTF-8 safe base64 — btoa alone mangles emoji and non-ASCII. */
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Append a line to today's inbox file, creating it if needed. */
export async function appendToInbox(
  env: Env,
  date: string,
  text: string,
): Promise<void> {
  const path = `Inbox/${date}.md`;
  const url = `${API}/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;

  const head = await fetch(`${url}?ref=${env.GITHUB_BRANCH}`, {
    headers: headers(env),
  });

  let existing = "";
  let sha: string | undefined;
  if (head.ok) {
    const j = (await head.json()) as { sha: string; content: string };
    sha = j.sha;
    existing = b64decode(j.content);
  }

  const body = existing.trimEnd();
  const next = (body ? body + "\n\n" : "") + text.trim() + "\n";

  const res = await fetch(url, {
    method: "PUT",
    headers: headers(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      message: `capture: ${date}`,
      content: b64encode(next),
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`capture ${res.status}: ${await res.text()}`);
}

/**
 * Move a file. The contents API has no rename, so this is create-then-delete;
 * a failure between the two leaves a harmless copy rather than losing data.
 */
export async function moveFile(
  env: Env,
  from: string,
  to: string,
  message: string,
): Promise<void> {
  const src = `${API}/repos/${env.GITHUB_REPO}/contents/${encodeURI(from)}`;

  const head = await fetch(`${src}?ref=${env.GITHUB_BRANCH}`, {
    headers: headers(env),
  });
  if (!head.ok) return;
  const { sha, content } = (await head.json()) as {
    sha: string;
    content: string;
  };

  await writeFile(env, to, b64decode(content), message);

  const del = await fetch(src, {
    method: "DELETE",
    headers: headers(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ message, sha, branch: env.GITHUB_BRANCH }),
  });
  if (!del.ok) throw new Error(`delete ${from} ${del.status}`);
}

function b64decode(s: string): string {
  const bin = atob(s.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
