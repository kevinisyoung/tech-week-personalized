# Tech Week, personalized

**Try it: [techweekranker.app](https://techweekranker.app)**

A demo of [Subquadratic](https://subquadratic.ai)'s Snap long-context decision model. It ranks every upcoming LA Tech Week event for one person from their GitHub, a resume or LinkedIn PDF, and a few interests.

Snap gets the whole event list in a single request: every description, host, time, and venue (about 200K tokens), plus the visitor's profile. There's no pre-filtering, retrieval, or chunking step. The page shows the context filling up, then the one request's token count and time.

Runs on Cloudflare Workers with static assets. No framework and no build step.

## How it works

1. **Tell us about yourself.** A GitHub username, a resume or LinkedIn PDF (read in the browser with pdf.js), and interests. Files stay in the browser until the request is sent.
2. **Build your context.** `/api/github` fetches the public profile, repos, and READMEs. The page totals the calendar and the profile against the context window.
3. **One-shot run.** `POST /api/rank` sends one request to the SubQ decisions API (`POST /v1/systemone`):
   - `state` holds the profile and every event, one line each: `[id] title | when | host | where | description`.
   - The events are split into a few `choice` questions of up to 255 options each, all in the same request. With several comma-separated interests, each interest gets its own set of questions.
   - Each event's score is its probability × the number of options in its question (1 = an even split), so events from different questions are comparable. Duplicate listings are merged, and each listed interest leads with its top event.
   - If an interest names a day, time of day, or neighborhood ("Thursday evening", "Santa Monica"), it's added to every question as a requirement.

The code is in [`src/worker.js`](src/worker.js) (API and ranking) and [`public/app.js`](public/app.js) (the page).

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in SUBQ_API_KEY
npm run dev
```

To try the UI without a SubQ key, set `MOCK_RANKER=1` in `.dev.vars` and leave the `SUBQ_*` values empty. Events are then ranked by shared keywords, and the results page says so.

### Event data

`src/events.json` is built from Tech Week's public MCP server (`https://www.tech-week.com/api/mcp`):

```bash
npm run fetch-details -- --city la
```

It lists every event in the city, fetches each one's full details, and caches the responses in `data/details/` so re-runs only fetch what's missing. The MCP rate-limits bursts, so a full fetch of ~800 events takes about 20 minutes. Set `CITY_LABEL` and `TECH_WEEK_LAST_DAY` in `wrangler.jsonc` to match the city.

Only events that haven't ended are ranked, through `TECH_WEEK_LAST_DAY`. Sold-out, full, and closed events are left out.

## Deploy

```bash
npx wrangler secret put SUBQ_BASE_URL
npx wrangler secret put SUBQ_API_KEY
npx wrangler secret put SUBQ_MODEL
npx wrangler secret put GITHUB_TOKEN   # optional; unauthenticated GitHub allows 60 requests/hour shared by all visitors
npm run deploy
```

To pause ranking (for example, to stop spending on SubQ requests), set `RANKING_DISABLED` to `"1"` in `wrangler.jsonc` and deploy.

## Notes

- `/api/rank` is limited to 4 requests per minute per IP (`ratelimits` in `wrangler.jsonc`).
- Resumes are never stored or logged. On model errors the Worker logs the status code only.
- The visitor's profile is capped at ~27K tokens so it can't crowd the events out of the window.

## UI tests

The Playwright suite runs Chromium and WebKit on desktop and emulated phones. It intercepts `/api/events`, `/api/github`, and `/api/rank`, so it never calls SubQ or GitHub. Coverage includes keyboard navigation, uploads (including a real PDF), cancellation, retries, timeouts, day filters, layouts from 320–1920 px, and automated accessibility checks in light and dark mode.

```bash
npx playwright install chromium webkit
npm run dev                         # in another terminal
BASE_URL=http://localhost:8787 npm run test:ux
```

## License

The code is [MIT licensed](LICENSE). The Subquadratic and Snap names and logos, the Tech Week wordmark, and the event listings in `src/events.json` aren't covered by that license.

## Credits

Not affiliated with a16z or Tech Week. Event listings come from Tech Week's public MCP server and belong to their hosts. The Inter Tight and JetBrains Mono fonts are served from `public/fonts/` under the SIL Open Font License (included there).
