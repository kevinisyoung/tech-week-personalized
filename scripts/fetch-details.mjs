#!/usr/bin/env node
// Build src/events.json with full details for every event in one Tech Week city.
//
//   npm run fetch-details -- --city la                 list, fetch, and build
//   npm run fetch-details -- --city la --build-only    rebuild from the cache without fetching
//
// Events are listed with the MCP's search_events, day by day. Details come from Tech Week's official MCP server (https://www.tech-week.com/api/mcp, tool `get_event`),
// which returns the host's full description, themes, formats, venue, and times.
// Responses are cached in data/details/, so re-runs only fetch what's missing.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MCP_URL = "https://www.tech-week.com/api/mcp";
// The MCP allows a short burst (~240 requests) and then rate limits, so pace requests steadily.
const CONCURRENCY = 1;
const SPACING_MS = 1500;
const DATA = "data";
const CACHE = join(DATA, "details");
mkdirSync(CACHE, { recursive: true });

// ---------- the event list ----------
const cityArg = process.argv.indexOf("--city");
const CITY = cityArg > 0 ? process.argv[cityArg + 1] : null;
if (!CITY) {
  console.error("Usage: npm run fetch-details -- --city <slug>   (e.g. la, sf, nyc)");
  process.exit(1);
}
const listed = new Map();
let rpcSeq = 1000;
async function mcp(name, args) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "techweek-ranker (event import)" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 20) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 4) * 1000 + 500));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const json = JSON.parse(text.trim().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:")).slice(5));
    return json?.result?.structuredContent;
  }
}
// List every event in the city, day by day.
{
  const cities = (await mcp("list_cities", {}))?.cities || [];
  const city = cities.find((c) => c.slug === CITY);
  if (!city) {
    console.error(`Unknown city "${CITY}". Known: ${cities.map((c) => c.slug).join(", ")}`);
    process.exit(1);
  }
  for (const date of city.days) {
    for (let page = 1; ; page++) {
      const r = await mcp("search_events", { city: [CITY], date, limit: 75, page });
      for (const e of r?.events || []) listed.set(e.id, e);
      if (!r?.hasMore) break;
    }
  }
  console.log(`${listed.size} ${city.name} events listed (${city.dateRange}).`);
}
if (!listed.size) {
  console.error("No events found.");
  process.exit(1);
}

// ---------- fetch details ----------
const ids = [...listed.keys()];
// --build-only: skip fetching and build from whatever is cached (safe while another run is fetching).
const buildOnly = process.argv.includes("--build-only");
const todo = buildOnly ? [] : ids.filter((id) => !existsSync(join(CACHE, `${id}.json`)));
console.log(`${ids.length - todo.length} cached, ${todo.length} to fetch.`);

let done = 0;
let failed = 0;
let rpcId = 1;
async function worker() {
  while (todo.length) {
    const id = todo.shift();
    try {
      const event = await getEvent(id);
      writeFileSync(join(CACHE, `${id}.json`), JSON.stringify(event));
    } catch (err) {
      failed++;
      console.error(`  ${id}: ${err.message}`);
    }
    if (++done % 50 === 0) console.log(`  ${done}/${done + todo.length}`);
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

async function getEvent(id, attempt = 0) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "techweek-ranker (event import)",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: "get_event", arguments: { eventId: id } } }),
    signal: AbortSignal.timeout(30_000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 20) {
    const wait = (Number(res.headers.get("retry-after")) || 2 * 2 ** Math.min(attempt, 5)) * 1000 + 500;
    await new Promise((r) => setTimeout(r, wait));
    return getEvent(id, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // Accept a plain JSON body or a single SSE `data:` frame.
  const json = JSON.parse(text.trim().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:")).slice(5));
  const event = json?.result?.structuredContent?.event;
  // Tech Week no longer knows this event (removed or unlisted since it was listed).
  if (!event && !json?.error) return { removed: true };
  if (!event) throw new Error(json?.error?.message || "no event in response");
  return event;
}

// ---------- build src/events.json ----------
const events = [];
let withFull = 0;
for (const id of ids) {
  const path = join(CACHE, `${id}.json`);
  const d = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (d?.removed) continue;
  const l = listed.get(id);
  // Search results share get_event's shape (without the full description), so they can stand in.
  const m = d || (l.startsAt ? l : null);
  const description = (d?.description || l.excerpt || "").trim();
  if (d) withFull++;
  events.push({
    id,
    title: m?.name || l.name,
    start: m?.startsAt || `${l.date}T${l.time}:00-07:00`,
    end: m?.endsAt || (l.endDate && l.endTime ? `${l.endDate}T${l.endTime}:00-07:00` : undefined),
    host: (m?.hosts?.length ? m.hosts : [l.company]).filter(Boolean).join(", ") || undefined,
    neighborhood: m?.neighborhoods?.join(", ") || l.location || undefined,
    location: m?.venue || undefined,
    tags: [...(m?.themes || []), ...(m?.formats || [])],
    registration: m?.registration || l.registrationStatus,
    description: description || undefined,
    // true when the description is the host's full text from get_event, not the calendar teaser
    fullDetails: Boolean(d),
    url: (m?.eventUrl || "").replace(/[?&]src=mcp$/, "") || (l.externalHref ? `https://www.tech-week.com${l.externalHref}` : undefined),
  });
}
events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
// Short stable ids keep the decisions request compact; the Tech Week id stays on the event page URL.
events.forEach((e, i) => (e.id = `e${i + 1}`));

writeFileSync("src/events.json", JSON.stringify(events) + "\n");
const chars = events.reduce((n, e) => n + JSON.stringify(e).length, 0);
console.log(
  `Wrote ${events.length} events to src/events.json: ${withFull} with full descriptions` +
    `${failed ? `, ${failed} failed (re-run to retry)` : ""}. ≈${Math.round(chars / 4).toLocaleString()} tokens.`,
);
