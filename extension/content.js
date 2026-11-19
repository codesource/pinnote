// Pinnote content script: picker, note composer, pins, threads and dock.
// Injected only into pages of linked dev sites (see sw.js). All UI lives in a
// closed shadow root and is built with textContent, never innerHTML.

(() => {
  if (globalThis.__pinnoteActive) return;
  globalThis.__pinnoteActive = true;

  const POLL_MS = 4000;
  const DRAG_THRESHOLD = 6;
  const AREA_MAX_ELEMENTS = 8;
  const RULES_PER_ELEMENT = 8;
  const STATUS_TEXT = {
    open: "Waiting for Claude",
    question: "Question for you",
    done: "Done, please review",
    resolved: "Resolved",
  };
  const NO_SHOT_HINT =
    "No screenshot. To include one, start with Alt+Shift+N, the right-click menu or the toolbar button.";

  const state = {
    project: null,
    notes: [],
    counts: null,
    etag: null,
    mode: "idle", // idle | picking | composing
    pick: null,
    compose: null,
    threadId: null,
    lastContextTarget: null,
    showResolved: false,
    dockOpen: false,
    settings: { dock: true },
    route: routeKey(location.href),
  };

  // -------------------------------------------------------------------------
  // DOM helpers

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  function fill(el, ...children) {
    el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  }

  function nextFrames(n = 2) {
    return new Promise((resolve) => {
      const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function shortTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
  }

  function routeKey(url) {
    try {
      const u = new URL(url);
      const hashRoute = /^#!?\//.test(u.hash) ? u.hash.split("?")[0] : "";
      return `${u.origin}${u.pathname}${hashRoute}`;
    } catch {
      return url;
    }
  }

  function firstLine(text, max = 80) {
    const line = String(text || "").replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  // -------------------------------------------------------------------------
  // UI skeleton

  const UI_STYLES = `
:host {
  all: initial !important;
  display: block !important;
  height: 0 !important;
  left: 0 !important;
  position: fixed !important;
  top: 0 !important;
  width: 0 !important;
  z-index: 2147483647 !important;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.ui {
  --accent: #d9480f;
  --bg: #ffffff;
  --fg: #1f2328;
  --line: #d0d7de;
  --muted: #656d76;
  --s-done: #2f9e44;
  --s-open: #1971c2;
  --s-question: #e67700;
  --s-resolved: #868e96;
  --shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  --soft: #f6f8fa;
  color: var(--fg);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .ui {
    --bg: #1f2328;
    --fg: #e6edf3;
    --line: #3d444d;
    --muted: #9198a1;
    --soft: #2a313c;
  }
}
.layer { inset: 0; overflow: hidden; pointer-events: none; position: fixed; }
.pin {
  background: var(--s-open);
  border: 2px solid #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  color: #ffffff;
  cursor: pointer;
  font: 600 11px/18px system-ui, sans-serif;
  height: 22px;
  left: 0;
  min-width: 22px;
  padding: 0 4px;
  pointer-events: auto;
  position: absolute;
  text-align: center;
  top: 0;
}
.pin.s-question { background: var(--s-question); }
.pin.s-done { background: var(--s-done); }
.pin.s-resolved { background: var(--s-resolved); }
.pin.detached { border-style: dashed; opacity: 0.75; }
.pin.active { outline: 2px solid var(--accent); outline-offset: 2px; }
.hl {
  background: rgba(217, 72, 15, 0.08);
  border: 2px solid var(--accent);
  border-radius: 3px;
  pointer-events: none;
  position: fixed;
}
.hl.area { border-style: dashed; }
.hl-label {
  background: var(--accent);
  border-radius: 3px;
  bottom: 100%;
  color: #ffffff;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  left: -2px;
  margin-bottom: 4px;
  max-width: 60vw;
  overflow: hidden;
  padding: 0 6px;
  position: absolute;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hl.below .hl-label { bottom: auto; margin: 4px 0 0; top: 100%; }
.banner {
  background: var(--fg);
  border-radius: 999px;
  box-shadow: var(--shadow);
  color: var(--bg);
  font-size: 12px;
  left: 50%;
  padding: 6px 14px;
  pointer-events: none;
  position: fixed;
  top: 10px;
  transform: translateX(-50%);
  white-space: nowrap;
}
.pop {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  max-height: min(72vh, 600px);
  overflow: auto;
  padding: 12px;
  pointer-events: auto;
  position: fixed;
  width: 340px;
}
.head { align-items: center; display: flex; gap: 8px; margin-bottom: 8px; }
.head h2 { flex: 1; font-size: 13px; font-weight: 600; margin: 0; }
.x {
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 2px 4px;
}
.sel {
  color: var(--muted);
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  margin-bottom: 8px;
  word-break: break-all;
}
canvas.shot {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 6px;
  display: block;
  margin-bottom: 8px;
  max-width: 100%;
}
.warn {
  background: var(--soft);
  border-radius: 6px;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 8px;
  padding: 6px 8px;
}
textarea {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--fg);
  display: block;
  font: inherit;
  min-height: 72px;
  padding: 6px 8px;
  resize: vertical;
  width: 100%;
}
textarea:focus { border-color: var(--accent); outline: 1px solid var(--accent); }
.row { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.row.top { margin-top: 0; }
.spacer { flex: 1; }
.btn {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--fg);
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  padding: 4px 10px;
}
.btn.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
.btn.danger { color: #e03131; }
.btn:disabled { cursor: default; opacity: 0.5; }
.check { align-items: center; color: var(--muted); display: flex; font-size: 12px; gap: 6px; }
.chip {
  background: var(--s-open);
  border-radius: 999px;
  color: #ffffff;
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  white-space: nowrap;
}
.chip.s-question { background: var(--s-question); }
.chip.s-done { background: var(--s-done); }
.chip.s-resolved { background: var(--s-resolved); }
.msg { border-top: 1px solid var(--line); padding: 8px 0; }
.who { color: var(--muted); font-size: 11px; margin-bottom: 2px; }
.who b { color: var(--fg); }
.msg.claude .who b { color: var(--accent); }
.text { overflow-wrap: anywhere; white-space: pre-wrap; }
.dock {
  align-items: flex-end;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: auto;
  position: fixed;
  right: 16px;
}
.pill {
  align-items: center;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  color: var(--fg);
  cursor: pointer;
  display: flex;
  font: inherit;
  gap: 8px;
  padding: 5px 12px;
}
.pill .name { font-weight: 600; }
.count { align-items: center; display: inline-flex; font-size: 12px; gap: 4px; }
.dot { border-radius: 50%; display: inline-block; height: 8px; width: 8px; }
.dot.s-open { background: var(--s-open); }
.dot.s-question { background: var(--s-question); }
.dot.s-done { background: var(--s-done); }
.panel {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  max-height: 60vh;
  overflow: auto;
  padding: 10px;
  width: 330px;
}
.panel h3 {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  margin: 10px 0 4px;
  text-transform: uppercase;
}
.item {
  align-items: baseline;
  background: none;
  border: 0;
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  display: flex;
  font: inherit;
  gap: 8px;
  padding: 5px 6px;
  text-align: left;
  width: 100%;
}
.item:hover { background: var(--soft); }
.num { font-weight: 600; min-width: 30px; }
.body { min-width: 0; }
.what { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.where { color: var(--muted); font-size: 11px; }
.empty { color: var(--muted); font-size: 12px; padding: 4px 6px; }
.toast {
  background: var(--fg);
  border-radius: 8px;
  bottom: 24px;
  box-shadow: var(--shadow);
  color: var(--bg);
  font-size: 12px;
  left: 50%;
  max-width: 80vw;
  padding: 6px 14px;
  pointer-events: none;
  position: fixed;
  transform: translateX(-50%);
}
`;

  const hostEl = document.createElement("pinnote-ui");
  const shadow = hostEl.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(UI_STYLES);
  shadow.adoptedStyleSheets = [sheet];

  const pinsLayer = h("div", { class: "layer" });
  const hl = h("div", { class: "hl", hidden: true }, h("span", { class: "hl-label" }));
  const banner = h("div", { class: "banner", hidden: true });
  const pop = h("div", { class: "pop", hidden: true, role: "dialog" });
  const dock = h("div", { class: "dock", hidden: true });
  const toastEl = h("div", { class: "toast", hidden: true, role: "status" });
  const ui = h("div", { class: "ui" }, pinsLayer, hl, banner, pop, dock, toastEl);
  shadow.append(ui);
  document.documentElement.append(hostEl);

  // Keys typed in our UI must not trigger the page's own shortcuts.
  for (const type of ["keydown", "keyup", "keypress"]) {
    hostEl.addEventListener(type, (e) => e.stopPropagation());
  }

  let toastTimer = 0;
  function toast(text, ms = 3200) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
  }

  // -------------------------------------------------------------------------
  // messaging

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  async function send(msg) {
    if (!alive()) {
      teardown();
      return null;
    }
    try {
      return await chrome.runtime.sendMessage({ ...msg, url: location.href });
    } catch (err) {
      if (!alive()) {
        teardown();
        return null;
      }
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // -------------------------------------------------------------------------
  // element description (what Claude reads)

  const UNSTABLE_CLASS =
    /^(is-|has-|js-|ng-|v-|css-|sc-|jsx-|svelte-|_)|(active|hover|focus|open|show|selected|disabled|visible|hidden|current)$|__(?=[a-z]*\d)[a-z0-9]{5}$/i;

  function isUnstableClass(name) {
    // also generated hashes such as "a3f9c1d" (hex run that contains a digit)
    return UNSTABLE_CLASS.test(name) || (/[0-9a-f]{6,}/i.test(name) && /\d/.test(name));
  }
  const ATTRS = ["role", "aria-label", "name", "type", "href", "src", "alt", "placeholder", "for",
    "data-testid", "data-controller", "data-action"];
  const BOX_SIDES = ["top", "right", "bottom", "left"];
  const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function safeMatches(el, selector) {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  function quoteAttr(value) {
    return `"${String(value).replace(/["\\]/g, "\\$&")}"`;
  }

  function stableId(el) {
    return el.id && !/\d{3,}|[:]/.test(el.id) ? `#${CSS.escape(el.id)}` : null;
  }

  function selectorPart(el) {
    const tag = el.tagName.toLowerCase();
    const testid = el.getAttribute("data-testid");
    if (testid) return `${tag}[data-testid=${quoteAttr(testid)}]`;
    const classes = [...el.classList].filter((c) => !isUnstableClass(c)).slice(0, 2);
    return tag + classes.map((c) => `.${CSS.escape(c)}`).join("");
  }

  function uniqueSelector(el) {
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    const own = stableId(el);
    if (own && isUnique(own)) return own;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const id = cur !== el ? stableId(cur) : null;
      if (id && isUnique(id)) {
        parts.unshift(id);
        break;
      }
      let part = selectorPart(cur);
      const parent = cur.parentElement;
      if (parent) {
        const clash = [...parent.children].some((c) => c !== cur && safeMatches(c, part));
        if (clash) {
          const index = [...parent.children].filter((c) => c.tagName === cur.tagName).indexOf(cur) + 1;
          part += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(part);
      if (isUnique(parts.join(" > "))) break;
      cur = parent;
    }
    return parts.join(" > ");
  }

  function compress(values) {
    const [t, r, b, l] = values;
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return `${t} ${r}`;
    if (r === l) return `${t} ${r} ${b}`;
    return values.join(" ");
  }

  function computedSubset(el) {
    const cs = getComputedStyle(el);
    const get = (p) => cs.getPropertyValue(p).trim();
    const out = {};
    const put = (key, value, skip = []) => {
      if (value && !skip.includes(value)) out[key] = value.length > 140 ? `${value.slice(0, 139)}…` : value;
    };
    const display = get("display");
    const position = get("position");
    put("display", display);
    put("position", position, ["static"]);
    if (position !== "static") {
      for (const side of BOX_SIDES) put(side, get(side), ["auto"]);
      put("z-index", get("z-index"), ["auto"]);
    }
    put("width", get("width"));
    put("height", get("height"));
    put("margin", compress(BOX_SIDES.map((s) => get(`margin-${s}`))), ["0px"]);
    put("padding", compress(BOX_SIDES.map((s) => get(`padding-${s}`))), ["0px"]);
    const borderWidth = compress(BOX_SIDES.map((s) => get(`border-${s}-width`)));
    if (borderWidth !== "0px") {
      put("border-width", borderWidth);
      put("border-style", compress(BOX_SIDES.map((s) => get(`border-${s}-style`))));
      put("border-color", compress(BOX_SIDES.map((s) => get(`border-${s}-color`))));
    }
    put("border-radius", compress(CORNERS.map((c) => get(`border-${c}-radius`))), ["0px"]);
    put("color", get("color"));
    put("background-color", get("background-color"), ["rgba(0, 0, 0, 0)"]);
    put("background-image", get("background-image"), ["none"]);
    put("font-family", get("font-family").split(",").slice(0, 2).join(","));
    put("font-size", get("font-size"));
    put("font-weight", get("font-weight"));
    put("line-height", get("line-height"));
    put("letter-spacing", get("letter-spacing"), ["normal"]);
    put("text-align", get("text-align"), ["start"]);
    put("text-transform", get("text-transform"), ["none"]);
    if (/flex|grid/.test(display)) {
      put("gap", get("gap"), ["normal", "normal normal"]);
      put("justify-content", get("justify-content"), ["normal"]);
      put("align-items", get("align-items"), ["normal"]);
    }
    if (/flex/.test(display)) {
      put("flex-direction", get("flex-direction"), ["row"]);
      put("flex-wrap", get("flex-wrap"), ["nowrap"]);
    }
    if (/grid/.test(display)) put("grid-template-columns", get("grid-template-columns"), ["none"]);
    put("opacity", get("opacity"), ["1"]);
    put("box-shadow", get("box-shadow"), ["none"]);
    put("overflow", get("overflow"), ["visible", "visible visible"]);
    put("transform", get("transform"), ["none"]);
    return out;
  }

  function sheetLabel(sheet) {
    const node = sheet.ownerNode;
    const viteId = node?.dataset?.viteDevId;
    if (viteId) return viteId;
    if (sheet.href) {
      try {
        return new URL(sheet.href).pathname;
      } catch {
        return sheet.href;
      }
    }
    return node?.id ? `<style id="${node.id}">` : "<style>";
  }

  function isGenericSelector(selector) {
    return selector.split(",").every((part) => /^(\*|:root|html|body)?(::?[a-z-]+)*$/i.test(part.trim()));
  }

  function propNames(style) {
    const names = new Set();
    for (let i = 0; i < style.length; i++) {
      names.add(style[i].replace(/-(top|right|bottom|left|start|end)(?=-|$)|-(x|y)$/g, ""));
    }
    return [...names].slice(0, 10);
  }

  function matchedRules(el) {
    const out = [];
    const started = performance.now();
    const isRoot = el === document.documentElement || el === document.body;
    const visit = (rules, source, context) => {
      for (const rule of rules) {
        if (performance.now() - started > 80) return;
        if (rule instanceof CSSStyleRule) {
          if (safeMatches(el, rule.selectorText) && (isRoot || !isGenericSelector(rule.selectorText))) {
            out.push({ selector: rule.selectorText.slice(0, 200), props: propNames(rule.style), source,
              ...(context ? { media: context } : {}) });
          }
        } else if (rule instanceof CSSImportRule) {
          if (rule.styleSheet) visitSheet(rule.styleSheet);
        } else if (rule.cssRules) {
          let label = null;
          if (rule instanceof CSSMediaRule) {
            if (!matchMedia(rule.conditionText).matches) continue;
            label = `media ${rule.conditionText}`;
          } else if (rule instanceof CSSSupportsRule) {
            if (!CSS.supports(rule.conditionText)) continue;
          } else if (typeof CSSLayerBlockRule !== "undefined" && rule instanceof CSSLayerBlockRule) {
            label = rule.name ? `layer ${rule.name}` : null;
          } else if (rule.constructor?.name === "CSSContainerRule") {
            label = `container ${rule.conditionText}`;
          }
          visit(rule.cssRules, source, label ? [context, label].filter(Boolean).join(" ") : context);
        }
      }
    };
    const visitSheet = (sheet) => {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        return; // cross-origin stylesheet
      }
      if (sheet.media?.mediaText && !matchMedia(sheet.media.mediaText).matches) return;
      visit(rules, sheetLabel(sheet), null);
    };
    for (const sheet of document.styleSheets) visitSheet(sheet);
    for (const sheet of document.adoptedStyleSheets || []) visitSheet(sheet);
    return out.slice(-RULES_PER_ELEMENT);
  }

  function attrsOf(el) {
    const out = {};
    for (const name of ATTRS) {
      let value = el.getAttribute(name);
      if (value === null) continue;
      if ((name === "href" || name === "src") && !value.startsWith("#")) {
        try {
          const u = new URL(value, location.href);
          value = u.origin === location.origin ? u.pathname + u.search : u.href;
        } catch {
          // keep as is
        }
      }
      out[name] = value.slice(0, 120);
    }
    return out;
  }

  function docRect(r) {
    return {
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  function describe(el, withRules) {
    const isField = el.matches("input, textarea, select");
    const text = isField ? "" : (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const attrs = attrsOf(el);
    return {
      selector: uniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      ...(el.id ? { id: el.id } : {}),
      classes: [...el.classList].slice(0, 12),
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(text ? { text } : {}),
      rect: docRect(el.getBoundingClientRect()),
      styles: computedSubset(el),
      ...(withRules ? { rules: matchedRules(el) } : {}),
    };
  }

  function pageInfo() {
    return {
      title: document.title.slice(0, 200),
      viewport: { w: innerWidth, h: innerHeight },
      dpr: Math.round(devicePixelRatio * 100) / 100,
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    };
  }

  function label(el) {
    const id = el.id ? `#${el.id}` : "";
    const classes = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${id}${classes} · ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function elementAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el !== hostEl) return el;
    }
    return null;
  }

  function elementsInArea(area) {
    const inside = [];
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (const el of all) {
      if (el === hostEl) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      const ix = Math.min(b.right, area.x + area.w) - Math.max(b.left, area.x);
      const iy = Math.min(b.bottom, area.y + area.h) - Math.max(b.top, area.y);
      if (ix > 0 && iy > 0 && (ix * iy) / (b.width * b.height) >= 0.8) inside.push(el);
      if (inside.length > 3000) break;
    }
    const set = new Set(inside);
    const top = inside.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
    const size = (el) => {
      const b = el.getBoundingClientRect();
      return b.width * b.height;
    };
    return top.sort((a, b) => size(b) - size(a)).slice(0, AREA_MAX_ELEMENTS);
  }

  function commonAncestor(elements) {
    if (!elements.length) return null;
    let anc = elements[0].parentElement;
    while (anc && !elements.every((el) => anc.contains(el))) anc = anc.parentElement;
    return anc;
  }

  // -------------------------------------------------------------------------
  // highlight box

  function showHighlight(rect, text, area = false) {
    hl.hidden = false;
    hl.classList.toggle("area", area);
    hl.classList.toggle("below", rect.top < 24);
    hl.style.left = `${rect.left}px`;
    hl.style.top = `${rect.top}px`;
    hl.style.width = `${rect.width}px`;
    hl.style.height = `${rect.height}px`;
    const labelEl = hl.firstChild;
    labelEl.hidden = !text;
    labelEl.textContent = text || "";
  }

  function hideHighlight() {
    hl.hidden = true;
  }

  // -------------------------------------------------------------------------
  // picking

  const PICK_EVENTS = ["pointerdown", "pointermove", "pointerup", "click", "mousedown", "mouseup",
    "auxclick", "dblclick", "dragstart", "keydown", "contextmenu"];

  function startPick(areaOnly = false) {
    if (!state.project) {
      toast("This page is not linked to a Pinnote project.");
      return;
    }
    if (state.mode === "picking") return;
    closePop();
    state.mode = "picking";
    state.pick = { areaOnly, base: null, current: null, stack: [], down: null, dragging: false };
    banner.textContent = areaOnly
      ? "Drag an area · Esc to cancel"
      : "Click an element or drag an area · ↑ ↓ parent/child · Enter to select · Esc to cancel";
    banner.hidden = false;
    for (const type of PICK_EVENTS) window.addEventListener(type, onPickEvent, true);
  }

  // The pick ends on pointerup, but the browser still sends mouseup and click
  // afterwards; without this, picking a link or button would follow or press it.
  function swallowTrailingClick() {
    const types = ["mouseup", "click", "auxclick", "dblclick"];
    const swallow = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "click" || e.type === "auxclick") done();
    };
    const done = () => types.forEach((t) => window.removeEventListener(t, swallow, true));
    types.forEach((t) => window.addEventListener(t, swallow, true));
    setTimeout(done, 600);
  }

  function stopPick() {
    for (const type of PICK_EVENTS) window.removeEventListener(type, onPickEvent, true);
    banner.hidden = true;
    state.pick = null;
    if (state.mode === "picking") state.mode = "idle";
  }

  function cancelPick() {
    stopPick();
    hideHighlight();
  }

  function setCurrent(el) {
    state.pick.current = el;
    showHighlight(el.getBoundingClientRect(), label(el));
  }

  function dragRect(down, e) {
    const x = Math.min(down.x, e.clientX);
    const y = Math.min(down.y, e.clientY);
    return { x, y, w: Math.abs(e.clientX - down.x), h: Math.abs(e.clientY - down.y) };
  }

  function onPickEvent(e) {
    const pick = state.pick;
    if (!pick) return;
    if (e.type === "keydown") {
      const keys = ["Escape", "ArrowUp", "ArrowDown", "Enter"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") cancelPick();
      else if (e.key === "ArrowUp" && pick.current?.parentElement && pick.current.parentElement !== document.documentElement) {
        pick.stack.push(pick.current);
        setCurrent(pick.current.parentElement);
      } else if (e.key === "ArrowDown" && pick.stack.length) {
        setCurrent(pick.stack.pop());
      } else if (e.key === "Enter" && pick.current && !pick.areaOnly) {
        finishElement(pick.current);
      }
      return;
    }
    if (e.composedPath().includes(hostEl)) return; // our own UI (pins, dock)
    e.preventDefault();
    e.stopImmediatePropagation();

    if (e.type === "pointermove") {
      if (pick.down) {
        const r = dragRect(pick.down, e);
        if (!pick.dragging && (r.w > DRAG_THRESHOLD || r.h > DRAG_THRESHOLD)) pick.dragging = true;
        if (pick.dragging) {
          showHighlight({ left: r.x, top: r.y, width: r.w, height: r.h }, `${r.w}×${r.h}`, true);
        }
        return;
      }
      if (pick.areaOnly) return;
      const el = elementAt(e.clientX, e.clientY);
      if (el && el !== pick.base) {
        pick.base = el;
        pick.stack = [];
        setCurrent(el);
      }
    } else if (e.type === "pointerdown" && e.button === 0) {
      pick.down = { x: e.clientX, y: e.clientY };
      pick.dragging = false;
    } else if (e.type === "pointerup" && pick.down) {
      swallowTrailingClick();
      const r = dragRect(pick.down, e);
      const dragging = pick.dragging;
      pick.down = null;
      if (dragging && r.w > DRAG_THRESHOLD && r.h > DRAG_THRESHOLD) finishArea(r);
      else if (!pick.areaOnly && pick.current) finishElement(pick.current);
    }
  }

  function finishElement(el) {
    stopPick();
    const target = { kind: "element", rect: docRect(el.getBoundingClientRect()), elements: [describe(el, true)] };
    compose(target, { el });
  }

  function finishArea(area) {
    stopPick();
    let elements = elementsInArea(area);
    if (!elements.length) {
      const center = elementAt(area.x + area.w / 2, area.y + area.h / 2);
      elements = center ? [center] : [];
    }
    const container = commonAncestor(elements);
    const docArea = {
      x: Math.round(area.x + scrollX), y: Math.round(area.y + scrollY),
      w: Math.round(area.w), h: Math.round(area.h),
    };
    const target = {
      kind: "area",
      rect: docArea,
      elements: elements.map((el, i) => describe(el, i < 3)),
      ...(container ? { container: { selector: uniqueSelector(container), tag: container.tagName.toLowerCase() } } : {}),
    };
    compose(target, { rect: docArea });
  }

  // -------------------------------------------------------------------------
  // positions of notes / targets in the viewport

  function viewRectOf(anchor) {
    if (anchor.el?.isConnected) {
      const r = anchor.el.getBoundingClientRect();
      if (r.width || r.height) return { left: r.left, top: r.top, width: r.width, height: r.height };
      return null;
    }
    if (anchor.rect) {
      return { left: anchor.rect.x - scrollX, top: anchor.rect.y - scrollY, width: anchor.rect.w, height: anchor.rect.h };
    }
    return null;
  }

  function findTarget(note) {
    if (note.target?.kind !== "element" || !note.target.selector) return null;
    try {
      return document.querySelector(note.target.selector);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // composer

  async function compose(target, anchor) {
    state.mode = "composing";
    hideHighlight();
    const viewRect = viewRectOf(anchor);
    let shot = null;
    let shotError = "No screenshot: the target is not visible.";
    if (viewRect) {
      hostEl.style.setProperty("visibility", "hidden", "important");
      await nextFrames(2);
      const res = await send({
        type: "capture",
        rect: { x: viewRect.left, y: viewRect.top, w: viewRect.width, h: viewRect.height },
        viewport: { w: innerWidth, h: innerHeight },
      });
      hostEl.style.removeProperty("visibility");
      if (res?.ok) {
        shot = res;
        shotError = null;
      } else shotError = res?.needsActivation ? NO_SHOT_HINT : `No screenshot: ${res?.error || "unknown error"}`;
    }
    state.compose = { target, anchor, shot };
    renderComposer(shotError);
  }

  function targetText(target) {
    if (target.kind === "area") {
      return `area ${target.rect.w}×${target.rect.h} · ${target.elements.length} element(s)`;
    }
    return target.elements?.[0]?.selector || target.selector || "element";
  }

  async function drawPng(canvas, base64, maxWidth) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const width = Math.min(maxWidth, bitmap.width);
    const height = Math.round((bitmap.height * width) / bitmap.width);
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  }

  function renderComposer(shotError) {
    const { target, shot } = state.compose;
    const textarea = h("textarea", { placeholder: "What should change?", "aria-label": "Note" });
    const attach = h("input", { type: "checkbox", checked: Boolean(shot) });
    const save = h("button", { class: "btn primary", text: "Save" });
    const cancel = h("button", { class: "btn", text: "Cancel" });
    const canvas = shot ? h("canvas", { class: "shot" }) : null;

    const submit = async () => {
      const text = textarea.value.trim();
      if (!text) {
        textarea.focus();
        return;
      }
      save.disabled = true;
      const res = await send({
        type: "create",
        note: { text, page: pageInfo(), target, shot: shot ? { clipped: shot.clipped } : null },
        png: shot && attach.checked ? shot.png : null,
      });
      if (!res?.ok) {
        save.disabled = false;
        toast(`Not saved: ${res?.error || "no answer"}`, 6000);
        return;
      }
      closePop();
      toast(`Note #${res.note.id} pinned`);
      state.etag = null;
      refresh();
    };
    save.addEventListener("click", submit);
    cancel.addEventListener("click", closePop);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });

    fill(pop,
      h("div", { class: "head" },
        h("h2", { text: `New note · ${state.project?.name || ""}` }),
        h("button", { class: "x", title: "Close (Esc)", "aria-label": "Close", text: "×", onclick: closePop })),
      h("div", { class: "sel", text: targetText(target) }),
      canvas,
      shot ? null : h("div", { class: "warn", text: shotError || NO_SHOT_HINT }),
      textarea,
      h("div", { class: "row" },
        shot ? h("label", { class: "check" }, attach, "Attach screenshot") : null,
        h("span", { class: "spacer" }),
        cancel, save),
    );
    if (canvas) drawPng(canvas, shot.png, 314).then(() => placePop(), () => {});
    openPop(state.compose.anchor, "compose");
    textarea.focus();
  }

  // -------------------------------------------------------------------------
  // popover (composer and threads)

  let popKind = null;
  let popAnchor = null;

  function openPop(anchor, kind) {
    popKind = kind;
    popAnchor = anchor;
    pop.hidden = false;
    placePop();
    pop.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePop();
      }
    };
  }

  function placePop() {
    if (pop.hidden) return;
    const r = (popAnchor && viewRectOf(popAnchor)) || { left: innerWidth / 2 - 170, top: 80, width: 0, height: 0 };
    const width = pop.offsetWidth || 340;
    const height = pop.offsetHeight || 200;
    const left = clamp(r.left, 8, innerWidth - width - 8);
    let top = r.top + r.height + 10;
    if (top + height > innerHeight - 8) top = r.top - height - 10;
    if (top < 8) top = clamp(innerHeight - height - 8, 8, Infinity);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    if (popKind === "compose" && state.compose) {
      const target = viewRectOf(state.compose.anchor);
      if (target) showHighlight(target, null, state.compose.target.kind === "area");
    }
  }

  function closePop() {
    pop.hidden = true;
    pop.replaceChildren();
    if (popKind === "compose") {
      state.compose = null;
      hideHighlight();
    }
    if (state.mode === "composing") state.mode = "idle";
    popKind = null;
    popAnchor = null;
    state.threadId = null;
    renderPins();
  }

  // -------------------------------------------------------------------------
  // threads

  function noteById(id) {
    return state.notes.find((n) => String(n.id) === String(id));
  }

  function onThisPage(note) {
    return routeKey(note.page?.url || "") === routeKey(location.href);
  }

  function anchorOf(note) {
    const el = findTarget(note);
    return el ? { el } : { rect: note.target?.rect };
  }

  function openThread(id) {
    const note = noteById(id);
    if (!note) {
      toast(`Note #${id} not found`);
      return;
    }
    if (!onThisPage(note)) {
      goToNote(note);
      return;
    }
    if (state.mode === "picking") cancelPick();
    if (popKind === "compose") return; // never drop a draft
    state.threadId = note.id;
    renderThread(note, true);
  }

  function renderThread(note, fresh = false) {
    const old = pop.querySelector("textarea");
    const draft = old?.value || "";
    const hadFocus = old && shadow.activeElement === old;

    const textarea = h("textarea", {
      placeholder: note.status === "done" ? "Optional: what still needs to change?" : "Reply…",
      "aria-label": "Reply",
    });
    textarea.value = fresh ? "" : draft;
    const buttons = [];
    const act = async (action, needText) => {
      const text = textarea.value.trim();
      if (needText && !text) {
        textarea.focus();
        toast("Write a reply first");
        return;
      }
      buttons.forEach((b) => (b.disabled = true));
      const res = await send({ type: "update", id: note.id, action, text });
      if (!res?.ok) {
        buttons.forEach((b) => (b.disabled = false));
        toast(`Not saved: ${res?.error || "no answer"}`, 6000);
        return;
      }
      textarea.value = "";
      state.etag = null;
      await refresh();
      if (action === "approve" || action === "delete") closePop();
      if (action === "delete") toast(`Note #${note.id} deleted`);
    };
    const btn = (text, cls, onclick) => {
      const b = h("button", { class: `btn ${cls}`, text, onclick });
      buttons.push(b);
      return b;
    };
    let armed = false;
    const del = btn("Delete", "danger", () => {
      if (!armed) {
        armed = true;
        del.textContent = "Click again to delete";
        return;
      }
      act("delete", false);
    });

    const primary = [];
    if (note.status === "done") {
      primary.push(btn("Ask for a change", "", () => act("reply", true)));
      primary.push(btn("Approve", "primary", () => act("approve", false)));
    } else if (note.status === "resolved") {
      primary.push(btn("Reopen", "primary", () => act("reopen", false)));
    } else {
      primary.push(btn(note.status === "question" ? "Answer" : "Add to note", "primary", () => act("reply", true)));
    }
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        // On a done note, typed text means "ask for a change", no text means "approve".
        const index = note.status === "done" && textarea.value.trim() ? 0 : primary.length - 1;
        primary[index].click();
      }
    });

    const shotCanvas = note.shot ? h("canvas", { class: "shot" }) : null;
    const messages = (note.thread || []).map((m) =>
      h("div", { class: `msg ${m.author === "claude" ? "claude" : "user"}` },
        h("div", { class: "who" }, h("b", { text: m.author === "claude" ? "Claude" : "You" }), ` · ${shortTime(m.at)}`),
        h("div", { class: "text", text: m.text })));

    fill(pop,
      h("div", { class: "head" },
        h("h2", { text: `#${note.id}` }),
        h("span", { class: `chip s-${note.status}`, text: STATUS_TEXT[note.status] || note.status }),
        h("button", { class: "x", title: "Close (Esc)", "aria-label": "Close", text: "×", onclick: closePop })),
      h("div", { class: "sel", text: targetText(note.target || {}) }),
      shotCanvas,
      ...messages,
      textarea,
      h("div", { class: "row" }, del, h("span", { class: "spacer" }), ...primary),
    );
    if (shotCanvas) {
      send({ type: "shot", id: note.id }).then((res) => {
        if (res?.ok && shotCanvas.isConnected) drawPng(shotCanvas, res.png, 314).then(placePop, () => {});
      });
    }
    openPop(anchorOf(note), "thread");
    renderPins();
    if (fresh || hadFocus) textarea.focus();
  }

  async function goToNote(note) {
    if (onThisPage(note)) {
      const el = findTarget(note);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      else if (note.target?.rect) scrollTo({ top: Math.max(0, note.target.rect.y - innerHeight / 3), behavior: "smooth" });
      setTimeout(() => openThread(note.id), 350);
      return;
    }
    await send({ type: "navigate-to-note", id: note.id });
    location.href = note.page.url;
  }

  // -------------------------------------------------------------------------
  // pins

  const pinItems = new Map();

  function renderPins() {
    pinsLayer.replaceChildren();
    pinItems.clear();
    for (const note of state.notes) {
      if (!onThisPage(note)) continue;
      if (note.status === "resolved" && !state.showResolved) continue;
      const pin = h("button", {
        class: `pin s-${note.status}${state.threadId === note.id ? " active" : ""}`,
        title: `#${note.id} · ${STATUS_TEXT[note.status] || note.status}\n${firstLine(note.thread?.[0]?.text, 120)}`,
        "aria-label": `Note ${note.id}`,
        text: String(note.id),
        onclick: (e) => {
          e.stopPropagation();
          if (state.threadId === note.id) closePop();
          else openThread(note.id);
        },
      });
      pinsLayer.append(pin);
      pinItems.set(note.id, { pin, note, el: null });
    }
    positionPins();
  }

  function positionPins() {
    const used = [];
    for (const item of pinItems.values()) {
      if (item.note.target?.kind === "element" && !item.el?.isConnected) item.el = findTarget(item.note);
      const anchor = item.el ? { el: item.el } : { rect: item.note.target?.rect };
      item.pin.classList.toggle("detached", item.note.target?.kind === "element" && !item.el);
      const r = viewRectOf(anchor);
      if (!r) {
        item.pin.hidden = true;
        continue;
      }
      item.pin.hidden = false;
      let x = Math.round(r.left - 11);
      const y = Math.round(r.top - 11);
      while (used.some(([ux, uy]) => Math.abs(ux - x) < 18 && Math.abs(uy - y) < 18)) x += 20;
      used.push([x, y]);
      item.pin.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  let framePending = false;
  function schedulePosition() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      positionPins();
      if (!pop.hidden) placePop();
      if (state.pick?.current && !state.pick.dragging) {
        showHighlight(state.pick.current.getBoundingClientRect(), label(state.pick.current));
      }
    });
  }

  // -------------------------------------------------------------------------
  // dock

  function renderDock() {
    if (!state.project || !state.settings.dock) {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;
    const counts = state.counts || {};
    const pill = h("button", { class: "pill", title: "Pinnote notes for this project", onclick: () => {
      state.dockOpen = !state.dockOpen;
      renderDock();
    } },
    h("span", { class: "name", text: state.project.name }),
    counts.question ? h("span", { class: "count" }, h("span", { class: "dot s-question" }),
      `${counts.question} question${counts.question > 1 ? "s" : ""}`) : null,
    counts.done ? h("span", { class: "count" }, h("span", { class: "dot s-done" }), `${counts.done} to review`) : null,
    counts.open ? h("span", { class: "count" }, h("span", { class: "dot s-open" }), `${counts.open} open`) : null);

    const children = [];
    if (state.dockOpen) children.push(renderPanel());
    children.push(pill);
    fill(dock, children);
  }

  function renderPanel() {
    const groups = [
      ["To review", state.notes.filter((n) => n.status === "done" || n.status === "question")],
      ["Waiting for Claude", state.notes.filter((n) => n.status === "open")],
    ];
    if (state.showResolved) groups.push(["Resolved", state.notes.filter((n) => n.status === "resolved")]);
    const resolvedToggle = h("input", { type: "checkbox", checked: state.showResolved });
    resolvedToggle.addEventListener("change", () => {
      state.showResolved = resolvedToggle.checked;
      renderAll();
    });
    const sections = [];
    for (const [title, notes] of groups) {
      sections.push(h("h3", { text: `${title} (${notes.length})` }));
      if (!notes.length) sections.push(h("div", { class: "empty", text: "Nothing here" }));
      for (const note of notes) {
        let path = "";
        try {
          path = new URL(note.page.url).pathname;
        } catch {
          path = note.page?.url || "";
        }
        const last = note.thread?.[note.thread.length - 1];
        sections.push(h("button", { class: "item", onclick: () => goToNote(note) },
          h("span", { class: "num" }, h("span", { class: `dot s-${note.status}` }), ` ${note.id}`),
          h("span", { class: "body" },
            h("span", { class: "what", text: firstLine(last?.text || "", 70) }),
            h("span", { class: "where", text: `${onThisPage(note) ? "this page" : path} · ${shortTime(note.updatedAt)}` }))));
      }
    }
    return h("div", { class: "panel" },
      h("div", { class: "row top" },
        h("button", { class: "btn primary", text: "Pin a note", onclick: () => startPick() }),
        h("span", { class: "spacer" }),
        h("label", { class: "check" }, resolvedToggle, "Show resolved")),
      ...sections);
  }

  function renderAll() {
    renderPins();
    renderDock();
    if (state.threadId !== null && popKind === "thread") {
      const note = noteById(state.threadId);
      if (note) renderThread(note);
      else closePop();
    }
  }

  // -------------------------------------------------------------------------
  // polling

  let refreshing = false;
  let firstRefresh = true;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const first = firstRefresh;
      firstRefresh = false;
      const res = await send({ type: "list", etag: state.etag, first });
      if (!res) return;
      if (!res.ok) {
        if (first) toast(`Pinnote: ${res.error}`, 6000);
        return;
      }
      if (!res.project) {
        teardown();
        return;
      }
      state.project = res.project;
      if (!res.unchanged) {
        state.notes = res.notes || [];
        state.counts = res.counts;
        state.etag = res.etag;
        renderAll();
      }
      if (res.openNote !== undefined && res.openNote !== null) {
        const note = noteById(res.openNote);
        if (note) goToNote(note);
      }
    } finally {
      refreshing = false;
    }
  }

  function tick() {
    const route = routeKey(location.href);
    if (route !== state.route) {
      state.route = route;
      if (popKind === "thread") closePop();
      renderPins();
    }
    if (document.visibilityState === "visible" && state.mode !== "picking") refresh();
  }

  // -------------------------------------------------------------------------
  // wiring

  const timers = [setInterval(tick, POLL_MS), setInterval(schedulePosition, 1000)];

  const onScroll = () => schedulePosition();
  const onVisibility = () => {
    if (document.visibilityState === "visible") refresh();
  };
  const onContextMenu = (e) => {
    if (!e.composedPath().includes(hostEl) && e.target instanceof Element) state.lastContextTarget = e.target;
  };
  const onOutsidePointer = (e) => {
    if (popKind === "thread" && !e.composedPath().includes(hostEl)) closePop();
  };
  const onStorage = (changes, area) => {
    if (area === "local" && changes.settings) {
      state.settings = { dock: true, ...changes.settings.newValue };
      renderDock();
    }
  };
  const onMessage = (msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "pick":
        startPick(false);
        break;
      case "menu":
        if (msg.what === "area") startPick(true);
        else if (state.lastContextTarget?.isConnected && !msg.inFrame) {
          if (state.mode === "picking") stopPick();
          if (popKind === "compose") {
            toast("Finish or cancel the open note first");
            break;
          }
          closePop();
          finishElement(state.lastContextTarget);
        } else startPick(false);
        break;
      case "open-note": {
        const note = noteById(msg.id);
        if (note) goToNote(note);
        else {
          state.etag = null;
          refresh().then(() => noteById(msg.id) && goToNote(noteById(msg.id)));
        }
        break;
      }
      default:
        break;
    }
    sendResponse({ ok: true });
    return false;
  };

  addEventListener("scroll", onScroll, { capture: true, passive: true });
  addEventListener("resize", onScroll, { passive: true });
  addEventListener("pointerdown", onOutsidePointer, true);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("contextmenu", onContextMenu, true);
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);

  function teardown() {
    timers.forEach(clearInterval);
    if (state.pick) stopPick();
    removeEventListener("scroll", onScroll, { capture: true });
    removeEventListener("resize", onScroll);
    removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("contextmenu", onContextMenu, true);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      // extension context already gone
    }
    hostEl.remove();
    globalThis.__pinnoteActive = false;
  }

  (async () => {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      state.settings = { dock: true, ...settings };
    } catch {
      // keep defaults
    }
    refresh();
  })();
})();
