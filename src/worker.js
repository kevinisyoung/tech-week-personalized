import ALL_EVENTS from "./events.json";

const MAX_FIELD_CHARS = 120_000; // per profile field; resumes and LinkedIn exports are far smaller
// Measured on subq-snap-preview: 207,889 input tokens for ~863K characters of state (~4.15 chars/token).
const CHARS_PER_TOKEN = 4.15;
const MODEL_TIMEOUT_MS = 170_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    refreshWindow(env);
    try {
      if (url.pathname === "/api/events" && request.method === "GET") return eventsResponse(env);
      if (url.pathname === "/api/rank" && request.method === "POST") return await rank(request, env);
      if (url.pathname === "/api/github" && request.method === "GET") return await github(url, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("unhandled", err?.message);
      return json({ error: "Something went wrong. Try again in a minute." }, 500);
    }
  },
};

function eventsResponse(env) {
  return json(
    {
      model: env.MODEL_LABEL || "Snap",
      cityLabel: CITY_LABEL,
      count: EVENTS.length,
      // Size of the full event list as sent, so the page can show the context filling up.
      eventTokens: Math.round(EVENT_BLOCK.length / CHARS_PER_TOKEN),
      windowTokens: windowTokens(env),
      ctaUrl: /^https:\/\//.test(env.SNAP_CTA_URL || "") ? env.SNAP_CTA_URL : null,
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

async function rank(request, env) {
  if (env.RANKING_DISABLED === "1") return json({ error: "Ranking is paused for maintenance. Check back soon." }, 503);
  if (!EVENTS.length) return json({ error: "The event list hasn't been loaded yet." }, 503);

  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (env.RANK_LIMITER) {
    const { success } = await env.RANK_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "You're going a bit fast. Wait a minute and try again." }, 429);
  }

  const profile = await readProfile(request);
  if (profile instanceof Response) return profile;

  if (EVENT_BLOCK.length / CHARS_PER_TOKEN > windowTokens(env)) return json({ error: "The event list is larger than the context window." }, 503);
  const topN = clampInt(env.TOP_N, 30, 5, 100);

  let result;
  if (env.SUBQ_BASE_URL && env.SUBQ_API_KEY && env.SUBQ_MODEL) result = await rankInOneRequest(profile, topN, env);
  else if (env.MOCK_RANKER === "1") result = rankWithKeywords(profile, topN);
  else return json({ error: "The ranking model isn't configured yet." }, 503);

  return json(result);
}

async function readProfile(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Couldn't read that request." }, 400);
  }
  const profile = {
    resume: clean(body?.resume),
    github: clean(body?.github),
    interests: clean(body?.interests),
  };
  if (!profile.resume && !profile.github && !profile.interests) {
    return json({ error: "Add your GitHub, a resume or LinkedIn PDF, or a few interests first." }, 400);
  }
  return profile;
}

// ---------- Interests: topics and timing ----------
//
// Questions ask about what the attendee says they want (topics, perks, vibe), not just their work:
// "easy free food" is a valid thing to look for. When the attendee names a day, time of day, or
// neighborhood, it's treated as a requirement. (Tested: this makes "Thursday evening" return only
// Thursday evenings, but it lowers quality for plain topic searches, so it's only added when one is
// mentioned.)
const CONSTRAINT_WORDS = /\b(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs?(day)?)?|fri(day)?|sat(urday)?|sun(day)?)s?\b|\b(weekend|weekday|today|tonight|tomorrow|morning|afternoon|evening|night|soma|fidi|mission district|dogpatch|hayes valley|marina|presidio|embarcadero|downtown|union square|north beach|potrero|jackson square|civic center|palo alto|stanford|oakland|venice|santa monica|arts district|playa vista|silver lake|culver city|hollywood|pasadena|el segundo|marina del rey|downtown la|dtla|in person|virtual)\b|\b\d{1,2}\s?(am|pm)\b/i;

// Split "AI evals, free food, Thursday evening" into topics (each gets its own question, up to 4)
// and timing/place requirements (applied to every question rather than scored on their own).
function interestParts(text) {
  const parts = (text || "").split(/[,;\n]+/).map((p) => p.trim()).filter((p) => p.length > 1);
  const constraints = parts.filter((p) => CONSTRAINT_WORDS.test(p));
  const topics = parts.filter((p) => !CONSTRAINT_WORDS.test(p));
  return { topics: topics.length > 1 ? topics.slice(0, 4) : [], constraints };
}

// ---------- Snap: one request over the full context ----------
//
// Every event goes in `state` once. The events are split into a few balanced `choice` questions
// (<=255 options each, the API's limit), all in the same request; with several listed interests,
// each gets its own set. Snap counts the state once per request, so extra questions are cheap.
// A choice's probabilities sum to 1 within its question, so each event is scored by its "lift":
// probability x options (1 = an even split), which makes events from different questions comparable.

const CHOICE_MAX = 255;

function choiceGroups(events) {
  const n = Math.max(1, Math.ceil(events.length / CHOICE_MAX));
  const size = Math.ceil(events.length / n);
  return chunk(events.map((e) => e.id), size);
}

function choiceQuestion(ids, ask, constraints) {
  return {
    type: "choice",
    instructions:
      `Which of these events is the strongest match for ${ask}?` +
      (constraints.length ? ` It must also fit "${constraints.join(", ")}"; an event outside that day, time, or place is not a match.` : ""),
    criteria: Object.fromEntries(ids.map((id) => [id, `[${id}] ${EVENTS_BY_ID.get(id).title}`])),
  };
}

function oneRequestQuestions(profile) {
  const groups = choiceGroups(EVENTS);
  const { topics, constraints } = interestParts(profile.interests);
  const allConstraints = constraints.length ? constraints : CONSTRAINT_WORDS.test(profile.interests) ? [profile.interests] : [];
  const questions = {};
  groups.forEach((ids, g) => {
    questions[`all${g}`] = choiceQuestion(ids, "what this attendee says they're looking for", allConstraints);
    topics.forEach((topic, k) => (questions[`t${k}g${g}`] = choiceQuestion(ids, `this interest: "${topic}"`, constraints)));
  });
  return { questions, groups, topics };
}

// lift 1 = no better than an even split; ~10 = a clear pick; 50+ = the obvious one.
const liftScore = (lift) => Math.round(100 * (1 - Math.exp(-lift / 12)));

async function rankInOneRequest(profile, topN, env) {
  const started = Date.now();
  const state = buildState(profile);
  const { questions, groups, topics } = oneRequestQuestions(profile);
  const data = await callDecisions(env, state, questions);

  const sizeOf = new Map(groups.flatMap((ids) => ids.map((id) => [id, ids.length])));
  const lift = {}; // best lift per event across all its questions
  const topicLift = topics.map(() => ({}));
  for (const [qid, answer] of Object.entries(data.answers || {})) {
    const k = qid.startsWith("t") ? Number(qid.slice(1, qid.indexOf("g"))) : -1;
    for (const [id, p] of Object.entries(answer?.probabilities || {})) {
      if (!sizeOf.has(id) || typeof p !== "number") continue;
      const l = p * sizeOf.get(id);
      lift[id] = Math.max(lift[id] ?? 0, l);
      if (k >= 0) topicLift[k][id] = Math.max(topicLift[k][id] ?? 0, l);
    }
  }
  if (!Object.keys(lift).length) throw new Error("no answers from Snap");

  // Same listing twice (e.g. two sessions): keep the best.
  const seen = new Set();
  const unique = Object.entries(lift)
    .sort((a, b) => b[1] - a[1])
    .filter(([id]) => {
      const e = EVENTS_BY_ID.get(id);
      const key = `${e.title.trim().toLowerCase()}|${e.host || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // With several interests, lead with each interest's top event so none is crowded out.
  const lead = [];
  for (const t of topicLift) {
    const top = unique.filter(([id]) => !lead.includes(id)).sort((a, b) => (t[b[0]] ?? 0) - (t[a[0]] ?? 0))[0];
    if (top) lead.push(top[0]);
  }
  const ordered = [
    ...unique.filter(([id]) => lead.includes(id)),
    ...unique.filter(([id]) => !lead.includes(id)),
  ];
  const ranked = ordered.slice(0, topN).map(([id, l]) => ({ event: EVENTS_BY_ID.get(id), score: liftScore(l), why: "" }));

  const input = data.usage?.input_tokens;
  return {
    mode: "model",
    model: env.MODEL_LABEL || "Snap",
    summary: "",
    ranked,
    stats: {
      eventsRead: EVENTS.length,
      questions: Object.keys(questions).length,
      promptTokens: typeof input === "number" ? input : null,
      promptTokensEstimate: Math.round(state.length / CHARS_PER_TOKEN),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    },
  };
}

// ---------- Building the state ----------

function profileText(profile) {
  return [
    "ATTENDEE PROFILE",
    profile.resume && `## Resume\n${profile.resume}`,
    profile.github && `## GitHub\n${profile.github}`,
    profile.interests && `## Stated interests\n${profile.interests}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PROFILE_CHARS);
}

function buildState(profile) {
  return `${profileText(profile)}\n\n${CITY_LABEL} TECH WEEK EVENTS (${EVENTS.length})\n${EVENT_LIST_HEADER}\n\n${EVENT_BLOCK}`;
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// POST {SUBQ_BASE_URL}/v1/systemone  { model, state, questions }
async function callDecisions(env, state, questions) {
  const res = await fetch(`${env.SUBQ_BASE_URL.replace(/\/$/, "")}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.SUBQ_API_KEY}` },
    body: JSON.stringify({ model: env.SUBQ_MODEL, state, questions }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  // Log status only. Never log the request body: it contains the visitor's resume.
  if (!res.ok) throw new Error(`model ${res.status}`);
  return res.json();
}

// Compact local time, e.g. "Thu 6–8 PM (evening)" or "Wed 11 AM–1 PM (morning)". All times are
// Pacific (stated once in the event-list header), so "Thursday evening" can match.
const PT_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" });
const PT_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" });
function ptParts(iso) {
  const p = Object.fromEntries(PT_PARTS.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: p.weekday, time: `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}`, period: p.dayPeriod };
}
function pacificWhen(e) {
  if (!Number.isFinite(Date.parse(e.start))) return e.start;
  const a = ptParts(e.start);
  let text;
  if (e.end && Number.isFinite(Date.parse(e.end))) {
    const b = ptParts(e.end);
    if (pacificDay(e.end) !== pacificDay(e.start)) text = `${a.day} ${a.time} ${a.period} to ${b.day} ${b.time} ${b.period}`;
    else if (a.period === b.period) text = `${a.day} ${a.time}–${b.time} ${b.period}`;
    else text = `${a.day} ${a.time} ${a.period}–${b.time} ${b.period}`;
  } else text = `${a.day} ${a.time} ${a.period}`;
  const hour = Number(PT_HOUR.format(new Date(e.start)));
  return `${text} (${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"})`;
}

// The host's description, minus text that carries no information about the event: the stock
// "#SFTechWeek" / "#LATechWeek" sentence many listings end with, raw links, and emoji. Nothing else is shortened.
const BOILERPLATE = /\s*This event is (?:a )?part of #?(?:SF|LA|NYC?) ?Tech ?Week\b[^.]*\.(?:\s*Learn more at \S+)?/gi;
const LINKS = /\s*(?:https?:\/\/|www\.)\S+/gi;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
function cleanDescription(text) {
  return (text || "").replace(BOILERPLATE, " ").replace(LINKS, " ").replace(EMOJI, "").replace(/\s+/g, " ").trim();
}

// Explains the unlabeled fields in each event line, once per request.
const EVENT_LIST_HEADER = "All times are Pacific. Each line: [id] title | when | host | where | description";

// Cap on the visitor's profile (~27K tokens) so it can't crowd the events out of the window.
// Event descriptions are never shortened.
const PROFILE_CHARS = 90_000;

function formatEvent(e) {
  const about = cleanDescription(e.description);
  const parts = [
    `[${e.id}] ${e.title}`,
    pacificWhen(e),
    e.host || "",
    e.neighborhood || e.location || "",
    e.registration === "waitlist" ? `waitlist only. ${about}` : about,
  ];
  return parts.join(" | ").replace(/( \| )+$/, "");
}

// Only events that haven't ended yet, through the end of Tech Week, are ranked or counted. Events
// without an end time are treated as lasting 3 hours. The window refreshes every 10 minutes; set
// NOW to an ISO timestamp to pin it for testing.
const EVENT_LINES = new Map(ALL_EVENTS.map((e) => [e.id, formatEvent(e)]));
const EVENTS_BY_ID = new Map(ALL_EVENTS.map((e) => [e.id, e]));
const ASSUMED_DURATION_MS = 3 * 60 * 60 * 1000;
let EVENTS = [];
let EVENT_BLOCK = "";
// The city and last day of its Tech Week (CITY_LABEL / TECH_WEEK_LAST_DAY vars).
let CITY_LABEL = "LA";
let TECH_WEEK_LAST_DAY = "2026-10-18";
let windowBucket = null;

function pacificDay(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function refreshWindow(env) {
  if (env.CITY_LABEL) CITY_LABEL = env.CITY_LABEL;
  if (/^\d{4}-\d{2}-\d{2}$/.test(env.TECH_WEEK_LAST_DAY || "")) TECH_WEEK_LAST_DAY = env.TECH_WEEK_LAST_DAY;
  const pinned = Date.parse(env.NOW || "");
  const now = Number.isFinite(pinned) ? pinned : Date.now();
  const bucket = Math.floor(now / 600_000);
  if (bucket === windowBucket) return;
  windowBucket = bucket;
  EVENTS = ALL_EVENTS.filter((e) => {
    // Sold-out and closed events can't be attended, so they're left out.
    if (e.registration === "sold_out" || e.registration === "full" || e.registration === "closed") return false;
    const endMs = e.end ? Date.parse(e.end) : Date.parse(e.start) + ASSUMED_DURATION_MS;
    // A few listings run for weeks afterwards; only those starting by the last day count.
    return endMs >= now && pacificDay(e.start) <= TECH_WEEK_LAST_DAY;
  });
  EVENT_BLOCK = EVENTS.map((e) => EVENT_LINES.get(e.id)).join("\n");
}

const windowTokens = (env) => clampInt(env.CONTEXT_WINDOW_TOKENS, 384_000, 1_000, 10_000_000);

// ---------- GitHub: public profile, repos, and READMEs as plain text ----------

async function github(url, env) {
  const login = (url.searchParams.get("user") || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?github\.com\//i, "").split(/[/?#]/)[0];
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login)) return json({ error: "That doesn't look like a GitHub username." }, 400);

  const headers = { "user-agent": "techweek-ranker", accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const gh = (path) => fetch(`https://api.github.com${path}`, { headers, cf: { cacheTtl: 3600 } });

  const userRes = await gh(`/users/${login}`);
  if (userRes.status === 404) return json({ error: `No GitHub user named ${login}.` }, 404);
  if (!userRes.ok) return json({ error: "GitHub isn't responding right now. Skip it or try again." }, 502);
  const user = await userRes.json();

  const reposRes = await gh(`/users/${login}/repos?sort=pushed&per_page=30&type=owner`);
  const repos = reposRes.ok ? (await reposRes.json()).filter((r) => !r.fork) : [];

  const readmes = await Promise.all(
    repos.slice(0, 8).map(async (r) => {
      const res = await fetch(`https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/README.md`, { cf: { cacheTtl: 3600 } });
      return res.ok ? (await res.text()).slice(0, 12_000) : "";
    }),
  );

  const lines = [
    `GitHub: ${user.login}${user.name ? ` (${user.name})` : ""}`,
    user.bio && `Bio: ${user.bio}`,
    user.company && `Company: ${user.company}`,
    `Public repos: ${user.public_repos}, followers: ${user.followers}`,
    "",
    "Repositories (most recently pushed first):",
    ...repos.map((r) => `- ${r.name}${r.language ? ` [${r.language}]` : ""} ★${r.stargazers_count}${r.description ? `: ${r.description}` : ""}${r.topics?.length ? ` (topics: ${r.topics.join(", ")})` : ""}`),
    ...repos.slice(0, 8).flatMap((r, i) => (readmes[i] ? ["", `README of ${r.name}:`, readmes[i]] : [])),
  ];
  const text = lines.filter((l) => l !== null && l !== undefined && l !== false).join("\n").slice(0, MAX_FIELD_CHARS);
  return json({ login: user.login, repos: repos.length, readmes: readmes.filter(Boolean).length, text });
}

// ---------- Local-only fallback, clearly labeled in the UI ----------

const STOP = new Set("the and for with from that this your you are our was were will have has into about over under their they them what when where which who how all any can not but also more most such than then there these those its it's a an of to in on at by as is be or we i my me".split(" "));

function tokens(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []).filter((w) => !STOP.has(w));
}

function rankWithKeywords(profile, topN) {
  const want = new Set(tokens(`${profile.resume} ${profile.github} ${profile.interests} ${profile.interests}`));
  const scored = EVENTS.map((e) => {
    const hits = [...new Set(tokens(`${e.title} ${e.description || ""} ${(e.tags || []).join(" ")}`))].filter((w) => want.has(w));
    return { e, hits };
  }).sort((a, b) => b.hits.length - a.hits.length);
  const max = Math.max(1, scored[0]?.hits.length || 1);
  return {
    mode: "keyword",
    model: "Keyword baseline",
    summary: "The model isn't connected, so these are ranked by shared keywords only.",
    ranked: scored.slice(0, topN).map(({ e, hits }) => ({
      event: e,
      score: Math.round((hits.length / max) * 100),
      why: hits.length ? `Shared words: ${hits.slice(0, 6).join(", ")}.` : "No overlapping keywords.",
    })),
    stats: { eventsRead: EVENTS.length, promptTokens: null, promptTokensEstimate: null, seconds: 0 },
  };
}

// ---------- helpers ----------

function clean(v) {
  return typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, MAX_FIELD_CHARS) : "";
}

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
