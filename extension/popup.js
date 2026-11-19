// Pinnote popup: link the current site to a project folder, grant access,
// start pinning, settings. Built with textContent only.

const main = document.getElementById("main");
const projectsEl = document.getElementById("projects");
const settingsEl = document.getElementById("settings");

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

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err?.message || err) }));
}

function originPattern(prefix) {
  const u = new URL(prefix);
  return `${u.protocol}//${u.host}/*`;
}

function counts(c = {}) {
  const items = [
    ["s-done", c.done, "done, to review"],
    ["s-question", c.question, "question"],
    ["s-open", c.open, "waiting for Claude"],
    ["s-resolved", c.resolved, "resolved"],
  ].filter(([, n]) => n);
  if (!items.length) return h("div", { class: "muted small", text: "No notes yet" });
  return h("div", { class: "counts" },
    items.map(([cls, n, text]) => h("span", { class: "count" }, h("span", { class: `dot ${cls}` }), `${n} ${text}`)));
}

let tabId = null;

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  const status = tabId === null ? { state: "unsupported" } : await send({ type: "status", tabId });
  main.replaceChildren(...renderMain(status));
  renderProjects(status);
  renderSettings(status);
}

function renderMain(status) {
  switch (status.state) {
    case "no-host":
      return [
        h("p", { class: "error", text: "The Pinnote helper is not installed or cannot start." }),
        h("p", { class: "small" }, "Run ", h("code", { text: "./install.sh" }),
          " in the Pinnote folder, then reload the extension."),
        h("p", { class: "muted small", text: status.error || "" }),
      ];
    case "unsupported":
      return [h("p", { class: "muted", text: "Open your dev site (http or https) to pin notes on it." })];
    case "error":
      return [h("p", { class: "error", text: status.error })];
    case "unlinked":
      return renderLinkForm(status);
    case "needs-permission":
      return renderGrant(status);
    case "linked":
      return renderLinked(status);
    default:
      return [h("p", { class: "error", text: status.error || "Unexpected answer from Pinnote" })];
  }
}

function renderLinkForm(status) {
  const prefix = h("input", { type: "text", id: "prefix", value: status.suggestedPrefix, spellcheck: "false" });
  const root = h("input", { type: "text", id: "root", list: "roots", placeholder: "~/projects/my-site",
    spellcheck: "false", autocomplete: "off" });
  const roots = h("datalist", { id: "roots" }, (status.projects || []).map((p) => h("option", { value: p.root })));
  const hint = h("div", { class: "hint" });
  const button = h("button", { class: "primary", text: "Link this site", disabled: true });
  let checked = null;
  let timer = 0;

  const check = async () => {
    const value = root.value.trim();
    checked = null;
    button.disabled = true;
    if (!value) {
      hint.className = "hint";
      hint.textContent = "";
      return;
    }
    const res = await send({ type: "checkdir", root: value });
    if (root.value.trim() !== value) return; // typed on meanwhile
    if (res.ok) {
      checked = res.root;
      hint.className = "hint ok";
      hint.textContent = `✓ ${res.root}`;
      button.disabled = false;
    } else {
      hint.className = "hint bad";
      hint.textContent = res.error;
    }
  };
  root.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(check, 250);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !button.disabled) button.click();
  });

  button.addEventListener("click", () => {
    let pattern;
    try {
      pattern = originPattern(prefix.value.trim());
    } catch {
      hint.className = "hint bad";
      hint.textContent = "The site address is not a valid URL";
      return;
    }
    // Ask for access first, inside the click: Chrome may close the popup while
    // its prompt is open, so the worker finishes the linking on its own.
    const permission = chrome.permissions.request({ origins: [pattern] });
    const linking = send({ type: "link", prefix: prefix.value.trim(), root: checked, tabId });
    button.disabled = true;
    Promise.all([permission.catch(() => false), linking]).then(([granted, res]) => {
      if (!res.ok) {
        hint.className = "hint bad";
        hint.textContent = res.error;
        button.disabled = false;
        return;
      }
      if (granted) send({ type: "granted" });
      render();
    });
  });

  return [
    h("p", { text: "This site is not linked to a project yet." }),
    h("label", { for: "prefix", text: "Site (URL prefix)" }),
    prefix,
    h("label", { for: "root", text: "Project folder" }),
    root,
    roots,
    hint,
    h("div", { class: "row" }, h("span", { class: "spacer" }), button),
    h("p", { class: "muted small" },
      "Notes go to ", h("code", { text: ".pinnote/" }), " in that folder (ignored by git). Chrome then asks to let Pinnote run on this site only."),
  ];
}

function renderGrant(status) {
  const button = h("button", { class: "primary", text: "Grant access" });
  button.addEventListener("click", () => {
    chrome.permissions.request({ origins: [status.pattern] })
      .then((granted) => (granted ? send({ type: "granted" }) : null))
      .then(render, render);
  });
  return [
    h("h2", { text: status.project.name }),
    h("p", { class: "muted small" }, h("code", { text: status.project.root })),
    h("p", {}, "Linked, but Chrome still needs your permission to run Pinnote on ",
      h("code", { text: status.pattern }), "."),
    h("div", { class: "row" }, h("span", { class: "spacer" }), button),
  ];
}

function renderLinked(status) {
  const pick = h("button", { class: "primary", text: "Pin a note" });
  pick.addEventListener("click", async () => {
    const res = await send({ type: "pick", tabId });
    if (res.ok) window.close();
    else pick.textContent = "Reload the page first";
  });
  const unlink = h("button", { text: "Unlink site" });
  unlink.addEventListener("click", async () => {
    unlink.disabled = true;
    await send({ type: "unlink", prefix: status.project.prefix });
    render();
  });
  return [
    h("h2", { text: status.project.name }),
    h("p", { class: "muted small" }, h("code", { text: status.project.root })),
    h("p", { class: "muted small" }, "Site: ", h("code", { text: status.project.prefix })),
    counts(status.project.counts),
    h("div", { class: "row" }, unlink, h("span", { class: "spacer" }), pick),
    h("p", { class: "muted small" },
      "Or press Alt+Shift+N on the page, or right-click an element. Click an element to note it, drag to note an area."),
  ];
}

function renderProjects(status) {
  const projects = status.projects || [];
  const others = projects.filter((p) => p.root !== status.project?.root);
  if (!others.length) {
    projectsEl.hidden = true;
    return;
  }
  projectsEl.hidden = false;
  projectsEl.replaceChildren(
    h("h3", { text: "Other projects" }),
    ...others.map((p) => h("div", { class: "project" },
      h("div", { class: "name", text: p.name }),
      h("div", { class: "muted small", text: p.prefixes.join(", ") }),
      counts(p.counts))),
  );
}

function renderSettings(status) {
  if (!status.settings) {
    settingsEl.hidden = true;
    return;
  }
  settingsEl.hidden = false;
  const toggle = (key, text) => {
    const input = h("input", { type: "checkbox", checked: status.settings[key] });
    input.addEventListener("change", () => send({ type: "settings", settings: { [key]: input.checked } }));
    return h("label", { class: "check" }, input, text);
  };
  const shortcuts = h("button", { class: "link small", text: "Change the shortcut" });
  shortcuts.addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  settingsEl.replaceChildren(
    toggle("dock", "Show the Pinnote dock on pages"),
    toggle("notifications", "Notify me when Claude answers a note"),
    h("div", { class: "row" }, h("span", { class: "muted small", text: "Shortcut: Alt+Shift+N" }),
      h("span", { class: "spacer" }), shortcuts),
  );
}

render();
