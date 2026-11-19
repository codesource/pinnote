// End-to-end test in a real, headless Chrome with a throwaway profile.
//
//   node tests/e2e.mjs [--shots DIR] [--keep]
//
// Starts a local test site, links it to a temporary project, loads a copy of
// the extension (with host access granted up front, since the permission
// prompt needs a real click), then drives the page over the DevTools pipe:
// pick an element, write a note, reply from the CLI, approve, pick an area.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "python/bin/pinnote");
const HOST_BIN = path.join(REPO, "python/bin/pinnote-host");
const args = process.argv.slice(2);
const shotsDir = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : null;
const keep = args.includes("--keep");

const tmp = fs.mkdtempSync(path.join(REPO, "tests", ".e2e-"));
const project = path.join(tmp, "project");
const profile = path.join(tmp, "profile");
const extDir = path.join(tmp, "extension");
fs.mkdirSync(project);
fs.mkdirSync(path.join(profile, "NativeMessagingHosts"), { recursive: true });
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const env = { ...process.env, PINNOTE_CONFIG: path.join(tmp, "projects.json"), XDG_STATE_HOME: path.join(tmp, "state") };

let failures = 0;
function check(cond, text) {
  console.log(`${cond ? "ok  " : "FAIL"} ${text}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, text, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timeout: ${text}`);
}

// --- test site ---------------------------------------------------------------
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Test shop</title>
<link rel="stylesheet" href="/app.css"></head><body><main class="page">
<h1 class="title">Welcome to the shop</h1>
<div class="cards">
 <div class="card"><h2 class="card__title">First</h2><p>First card text</p><a class="btn btn--primary" href="/buy">Buy</a></div>
 <div class="card"><h2 class="card__title">Second</h2><p>Second card text</p></div>
</div></main></body></html>`;
const CSS = `body { margin: 0; font-family: sans-serif; }
.page { padding: 24px; }
.title { color: #222; font-size: 32px; }
.cards { display: flex; gap: 16px; }
.card { border: 1px solid #ccc; border-radius: 8px; padding: 16px; width: 240px; }
.card__title { font-size: 18px; margin: 0 0 8px; }
@media (min-width: 600px) { .card .card__title { color: #0b7285; } }
.btn--primary { background: #1971c2; border-radius: 4px; color: #fff; padding: 6px 12px; text-decoration: none; }`;
const server = http.createServer((req, res) => {
  if (req.url === "/app.css") {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(CSS);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${server.address().port}`;
// a second dev site on another port, linked to another project
const server2 = http.createServer(server.listeners("request")[0]);
await new Promise((r) => server2.listen(0, "127.0.0.1", r));
const SITE2 = `http://127.0.0.1:${server2.address().port}`;
const project2 = path.join(tmp, "project-two");
fs.mkdirSync(project2);

// --- link, extension copy, native host manifest --------------------------------
execFileSync(CLI, ["link", SITE, project], { env });
execFileSync(CLI, ["link", SITE2, project2], { env });
fs.cpSync(path.join(REPO, "extension"), extDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json")));
manifest.host_permissions = ["<all_urls>"]; // test only: stands in for the permission prompt and activeTab
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));
const extId = execFileSync("python3", ["-I", "-c", `
import base64,hashlib,json,sys
k=json.load(open(sys.argv[1]))["key"];d=hashlib.sha256(base64.b64decode(k)).hexdigest()[:32]
print("".join(chr(97+int(c,16)) for c in d))`, path.join(extDir, "manifest.json")]).toString().trim();
fs.writeFileSync(path.join(profile, "NativeMessagingHosts", "ch.codesource.pinnote.json"), JSON.stringify({
  name: "ch.codesource.pinnote", description: "test", path: HOST_BIN, type: "stdio",
  allowed_origins: [`chrome-extension://${extId}/`],
}));

// --- Chrome over the DevTools pipe ------------------------------------------------
const chrome = spawn("google-chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,800", "about:blank",
], { env, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true }); // own process group
const killChrome = (signal) => {
  try {
    process.kill(-chrome.pid, signal); // the whole group: helper processes write to the profile too
  } catch {
    // already gone
  }
};
process.on("exit", () => killChrome("SIGKILL"));
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));

let nextId = 0;
const pending = new Map();
const listeners = [];
let buffer = "";
chrome.stdio[4].on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ""}`));
      else resolve(msg.result);
    } else {
      listeners.forEach((fn) => fn(msg));
    }
  }
});
function cdp(method, params = {}, sessionId) {
  const id = ++nextId;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(sessionId, expression) {
  const res = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (res.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
  return res.result.value;
}
const errors = [];
listeners.push((msg) => {
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
});

async function attach(targetId) {
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  return sessionId;
}
async function screenshot(sessionId, name) {
  if (!shotsDir) return;
  const { data } = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(data, "base64"));
}
const mouse = (sessionId, type, x, y, extra = {}) =>
  cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra }, sessionId);
async function click(sessionId, x, y) {
  await mouse(sessionId, "mouseMoved", x, y, { button: "none" });
  await mouse(sessionId, "mousePressed", x, y, { clickCount: 1, buttons: 1 });
  await mouse(sessionId, "mouseReleased", x, y, { clickCount: 1 });
}
async function ctrlEnter(sessionId) {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 };
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, sessionId);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sessionId);
}
const noteFile = (id) => path.join(project, ".pinnote", "notes", `${id}.json`);
const readNote = (id) => JSON.parse(fs.readFileSync(noteFile(id)));

try {
  const { id: loadedId } = await cdp("Extensions.loadUnpacked", { path: extDir });
  check(loadedId === extId, `extension loaded with the pinned id ${loadedId}`);

  const sw = await waitFor(async () => (await cdp("Target.getTargets")).targetInfos.find(
    (t) => t.type === "service_worker" && t.url.includes(extId)), "service worker");
  const swSession = await attach(sw.targetId);
  // onInstalled races with our attach; run a sync through the alarm path to be sure
  await waitFor(() => evaluate(swSession,
    `chrome.scripting.getRegisteredContentScripts().then(s => s.length === 1)`), "content script registered");
  check(true, "content script registered for the linked site");

  const { targetId } = await cdp("Target.createTarget", { url: `${SITE}/` });
  const page = await attach(targetId);
  await cdp("Page.enable", {}, page);
  await waitFor(() => evaluate(page, `!!document.querySelector("pinnote-ui")`), "pinnote UI injected");
  check(true, "Pinnote UI injected into the page");
  await sleep(800);
  await screenshot(page, "1-page-with-dock");

  const sendToPage = (msg) => evaluate(swSession, `chrome.tabs.query({url: "${SITE}/*"})
    .then(t => chrome.tabs.sendMessage(t[0].id, ${JSON.stringify(msg)})).then(() => true)`);

  // --- element note ------------------------------------------------------------
  const rect = await evaluate(page, `(() => { const r = document.querySelectorAll(".card__title")[0].getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height}; })()`);
  await sendToPage({ type: "pick" });
  await sleep(200);
  await mouse(page, "mouseMoved", rect.x + 20, rect.y + 8, { button: "none" });
  await sleep(150);
  await screenshot(page, "2-picking-hover");
  await click(page, rect.x + 20, rect.y + 8);
  await sleep(1200);
  await screenshot(page, "3-composer");
  await cdp("Input.insertText", { text: "Make the card titles bolder and a bit larger" }, page);
  await ctrlEnter(page);
  await waitFor(() => fs.existsSync(noteFile(1)), "note 1 saved");
  const n1 = readNote(1);
  check(n1.target.kind === "element", "note 1 targets an element");
  check(n1.target.elements[0].selector.includes("card__title"), `selector: ${n1.target.elements[0].selector}`);
  check(n1.target.elements[0].rules.some((r) => r.selector === ".card .card__title" && r.media),
    "matched rules include the media-query rule");
  check(Boolean(n1.shot) && fs.existsSync(path.join(project, n1.shot.file)), `screenshot saved ${n1.shot?.width}×${n1.shot?.height}`);
  check(n1.page.url.startsWith(SITE), "page URL recorded");
  console.log(execFileSync(CLI, ["show", "1", "-C", project], { env }).toString());

  // --- reply from Claude's side, pin turns green, approve ------------------------
  execFileSync(CLI, ["reply", "1", "Done: .card__title is now 20px/700 in app.scss:6", "-C", project], { env });
  await sleep(5000); // one poll cycle
  await screenshot(page, "4-after-claude-reply");
  await click(page, rect.x, rect.y); // the pin sits on the element's top-left corner
  await sleep(800);
  await screenshot(page, "5-thread-open");
  await ctrlEnter(page); // empty textarea on a done note: approve
  await waitFor(() => readNote(1).status === "resolved", "note 1 approved");
  check(true, "note 1 approved from the page");

  // --- area note -----------------------------------------------------------------
  const cards = await evaluate(page, `(() => { const r = document.querySelector(".cards").getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height}; })()`);
  await sendToPage({ type: "pick" });
  await sleep(200);
  const [x0, y0, x1, y1] = [cards.x - 6, cards.y - 6, cards.x + cards.w + 6, cards.y + cards.h + 6];
  await mouse(page, "mouseMoved", x0, y0, { button: "none" });
  await mouse(page, "mousePressed", x0, y0, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await mouse(page, "mouseMoved", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, { buttons: 1 });
  }
  await screenshot(page, "6-area-drag");
  await mouse(page, "mouseReleased", x1, y1, { clickCount: 1 });
  await sleep(1200);
  await cdp("Input.insertText", { text: "More space between these cards" }, page);
  await ctrlEnter(page);
  await waitFor(() => fs.existsSync(noteFile(2)), "note 2 saved");
  const n2 = readNote(2);
  check(n2.target.kind === "area", "note 2 targets an area");
  check(n2.target.elements.some((e) => e.classes.includes("cards")), "area found the .cards container");
  await sleep(500);
  await screenshot(page, "7-area-pinned");

  // --- popup status for this tab ---------------------------------------------------
  const tabId = await evaluate(swSession, `chrome.tabs.query({url: "${SITE}/*"}).then(t => t[0].id)`);
  const { targetId: popupTarget } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
  const popup = await attach(popupTarget);
  const status = await evaluate(popup, `chrome.runtime.sendMessage({type: "status", tabId: ${tabId}})`);
  check(status.state === "linked" && status.project.counts.open === 1, `popup status: ${status.state}, open ${status.project?.counts?.open}`);

  console.log(execFileSync(CLI, ["list", "-a", "-C", project], { env }).toString());

  // --- second project in another tab -------------------------------------------------
  const { targetId: target2 } = await cdp("Target.createTarget", { url: `${SITE2}/` });
  const page2 = await attach(target2);
  await cdp("Page.enable", {}, page2);
  await cdp("Page.bringToFront", {}, page2);
  await waitFor(() => evaluate(page2, `!!document.querySelector("pinnote-ui")`), "UI in the second tab");
  await sleep(600);
  const btn = await evaluate(page2, `(() => { const r = document.querySelector(".btn").getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
  const picked = await evaluate(swSession, `chrome.tabs.query({url: "${SITE2}/*"})
    .then(t => chrome.tabs.sendMessage(t[0].id, {type: "pick"}).then(r => ({tabs: t.length, r})))`);
  check(picked.tabs === 1 && picked.r?.ok, "pick mode started in the second tab");
  await sleep(200);
  await click(page2, btn.x, btn.y); // a link: picking it must not follow it
  await sleep(1200);
  check(await evaluate(page2, "location.pathname") === "/", "picking a link did not navigate");
  await screenshot(page2, "8-second-tab-composer");
  await cdp("Input.insertText", { text: "Button needs more contrast" }, page2);
  await ctrlEnter(page2);
  const note2File = path.join(project2, ".pinnote", "notes", "1.json");
  await waitFor(() => fs.existsSync(note2File), "note saved in the second project");
  check(!fs.existsSync(noteFile(3)), "second tab's note went to the second project only");
  const pollNow = () => evaluate(swSession, `chrome.alarms.create("pinnote-poll", {when: Date.now() + 50})
    .then(() => new Promise(r => setTimeout(r, 1500)))`);
  await pollNow(); // baseline: replies already there do not notify
  execFileSync(CLI, ["reply", "1", "--question", "Darker blue or white border?", "-C", project2], { env });
  await pollNow();
  const notes = await evaluate(swSession, `chrome.notifications.getAll()`);
  const ids = Object.keys(notes);
  check(ids.length === 1 && ids[0].includes("project-two#1"), `one desktop notification: ${ids.join(", ")}`);
  await sleep(4000);
  const badges = await evaluate(swSession, `Promise.all([${JSON.stringify(SITE)}, ${JSON.stringify(SITE2)}].map(
    (s) => chrome.tabs.query({url: s + "/*"}).then(t => chrome.action.getBadgeText({tabId: t[0].id}))))`);
  check(badges[0] === "" && badges[1] === "1", `badges per tab: first "${badges[0]}", second "${badges[1]}"`);
  await screenshot(page2, "8-second-project-question");
} catch (err) {
  failures++;
  console.log(`FAIL ${err.message}`);
} finally {
  const relevant = errors.filter((e) => !String(JSON.stringify(e)).includes("favicon"));
  check(relevant.length === 0, `no page or worker errors${relevant.length ? `: ${JSON.stringify(relevant).slice(0, 800)}` : ""}`);
  const exited = new Promise((r) => chrome.once("exit", r));
  killChrome("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  killChrome("SIGKILL");
  await sleep(300);
  server.close();
  server2.close();
  if (!keep) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      console.log(`warning: could not remove ${tmp}: ${err.code || err.message}`);
    }
  }
  if (failures && chromeErr) console.log(chromeErr.split("\n").slice(-15).join("\n"));
  console.log(failures ? `${failures} failure(s)` : "all good");
  process.exit(failures ? 1 : 0);
}
