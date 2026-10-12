const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FIELD_CHARS = 120_000;
let WINDOW_TOKENS = 384_000;
const OTHERS_TOKENS = 32_000;
const TZ = "America/Los_Angeles";
const $ = (id) => document.getElementById(id);
const state = { files: [], meta: null, payload: null, estimate: 0, result: null, day: "all", loading: false, parsing: null, running: null };

init();

function init() {
  // Bind controls before the first network response, including when it fails.
  $("files").addEventListener("change", (e) => addFiles(e.target.files));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (e) => {
    e.preventDefault();
    if (!state.running) drop.classList.add("over");
  }));
  drop.addEventListener("dragleave", (e) => {
    if (!drop.contains(e.relatedTarget)) drop.classList.remove("over");
  });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    addFiles(e.dataTransfer.files);
  });
  // Dropping a document outside the target must not navigate away from the form.
  ["dragover", "drop"].forEach((type) => document.addEventListener(type, (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault();
  }));
  ["github", "interests"].forEach((id) => $(id).addEventListener("input", (e) => {
    if (e.target.tagName === "TEXTAREA") autogrow(e.target);
    e.target.removeAttribute("aria-invalid");
    hideError("form-error");
    resetLaterSteps();
  }));
  // Safari doesn't move keyboard focus on a same-page link, so the skip link does it explicitly.
  document.querySelector(".skip-link").addEventListener("click", (e) => {
    e.preventDefault();
    focusAndReveal($("step-1-title"));
  });
  $("profile").addEventListener("submit", parse);
  $("run").addEventListener("click", run);
  $("cancel-run").addEventListener("click", () => state.running?.abort());
  $("retry-events").addEventListener("click", loadEvents);
  $("refresh-events").addEventListener("click", loadEvents);
  const resizeFields = () => ["interests"].forEach((id) => autogrow($(id)));
  window.addEventListener("resize", resizeFields);
  document.fonts.ready.then(resizeFields);
  resizeFields();
  loadEvents();
}

async function loadEvents() {
  if (state.loading) return;
  const restoreFocus = ["retry-events", "refresh-events"].includes(document.activeElement?.id);
  state.loading = true;
  state.meta = null;
  $("events-status").hidden = false;
  $("events-error").hidden = true;
  $("refresh-events").disabled = true;
  updateControls();
  try {
    const meta = await requestJSON("/api/events", { timeout: 20_000, cache: "no-cache" });
    if (!Number.isInteger(meta.count) || meta.count < 0 || !Number.isFinite(meta.eventTokens) || meta.eventTokens < 0) {
      throw new Error("The event list couldn't be read. Try loading it again.");
    }
    state.meta = { ...meta, model: meta.model || "Snap" };
    if (Number.isFinite(meta.windowTokens)) WINDOW_TOKENS = meta.windowTokens;
    // "Learn about Snap" under the top picks, only when a destination is configured.
    if (meta.ctaUrl) $("snap-cta-link").href = meta.ctaUrl;
    $("snap-cta").hidden = !meta.ctaUrl;
    document.querySelectorAll(".model-name").forEach((n) => (n.textContent = state.meta.model));
    document.querySelector(".steps").hidden = !meta.count;
    document.querySelector(".skip-link").hidden = !meta.count;
    $("empty").hidden = !!meta.count;
    announce(meta.count ? "Events loaded. Add a profile source to get started." : "The event list isn't loaded yet.");
    if (restoreFocus) focusAndReveal(meta.count ? $("step-1-title") : $("empty-title"));
  } catch (err) {
    $("empty").hidden = true;
    $("events-error").hidden = false;
    $("events-error-message").textContent = `Couldn't load events. ${err.message}`;
    if (restoreFocus) focusAndReveal($("retry-events"));
  } finally {
    state.loading = false;
    $("events-status").hidden = true;
    $("refresh-events").disabled = false;
    updateControls();
    // On a fresh page load, put the cursor straight in the GitHub field.
    if (!restoreFocus && state.meta?.count && document.activeElement === document.body) $("github").focus({ preventScroll: true });
  }
}

// ---------- Collect documents ----------

async function addFiles(list) {
  if (state.running) return;
  const incoming = Array.from(list);
  $("files").value = "";
  if (!incoming.length) return;
  resetLaterSteps();
  hideError("upload-error");
  hideError("form-error");
  const errors = [];
  const entries = [];
  for (const file of incoming) {
    if (!/\.(pdf|txt|md)$/i.test(file.name)) { errors.push(`${file.name}: choose a PDF, TXT, or MD file.`); continue; }
    if (file.size > MAX_FILE_BYTES) { errors.push(`${file.name} is over 10 MB. Choose a smaller file.`); continue; }
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (state.files.some((f) => f.key === key)) continue;
    const entry = { key, name: file.name, text: "", status: "Reading…", reading: true, failed: false };
    state.files.push(entry);
    entries.push({ file, entry });
  }
  if (errors.length) showError("upload-error", errors.join(" "));
  renderFiles();
  updateControls();
  await Promise.all(entries.map(async ({ file, entry }) => {
    try {
      entry.text = (file.name.toLowerCase().endsWith(".pdf") ? await pdfText(file) : await file.text()).replace(/\u0000/g, "").trim();
      if (!entry.text) throw new Error("No readable text. Try a text-based PDF or paste your profile.");
      if (entry.text.length > MAX_FIELD_CHARS) throw new Error("Too much text. Choose a shorter document (under 120,000 characters).");
      entry.status = `${words(entry.text)} words`;
    } catch (err) {
      entry.text = "";
      entry.failed = true;
      entry.status = /No readable text|Too much text/.test(err.message) ? err.message : "Couldn't read this file. Try an unlocked PDF, TXT, or MD file.";
    } finally {
      entry.reading = false;
      if (state.files.includes(entry)) {
        renderFiles();
        announce(`${entry.name}: ${entry.status}`);
      }
      updateControls();
    }
  }));
}

async function pdfText(file) {
  let timer;
  let task;
  let timedOut = false;
  try {
    return await Promise.race([
      (async () => {
        const pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
        if (timedOut) throw new Error("PDF timed out");
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
        task = pdfjs.getDocument({ data: await file.arrayBuffer() });
        const doc = await task.promise;
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const content = await (await doc.getPage(i)).getTextContent();
          pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join(""));
        }
        return pages.join("\n\n");
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error("PDF timed out")); }, 30_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    await task?.destroy();
  }
}

function renderFiles() {
  const ul = $("file-list");
  const focusedKey = document.activeElement?.dataset.fileKey;
  ul.hidden = !state.files.length;
  // Once a file is in, it takes the uploader's place; removing it brings the uploader back.
  $("drop").hidden = state.files.length > 0;
  ul.replaceChildren(...state.files.map((f) => {
    const li = el("li", "file");
    li.dataset.state = f.failed ? "error" : f.reading ? "reading" : "done";
    const name = el("span", "file-name", f.name);
    name.title = f.name;
    li.append(name, el("span", "file-status", f.status));
    const rm = el("button", "file-remove", "Remove");
    rm.type = "button";
    rm.dataset.fileKey = f.key;
    rm.setAttribute("aria-label", `Remove ${f.name}`);
    rm.addEventListener("click", () => {
      const index = state.files.indexOf(f);
      state.files.splice(index, 1);
      renderFiles();
      resetLaterSteps();
      updateControls();
      const buttons = ul.querySelectorAll("button");
      (buttons[Math.min(index, buttons.length - 1)] || $("files")).focus({ preventScroll: true });
      announce(`${f.name} removed.`);
    });
    li.append(rm);
    return li;
  }));
  if (focusedKey) Array.from(ul.querySelectorAll("button")).find((b) => b.dataset.fileKey === focusedKey)?.focus({ preventScroll: true });
}

// ---------- Prepare the full context ----------

async function parse(e) {
  e.preventDefault();
  if (state.running || state.parsing || state.loading) return;
  hideError("form-error");
  if (!state.meta?.count) return showError("form-error", "Load the event list before continuing.", true);
  if (state.files.some((f) => f.reading)) return showError("form-error", "Your files are still being read. Try again when they're ready.", true);
  const rawGithub = $("github").value.trim();
  const github = rawGithub.replace(/^@/, "").replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").split(/[/?#]/)[0];
  const interests = $("interests").value.trim();
  const readable = state.files.filter((f) => f.text);
  if (!readable.length && !rawGithub && !interests) return showError("form-error", "Add at least one: GitHub, a resume or LinkedIn PDF, or interests.", true);
  if (rawGithub && !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(github)) {
    $("github").setAttribute("aria-invalid", "true");
    showError("form-error", "Enter a GitHub username or profile URL.");
    return $("github").focus();
  }
  const payload = { resume: readable.map((f) => `# ${f.name}\n${f.text}`).join("\n\n"), github: "", interests };
  for (const [key, value] of Object.entries(payload)) {
    if (value.length > MAX_FIELD_CHARS) return showError("form-error", `Your ${key === "resume" ? "combined documents contain" : `${key} field contains`} too much text. Keep each source under 120,000 characters.`, true);
  }
  resetLaterSteps();
  const controller = new AbortController();
  state.parsing = controller;
  setStep(1, "done");
  setStep(2, "running");
  document.body.classList.add("building"); // extra room below so step 2 can scroll to the top
  updateControls();
  showStep2();
  try {
    if (github) {
      try {
        const data = await requestJSON(`/api/github?user=${encodeURIComponent(github)}`, { signal: controller.signal, timeout: 25_000 });
        if (typeof data.text !== "string" || !data.text.trim()) throw new Error("No readable profile was returned.");
        payload.github = data.text;
      } catch (err) {
        if (controller.signal.aborted) return;
        announce(`GitHub skipped. ${err.message}`);
      }
    }
    if (controller.signal.aborted) return;
    if (!Object.values(payload).some(Boolean)) throw new Error("We couldn't read your GitHub profile. Try again or add another source.");
    const tok = (text) => Math.round((text || "").length / CHARS_PER_TOKEN);
    // Two slams: the calendar lands like a wave, then everything about you in one.
    const pieces = [
      payload.github && "GitHub",
      payload.resume && (readable.length > 1 ? `${readable.length} documents` : "resume"),
      payload.interests && "interests",
    ].filter(Boolean);
    const parts = [
      { label: "Full calendar", detail: `${state.meta.count.toLocaleString()} events · every description, host, time, and venue`, tokens: state.meta.eventTokens, kind: "calendar" },
      { label: "Your profile", detail: listJoin(pieces), tokens: tok(payload.github) + tok(payload.resume) + tok(payload.interests), kind: "github" },
    ].filter((p) => p.tokens > 0);
    const total = parts.reduce((sum, p) => sum + p.tokens, 0);
    await animateIngest(parts, total, controller.signal);
    if (controller.signal.aborted) return;
    if (total > WINDOW_TOKENS) throw new Error(`This context is over the ${formatTokens(WINDOW_TOKENS)}-token window. Shorten your profile or remove a document, then try again.`);
    state.payload = payload;
    state.estimate = total;
    $("run").textContent = `Run ${state.meta.model} on ≈${formatTokens(total)} tokens`;
    renderRunCaption(total);
    $("continue").hidden = true;
    announce("Your context is ready. Running Snap.");
    // Hand-off to step 3, after this handler's cleanup runs: scroll down, tick step 2, then run.
    setTimeout(advanceToRun, 0);
  } catch (err) {
    if (controller.signal.aborted) return;
    setStep(1, "active");
    setStep(2, "error");
    showError("form-error", err.message, true);
  } finally {
    if (state.parsing === controller) {
      state.parsing = null;
      updateControls();
    }
  }
}

// ---------- Step 2: the context filling up, piece by piece ----------

const CHARS_PER_TOKEN = 4.15; // measured on subq-snap-preview

async function animateIngest(parts, total, signal) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const pct = (t) => `${Math.min(100, (t / WINDOW_TOKENS) * 100)}%`;
  $("ingest").hidden = false;
  // Now that step 2 has its full height, bring its top to the top of the screen.
  showStep2(false);
  $("ingest-feed").replaceChildren();
  $("ingest-bar").replaceChildren();
  $("ingest-tokens").textContent = "0";
  $("ingest-window").textContent = formatTokens(WINDOW_TOKENS);
  $("ingest-mark").style.left = pct(OTHERS_TOKENS);
  let running = 0;
  for (const part of parts) {
    if (signal.aborted) return;
    const seg = el("span", `ingest-seg kind-${part.kind}`);
    seg.style.width = "0%";
    $("ingest-bar").append(seg);
    const from = running;
    running += part.tokens;
    if (!reduce) await slamIntoBar(part, from);
    // Impact: the row lands, the segment and counter jump, the bar thuds.
    const li = el("li", `ingest-row kind-${part.kind}`);
    const amount = el("span", "ingest-amount", `+${formatTokens(part.tokens)}`);
    const label = el("span", "ingest-label");
    label.append(el("strong", "", part.label), part.detail ? ` · ${part.detail}` : "");
    li.append(amount, label);
    $("ingest-feed").append(li);
    $("ingest-bar").classList.remove("thud");
    void $("ingest-bar").offsetWidth;
    $("ingest-bar").classList.add("thud");
    await countUp(reduce ? 0 : 260, (k) => {
      const now = Math.round(from + part.tokens * k);
      $("ingest-tokens").textContent = now.toLocaleString();
      seg.style.width = pct(part.tokens * k);
    });
    await wait(90);
  }
  $("ingest-tokens").textContent = total.toLocaleString();
}

// A big category chip pops up in the empty part of the bar, then slams sideways into the filled end.
function slamIntoBar(part, atTokens) {
  const bar = $("ingest-bar").getBoundingClientRect();
  const chip = el("span", `ingest-slam kind-${part.kind}`);
  chip.append(el("span", "slam-amount", `+${formatTokens(part.tokens)}`), el("span", "slam-label", part.label));
  document.body.append(chip);
  const w = chip.offsetWidth, h = chip.offsetHeight;
  // Page coordinates, so the chip stays on the bar even if the page is still scrolling.
  const sx = window.scrollX, sy = window.scrollY;
  const fillEnd = sx + bar.left + (Math.min(atTokens, WINDOW_TOKENS) / WINDOW_TOKENS) * bar.width;
  const x0 = Math.max(sx + bar.left, Math.min(sx + bar.right - w, Math.max(fillEnd + 24, sx + bar.left + (bar.width - w) * 0.62)));
  const y = sy + bar.top + bar.height / 2 - h / 2;
  const x1 = fillEnd - w * 0.15;
  const anim = chip.animate(
    [
      { transform: `translate(${x0}px, ${y}px) scale(.3)`, opacity: 0, easing: "cubic-bezier(.2, 1.6, .4, 1)" },
      { transform: `translate(${x0}px, ${y}px) scale(1)`, opacity: 1, offset: 0.3 },
      { transform: `translate(${x0 + 10}px, ${y}px) scale(1)`, opacity: 1, offset: 0.55, easing: "cubic-bezier(.6, 0, .9, .4)" },
      { transform: `translate(${x1}px, ${y}px) scale(.55, .8)`, opacity: 1, offset: 0.9 },
      { transform: `translate(${x1}px, ${y}px) scale(.2, .5)`, opacity: 0 },
    ],
    { duration: 560, fill: "forwards" },
  );
  return anim.finished.catch(() => {}).then(() => chip.remove());
}

function countUp(ms, frame) {
  return new Promise((resolve) => {
    if (!ms) { frame(1); return resolve(); }
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / ms);
      frame(1 - Math.pow(1 - p, 3));
      p < 1 ? requestAnimationFrame(step) : resolve();
    };
    requestAnimationFrame(step);
  });
}

// How the one-shot request compares with a 32K-context model, which needs the context split up.
function renderRunCaption(total) {
  const pieces = Math.ceil(total / 32_000);
  $("run-caption").textContent = `One request. A 32K-context model would need ${pieces}.`;
  $("run-caption").hidden = false;
}

function listJoin(items) {
  return items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// ---------- Step 3: one Snap request ----------

async function run() {
  if (state.running || state.parsing || !state.payload) return;
  const controller = new AbortController();
  state.running = controller;
  updateControls();
  hideError("run-error");
  $("run").hidden = true;
  $("readout").hidden = false;
  $("readout").dataset.state = "running";
  $("results").hidden = true;
  $("run-progress").hidden = false;
  $("run-status").textContent = "Reading your context and ranking events. This may take a few minutes.";
  announce("Ranking started. Reading your context and ranking events.");
  setStep(3, "running");
  focusAndReveal($("step-3-title"));
  $("big-tokens").textContent = `≈${state.estimate.toLocaleString()}`;
  $("big-tokens-label").textContent = "estimated prompt tokens";
  $("big-time").textContent = "0.0s";
  $("big-time-label").textContent = "elapsed";
  const started = performance.now();
  const timer = setInterval(() => ($("big-time").textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`), 100);
  try {
    const data = await requestJSON("/api/rank", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.payload),
      signal: controller.signal, timeout: 180_000,
    });
    if (!Array.isArray(data.ranked)) throw new Error("The ranking response couldn't be read. Try again.");
    data.ranked = data.ranked.filter((r) => r?.event && typeof r.event.title === "string" && Number.isFinite(r.score))
      .map((r) => ({ ...r, score: Math.max(0, Math.min(100, Math.round(r.score))) }));
    if (!data.ranked.length) throw new Error("No event picks came back. Try again, or add more detail to your profile.");
    const seconds = Math.max(0.1, (performance.now() - started) / 1000);
    const exact = Number.isFinite(data.stats?.promptTokens) && data.stats.promptTokens >= 0 ? data.stats.promptTokens : null;
    const estimate = Number.isFinite(data.stats?.promptTokensEstimate) && data.stats.promptTokensEstimate >= 0 ? data.stats.promptTokensEstimate : state.estimate;
    const tokens = exact ?? estimate;
    $("big-tokens").textContent = `${exact === null ? "≈" : ""}${tokens.toLocaleString()}`;
    $("big-tokens-label").textContent = exact === null ? "estimated tokens in one request" : "tokens in one request";
    $("big-time").textContent = `${seconds.toFixed(1)}s`;
    $("big-time-label").textContent = data.mode === "model" ? `${exact === null ? "≈" : ""}${Math.round(tokens / seconds).toLocaleString()} tokens/s · end to end` : "keyword baseline, no model";
    $("readout").dataset.state = "done";
    setStep(3, "done");
    state.result = data;
    state.result.seconds = seconds;
    state.result.tokens = tokens;
    state.day = "all";
    renderResults();
    // Let the final time sit on screen for a beat, then open the results page.
    setTimeout(() => { if (state.result === data) showResultsView(); }, 1100);
  } catch (err) {
    document.body.classList.remove("snap-focus");
    $("readout").dataset.state = "error";
    $("big-time-label").textContent = controller.signal.aborted ? "stopped" : "elapsed before error";
    setStep(3, "active");
    $("run").hidden = false;
    $("run").textContent = `Try ${state.meta.model} again`;
    showError("run-error", controller.signal.aborted ? "Stopped waiting. You can edit your profile or try again." : err.message);
    focusAndReveal($("run"));
  } finally {
    clearInterval(timer);
    $("run-progress").hidden = true;
    state.running = null;
    updateControls();
  }
}

function renderResults() {
  const { ranked, summary } = state.result;
  $("summary").textContent = summary || "";
  $("summary").hidden = !summary;
  $("results-speed").textContent =
    `${formatTokens(state.result.tokens)} tokens · ${(state.result.stats?.eventsRead ?? state.meta.count).toLocaleString()} events · ${state.result.seconds.toFixed(1)}s`;

  // The top three across every remaining day, then the rest with day filters.
  $("top-list").replaceChildren(...ranked.slice(0, 3).map((r, i) => renderRow({ ...r, rank: i + 1 }, "top")));
  const rest = ranked.slice(3);
  $("more").hidden = !rest.length;
  const days = [...new Set(rest.map((r) => dayKey(r.event.start)))].sort((a, b) => a === "unknown" ? 1 : b === "unknown" ? -1 : a.localeCompare(b));
  $("days").hidden = days.length < 2;
  $("days").replaceChildren(...[["all", "All upcoming days"], ...days.map((day) => [day, dayLabel(day)])].map(([key, label]) => {
    const button = el("button", "chip", label);
    button.type = "button";
    button.dataset.day = key;
    button.setAttribute("aria-controls", "list");
    button.addEventListener("click", () => {
      state.day = key;
      renderRows(); // Keep the actual filter buttons, focus, and horizontal scroll position.
    });
    return button;
  }));
  renderRows();
}

function renderRows() {
  const rest = state.result.ranked.map((r, i) => ({ ...r, rank: i + 1 })).slice(3);
  $("days").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.day === state.day)));
  const rows = rest.filter((r) => state.day === "all" || dayKey(r.event.start) === state.day);
  $("list").replaceChildren(...rows.map((r) => renderRow(r)));
  $("results-count").textContent = `${rows.length} events${state.day === "all" ? "" : ` · ${dayLabel(state.day)}`} · Times in Pacific Time`;
}

function renderRow({ event: ev, score, why, rank }, variant) {
  const li = el("li", variant === "top" ? "item item-top" : "item");
  li.value = rank;
  const url = safeURL(ev.url);
  const link = el(url ? "a" : "div", "item-link");
  if (url) { link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.tabIndex = 0; }
  const head = el("div", "item-head");
  const rankLabel = el("span", "rank", String(rank).padStart(2, "0"));
  rankLabel.setAttribute("aria-hidden", "true");
  const scoreLabel = el("span", "score-num", String(score));
  scoreLabel.append(el("span", "score-caption", "match"));
  scoreLabel.setAttribute("aria-label", `Match: ${score} out of 100`);
  head.append(rankLabel, el("h3", "item-title", ev.title), scoreLabel);
  const meta = el("p", "item-meta", [formatWhen(ev.start, ev.end), ev.neighborhood || ev.location, ev.host].filter(Boolean).join(" · "));
  const bar = el("div", "score");
  bar.setAttribute("aria-hidden", "true");
  const fill = el("span", "score-fill");
  fill.style.width = `${score}%`;
  bar.append(fill);
  link.append(head, meta);
  if (why) link.append(el("p", "why", why));
  link.append(bar);
  if (url) link.append(el("span", "sr-only", "Opens event page in a new tab."));
  li.append(link);
  return li;
}

// ---------- Interest ideas: one tap adds (or removes) a phrase ----------

const INTEREST_IDEAS = ["AI evals", "Meeting seed investors", "Hiring engineers", "Free food", "Something chill, not networking-heavy", "Robotics and hardware", "Women founders"];
(function renderInterestIdeas() {
  const box = $("interest-ideas");
  const input = $("interests");
  const parts = () => input.value.split(",").map((p) => p.trim()).filter(Boolean);
  const sync = () => box.querySelectorAll("button").forEach((b) => {
    const on = parts().some((p) => p.toLowerCase() === b.dataset.idea.toLowerCase());
    b.setAttribute("aria-pressed", String(on));
    b.textContent = `${on ? "✓" : "+"} ${b.dataset.idea}`;
  });
  box.replaceChildren(...INTEREST_IDEAS.map((idea) => {
    const b = el("button", "idea", `+ ${idea}`);
    b.type = "button";
    b.dataset.idea = idea;
    b.addEventListener("click", () => {
      const current = parts();
      const i = current.findIndex((p) => p.toLowerCase() === idea.toLowerCase());
      if (i >= 0) current.splice(i, 1);
      else current.push(idea);
      input.value = current.join(", ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return b;
  }));
  input.addEventListener("input", sync);
  sync();
})();

// ---------- Results view: its own page (with history), plus a little celebration ----------

function showResultsView({ push = true, celebrate = true } = {}) {
  $("results").hidden = false;
  document.body.classList.remove("snap-focus", "building");
  document.body.classList.add("view-results");
  window.scrollTo({ top: 0, behavior: "instant" });
  if (push && location.hash !== "#results") history.pushState({ view: "results" }, "", "#results");
  $("results-title").focus({ preventScroll: true });
  announce("Your event picks are ready.");
  if (celebrate) throwConfetti();
}

function showFormView() {
  document.body.classList.remove("view-results");
  focusAndReveal($("step-3-title"));
}

$("back").addEventListener("click", () => {
  if (history.state?.view === "results") history.back();
  else showFormView();
});
window.addEventListener("popstate", () => {
  if (location.hash === "#results" && state.result) showResultsView({ push: false, celebrate: false });
  else showFormView();
});
// A reload on #results has nothing to show yet.
if (location.hash === "#results") history.replaceState(null, "", location.pathname + location.search);

function throwConfetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("confetti");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  const colors = ["#1a2f9e", "#2f68ff", "#8fa6ff", "#c7d2fb", "#ffffff", "#ffc857"];
  const pieces = Array.from({ length: Math.min(180, Math.round(w / 6)) }, (_, i) => {
    const fromLeft = i % 2 === 0;
    const angle = (fromLeft ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
    const speed = 9 + Math.random() * 9;
    return {
      x: fromLeft ? -10 : w + 10, y: h * 0.75,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 6, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length], flip: Math.random() * Math.PI,
    };
  });
  const start = performance.now();
  canvas.style.display = "block";
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 2000) / 800);
    for (const p of pieces) {
      p.vy += 0.32; p.vx *= 0.99; p.vy *= 0.99;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.flip += 0.12;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.flip));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < 2800) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, w, h); canvas.style.display = "none"; }
  };
  requestAnimationFrame(frame);
}

// ---------- State and helpers ----------

function updateControls() {
  $("profile-fields").disabled = !!state.running;
  $("profile").setAttribute("aria-busy", String(!!state.parsing));
  $("continue").disabled = state.loading || !state.meta?.count || !!state.parsing || state.files.some((f) => f.reading);
  $("continue").textContent = state.parsing ? "Building…" : state.files.some((f) => f.reading) ? "Reading files…" : "Build my context";
}

function setStep(n, value) {
  const step = $(`step-${n}`);
  step.dataset.state = value;
  step.setAttribute("aria-busy", String(value === "running"));
  if (value === "active" || value === "running") step.setAttribute("aria-current", "step");
  else step.removeAttribute("aria-current");
}

function resetLaterSteps() {
  document.body.classList.remove("snap-focus", "building");
  if (state.running) return;
  state.parsing?.abort();
  state.parsing = null;
  state.payload = null;
  state.result = null;
  setStep(1, "active");
  setStep(2, "upcoming");
  setStep(3, "upcoming");
  for (const id of ["ingest", "run-caption", "run", "readout", "results", "run-progress"]) $(id).hidden = true;
  $("continue").hidden = false;
  hideError("run-error");
  updateControls();
}

async function requestJSON(url, { timeout = 20_000, signal, ...options } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || (response.status === 429 ? "Too many requests. Wait a minute, then try again." : "The service couldn't complete the request. Please try again."));
    if (!data || typeof data !== "object") throw new Error("The service returned an unreadable response. Please try again.");
    return data;
  } catch (err) {
    if (timedOut) throw new Error("This is taking longer than expected. Please try again.");
    if (signal?.aborted) throw err;
    if (err instanceof TypeError) throw new Error("Couldn't connect. Check your connection and try again.");
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (tag === "button") node.tabIndex = 0;
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function autogrow(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, 240)}px`;
}
// Scroll so step 3 is in view (with the end of step 2 still showing above it), mark step 2
// complete, then start Snap.
async function advanceToRun() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pause = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const bar = document.querySelector(".topbar")?.getBoundingClientRect().height || 0;
  const step3 = $("step-3").getBoundingClientRect();
  const top = step3.top + window.scrollY - Math.max(bar + 16, window.innerHeight * 0.35);
  window.scrollTo({ top, behavior: reduce ? "instant" : "smooth" });
  await pause(550);
  setStep(2, "done");
  await pause(400);
  setStep(3, "active");
  document.body.classList.add("snap-focus"); // dim everything but the Snap step while it runs
  run();
}

// Bring step 2's top to the top of the screen (it grows as the context fills in).
function showStep2(focusTitle = true) {
  if (focusTitle) $("step-2-title").focus({ preventScroll: true });
  const bar = document.querySelector(".topbar")?.getBoundingClientRect().height || 0;
  const top = $("step-2").getBoundingClientRect().top + window.scrollY - bar - 16;
  window.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
}

function focusAndReveal(node) {
  node.focus({ preventScroll: true });
  const box = node.getBoundingClientRect();
  if (box.top < 24 || box.bottom > window.innerHeight - 24) {
    node.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  }
}
function announce(message) { $("announcement").textContent = message; }
function safeURL(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ""; } catch { return ""; }
}
function dayKey(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "unknown";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
function dayLabel(key) {
  return key === "unknown" ? "Date TBA" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${key}T12:00:00Z`));
}
function formatWhen(start, end) {
  if (dayKey(start) === "unknown") return "Date and time to be announced";
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const from = new Date(start);
  const to = new Date(end);
  const label = `${day.format(from)}, ${time.format(from)}`;
  if (dayKey(end) === "unknown" || to < from) return label;
  return `${label}–${dayKey(start) !== dayKey(end) ? `${day.format(to)}, ` : ""}${time.format(to)}`;
}
function formatTokens(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n); }
function words(text) { return (text.match(/\S+/g) || []).length.toLocaleString(); }
function showError(id, message, focus = false) {
  $(id).textContent = message;
  $(id).hidden = false;
  if (focus) focusAndReveal($(id));
}
function hideError(id) { $(id).hidden = true; }
