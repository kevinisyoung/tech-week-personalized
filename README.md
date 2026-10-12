# Tech Week, personalized

**Try it: [techweekranker.app](https://techweekranker.app)**

A demo of [Subquadratic](https://subquadratic.ai)'s Snap long-context model. It ranks every upcoming LA Tech Week event for you from your GitHub, a resume or LinkedIn PDF, and a few interests.

Snap reads the whole calendar in one request: every event's description, host, time, and venue (about 200K tokens), plus your profile. No pre-filtering, retrieval, or chunking.

## How it works

`state` holds your profile and every event. The events are split into a few `choice` questions of up to 255 options each, all answered in the same request against the full context. Each listed interest gets its own set of questions, and a day, time, or neighborhood you mention ("Thursday evening") is treated as a requirement.

The ranking is in [`src/worker.js`](src/worker.js); the page is in [`public/`](public/).

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # add your SubQ API key
npm run dev
```

## License

[MIT](LICENSE) for the code. The Subquadratic and Snap names and logos, the Tech Week wordmark, and the event listings aren't covered. Not affiliated with a16z or Tech Week.
