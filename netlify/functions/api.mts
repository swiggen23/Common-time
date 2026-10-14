import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Common Time API. No accounts:
 *  - Creating a poll returns a secret manage token (only its hash is stored).
 *  - Joining a poll returns a secret guest token (only its hash is stored).
 * Each guest's answers live in their own key, so guests never overwrite each other.
 */

const store = () => getStore({ name: "commontime", consistency: "strong" });

const ID_RE = /^[a-z0-9]{6,32}$/;
const VALS = new Set(["y", "m", "n"]);
const MAX_OPTIONS = 60;
const MAX_VOTERS = 300;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const err = (message: string, status = 400) => json({ error: message }, status);

const newId = (n = 10) => randomBytes(16).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, n).padEnd(n, "0");
const newToken = () => randomBytes(24).toString("base64url");
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const tokenOk = (given: string | null, storedHash: string | undefined) => {
  if (!given || !storedHash) return false;
  const a = Buffer.from(hash(given), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

type Option = { id: string; date: string; start: string | null };
type Poll = {
  id: string; title: string; note: string; location: string; duration: number;
  options: Option[]; tz: string; finalId: string | null; createdAt: number; updatedAt: number; manageHash: string;
};
type Vote = {
  id: string; name: string; answers: Record<string, string>; note: string;
  going: "" | "yes" | "no"; at: number; tokenHash: string;
};

function cleanOptions(raw: unknown): Option[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPTIONS) return null;
  const out: Option[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const date = str(o.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    let start: string | null = null;
    if (o.start != null) {
      const d = new Date(String(o.start));
      if (isNaN(d.getTime())) return null;
      start = d.toISOString();
    }
    let id = str(o.id, 32);
    if (!ID_RE.test(id)) id = newId(8);
    if (seen.has(id)) id = newId(8);
    seen.add(id);
    out.push({ id, date, start });
  }
  return out;
}

function publicPoll(p: Poll) {
  const { manageHash, ...rest } = p;
  return rest;
}
function publicVote(v: Vote) {
  const { tokenHash, ...rest } = v;
  return rest;
}

async function loadPoll(pid: string): Promise<Poll | null> {
  if (!ID_RE.test(pid)) return null;
  return (await store().get(`poll/${pid}`, { type: "json" })) as Poll | null;
}

async function loadVotes(pid: string): Promise<Vote[]> {
  const s = store();
  const { blobs } = await s.list({ prefix: `vote/${pid}/` });
  const votes = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" }) as Promise<Vote | null>));
  return votes.filter(Boolean).sort((a, b) => a!.at - b!.at) as Vote[];
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 50_000) return null;
    const b = JSON.parse(text || "{}");
    return b && typeof b === "object" ? b : null;
  } catch {
    return null;
  }
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const s = store();

  try {
    // POST /api/polls  -> create
    if (parts.length === 1 && parts[0] === "polls" && method === "POST") {
      const b = await readBody(req);
      if (!b) return err("Invalid request");
      const title = str(b.title, 120);
      if (!title) return err("Give the poll a name.");
      const options = cleanOptions(b.options);
      if (!options) return err("Add at least one date (up to 60 options).");
      const token = newToken();
      const poll: Poll = {
        id: newId(10), title, note: str(b.note, 1000), location: str(b.location, 200),
        duration: Math.max(0, Math.min(1440, Number(b.duration) || 0)), options,
        tz: str(b.tz, 64), finalId: null, createdAt: Date.now(), updatedAt: Date.now(), manageHash: hash(token),
      };
      await s.setJSON(`poll/${poll.id}`, poll);
      return json({ poll: publicPoll(poll), manageToken: token }, 201);
    }

    if (parts[0] !== "polls" || !parts[1]) return err("Not found", 404);
    const pid = parts[1];
    const poll = await loadPoll(pid);
    if (!poll) return err("This poll doesn't exist or was deleted.", 404);
    const manageOk = tokenOk(req.headers.get("x-manage-token"), poll.manageHash);

    // /api/polls/:pid
    if (parts.length === 2) {
      if (method === "GET") {
        const votes = await loadVotes(pid);
        return json({ poll: publicPoll(poll), votes: votes.map(publicVote), canManage: manageOk });
      }
      if (method === "PUT") {
        if (!manageOk) return err("Only the organizer can change this poll.", 403);
        const b = await readBody(req);
        if (!b) return err("Invalid request");
        if ("title" in b) {
          const t = str(b.title, 120);
          if (!t) return err("Give the poll a name.");
          poll.title = t;
        }
        if ("note" in b) poll.note = str(b.note, 1000);
        if ("location" in b) poll.location = str(b.location, 200);
        if ("duration" in b) poll.duration = Math.max(0, Math.min(1440, Number(b.duration) || 0));
        if ("options" in b) {
          const o = cleanOptions(b.options);
          if (!o) return err("Add at least one date (up to 60 options).");
          poll.options = o;
          if (poll.finalId && !o.some((x) => x.id === poll.finalId)) poll.finalId = null;
        }
        if ("finalId" in b) {
          const f = b.finalId == null ? null : String(b.finalId);
          if (f && !poll.options.some((x) => x.id === f)) return err("That time isn't in this poll.");
          poll.finalId = f;
        }
        poll.updatedAt = Date.now();
        await s.setJSON(`poll/${pid}`, poll);
        return json({ poll: publicPoll(poll) });
      }
      if (method === "DELETE") {
        if (!manageOk) return err("Only the organizer can delete this poll.", 403);
        const { blobs } = await s.list({ prefix: `vote/${pid}/` });
        await Promise.all(blobs.map((x) => s.delete(x.key)));
        await s.delete(`poll/${pid}`);
        return json({ ok: true });
      }
      return err("Method not allowed", 405);
    }

    // /api/polls/:pid/votes  -> join
    if (parts.length === 3 && parts[2] === "votes" && method === "POST") {
      const b = await readBody(req);
      if (!b) return err("Invalid request");
      const name = str(b.name, 60);
      if (!name) return err("Enter your name.");
      const { blobs } = await s.list({ prefix: `vote/${pid}/` });
      if (blobs.length >= MAX_VOTERS) return err("This poll is full.", 409);
      const token = newToken();
      const vote: Vote = { id: newId(10), name, answers: {}, note: "", going: "", at: Date.now(), tokenHash: hash(token) };
      await s.setJSON(`vote/${pid}/${vote.id}`, vote);
      return json({ vote: publicVote(vote), voterToken: token }, 201);
    }

    // /api/polls/:pid/votes/:vid
    if (parts.length === 4 && parts[2] === "votes") {
      const vid = parts[3];
      if (!ID_RE.test(vid)) return err("Not found", 404);
      const key = `vote/${pid}/${vid}`;
      const vote = (await s.get(key, { type: "json" })) as Vote | null;
      if (!vote) return err("We couldn't find those answers.", 404);
      const voterOk = tokenOk(req.headers.get("x-voter-token"), vote.tokenHash);

      if (method === "GET") {
        if (!voterOk) return err("This personal link isn't valid.", 403);
        return json({ vote: publicVote(vote) });
      }
      if (method === "PUT") {
        if (!voterOk) return err("You can only change your own answers.", 403);
        const b = await readBody(req);
        if (!b) return err("Invalid request");
        if ("name" in b) {
          const n = str(b.name, 60);
          if (n) vote.name = n;
        }
        if ("note" in b) vote.note = str(b.note, 300);
        if ("going" in b) vote.going = b.going === "yes" || b.going === "no" ? b.going : "";
        if ("answers" in b && b.answers && typeof b.answers === "object") {
          const valid = new Set(poll.options.map((o) => o.id));
          const next: Record<string, string> = {};
          for (const [k, v] of Object.entries(b.answers as Record<string, unknown>)) {
            if (valid.has(k) && typeof v === "string" && VALS.has(v)) next[k] = v;
          }
          vote.answers = next;
        }
        vote.at = vote.at || Date.now();
        await s.setJSON(key, vote);
        return json({ vote: publicVote(vote) });
      }
      if (method === "DELETE") {
        if (!voterOk && !manageOk) return err("Not allowed.", 403);
        await s.delete(key);
        return json({ ok: true });
      }
      return err("Method not allowed", 405);
    }

    return err("Not found", 404);
  } catch (e) {
    console.error("api error", e);
    return err("Something went wrong on our side. Try again in a moment.", 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
