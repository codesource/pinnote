// Pinnote service worker: bridge between tabs, popup and the native host.
//
// Trust model: only our own content scripts and popup can message this worker
// (no externally_connectable). The project a request writes to is always
// resolved by the native host from the page URL, never chosen by the page.

const HOST = "ch.codesource.pinnote";
const SCRIPT_ID = "pinnote-content";
const MENU_ELEMENT = "pinnote-element";
const MENU_AREA = "pinnote-area";
const ALARM = "pinnote-poll";
const MENU_CONTEXTS = ["page", "frame", "selection", "link", "editable", "image", "video", "audio"];
const SHOT_MAX_EDGE = 800; // CSS px; keeps a crop around 500 image tokens at most
const SHOT_MARGIN = 16;
const BADGE_COLOR = "#d9480f";

// ---------------------------------------------------------------------------
// native host

async function native(msg) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, msg);
    return res ?? { ok: false, error: "empty answer from the Pinnote host" };
  } catch (err) {
    return { ok: false, hostError: true, error: String(err?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// URL helpers

function originPattern(prefix) {
  const u = new URL(prefix);
  return `${u.protocol}//${u.host}/*`;
}

function prefixPattern(prefix) {
  const u = new URL(prefix);
  return `${u.protocol}//${u.host}${u.pathname}*`;
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// registration of content scripts and context menus for linked, granted sites

let syncChain = Promise.resolve();

function sync() {
  syncChain = syncChain.then(doSync, doSync);
  return syncChain;
}

async function grantedPatterns(projects) {
  const matches = new Set();
  for (const project of projects) {
    for (const prefix of project.prefixes) {
      if (await chrome.permissions.contains({ origins: [originPattern(prefix)] })) {
        matches.add(prefixPattern(prefix));
      }
    }
  }
  return [...matches].sort();
}

async function doSync() {
  const res = await native({ op: "projects" });
  if (!res.ok) {
    await chrome.storage.session.set({ hostError: res.error });
    return res;
  }
  await chrome.storage.session.remove("hostError");
  const matches = await grantedPatterns(res.projects);
  const key = JSON.stringify(matches);
  const { registeredKey } = await chrome.storage.session.get("registeredKey");
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  const upToDate = registeredKey === key && (matches.length ? existing.length === 1 : existing.length === 0);

  if (!upToDate) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    if (matches.length) {
      await chrome.scripting.registerContentScripts([{
        id: SCRIPT_ID, matches, js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true,
      }]);
    }
    await chrome.contextMenus.removeAll();
    if (matches.length) {
      const common = { contexts: MENU_CONTEXTS, documentUrlPatterns: matches };
      chrome.contextMenus.create({ id: MENU_ELEMENT, title: "Pin a note on this element", ...common },
        () => void chrome.runtime.lastError);
      chrome.contextMenus.create({ id: MENU_AREA, title: "Pin a note on an area…", ...common },
        () => void chrome.runtime.lastError);
    }
    await chrome.storage.session.set({ registeredKey: key });
  }
  await chrome.storage.session.set({ projects: res.projects, matches });
  return res;
}

async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}

async function injectOpenTabs() {
  const { matches = [] } = await chrome.storage.session.get("matches");
  if (!matches.length) return;
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(tabs.map((tab) => injectInto(tab.id)));
}

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// screenshot: capture the visible tab, crop to the target, scale to CSS pixels

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function capture(tab, rect, viewport) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    return { ok: false, needsActivation: true, error: String(err?.message || err) };
  }
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / Math.max(1, viewport.w); // device px per CSS px
  const vh = bitmap.height / scale;
  const x0 = Math.max(0, rect.x - SHOT_MARGIN);
  const y0 = Math.max(0, rect.y - SHOT_MARGIN);
  const x1 = Math.min(viewport.w, rect.x + rect.w + SHOT_MARGIN);
  const y1 = Math.min(vh, rect.y + rect.h + SHOT_MARGIN);
  if (x1 - x0 < 4 || y1 - y0 < 4) {
    bitmap.close();
    return { ok: false, error: "the target is outside the visible part of the page" };
  }
  const clipped = rect.x < 0 || rect.y < 0 || rect.x + rect.w > viewport.w || rect.y + rect.h > vh;
  const fit = Math.min(1, SHOT_MAX_EDGE / Math.max(x1 - x0, y1 - y0));
  const width = Math.max(1, Math.round((x1 - x0) * fit));
  const height = Math.max(1, Math.round((y1 - y0) * fit));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, x0 * scale, y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const png = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return { ok: true, png, width, height, clipped };
}

// ---------------------------------------------------------------------------
// badge, pending "open this note after navigation", notifications

async function updateBadge(tabId, res) {
  if (!res?.ok || res.unchanged) return;
  const waiting = res.project ? (res.counts?.done || 0) + (res.counts?.question || 0) : 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: waiting ? String(waiting) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
  } catch {
    // tab closed meanwhile
  }
}

async function takePendingOpen(tabId) {
  const { pendingOpen = {} } = await chrome.storage.session.get("pendingOpen");
  const id = pendingOpen[tabId];
  if (id === undefined) return undefined;
  delete pendingOpen[tabId];
  await chrome.storage.session.set({ pendingOpen });
  return id;
}

async function setPendingOpen(tabId, noteId) {
  const { pendingOpen = {} } = await chrome.storage.session.get("pendingOpen");
  pendingOpen[tabId] = noteId;
  await chrome.storage.session.set({ pendingOpen });
}

async function settings() {
  const { settings: s = {} } = await chrome.storage.local.get("settings");
  return { notifications: true, dock: true, ...s };
}

async function pollSummary() {
  await sync();
  const res = await native({ op: "summary" });
  if (!res.ok) return;
  const { seenReplies } = await chrome.storage.local.get("seenReplies");
  const first = seenReplies === undefined;
  const seen = seenReplies || {};
  const next = {};
  const { notifications } = await settings();
  const targets = {};
  for (const project of res.projects) {
    for (const reply of project.replies) {
      const key = `${project.root}#${reply.id}`;
      next[key] = reply.at;
      if (first || seen[key] === reply.at || !notifications) continue;
      const notificationId = `pinnote:${key}:${reply.at}`;
      targets[notificationId] = { url: reply.url, id: reply.id };
      const verb = reply.status === "question" ? "has a question on" : "answered";
      chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: "icons/128.png",
        title: `${project.name}: Claude ${verb} #${reply.id}`,
        message: reply.text,
        priority: 0,
      }, () => void chrome.runtime.lastError);
    }
  }
  await chrome.storage.local.set({ seenReplies: next });
  if (Object.keys(targets).length) {
    const { notificationTargets = {} } = await chrome.storage.session.get("notificationTargets");
    await chrome.storage.session.set({ notificationTargets: { ...notificationTargets, ...targets } });
  }
}

async function openNoteInTab(url, noteId) {
  let target;
  try {
    const wanted = new URL(url);
    const tabs = await chrome.tabs.query({ url: `${wanted.protocol}//${wanted.host}/*` });
    target = tabs.find((t) => {
      try {
        const u = new URL(t.url);
        return u.pathname === wanted.pathname;
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }
  if (target) {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    if (!(await sendToTab(target.id, { type: "open-note", id: noteId }))) {
      await setPendingOpen(target.id, noteId);
      await chrome.tabs.reload(target.id);
    }
  } else {
    const tab = await chrome.tabs.create({ url });
    await setPendingOpen(tab.id, noteId);
  }
}

// ---------------------------------------------------------------------------
// popup support

async function popupStatus(tabId) {
  const ping = await native({ op: "ping" });
  if (!ping.ok) return { state: "no-host", error: ping.error };
  const base = { settings: await settings() };
  const projectsRes = await native({ op: "projects" });
  base.projects = projectsRes.ok ? projectsRes.projects : [];
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ...base, state: "unsupported" };
  }
  const url = tab.url || "";
  if (!/^https?:\/\//.test(url)) return { ...base, state: "unsupported", url };
  const resolved = await native({ op: "resolve", url });
  if (!resolved.ok) return { ...base, state: "error", error: resolved.error, url };
  if (!resolved.project) {
    return { ...base, state: "unlinked", url, suggestedPrefix: `${new URL(url).origin}/` };
  }
  const pattern = originPattern(resolved.project.prefix);
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  const project = base.projects.find((p) => p.root === resolved.project.root);
  return {
    ...base,
    state: granted ? "linked" : "needs-permission",
    url,
    pattern,
    project: { ...resolved.project, counts: project?.counts },
  };
}

async function unlinkPrefix(prefix) {
  const res = await native({ op: "unlink", prefix });
  if (!res.ok) return res;
  const projects = await native({ op: "projects" });
  const pattern = originPattern(prefix);
  const stillUsed = projects.ok && projects.projects.some(
    (p) => p.prefixes.some((x) => originPattern(x) === pattern));
  if (!stillUsed) {
    try {
      await chrome.permissions.remove({ origins: [pattern] });
    } catch {
      // permission may have been granted as part of a broader one
    }
  }
  await sync();
  return res;
}

// ---------------------------------------------------------------------------
// messages

async function handleMessage(msg, sender) {
  const ownPage = (sender.url || "").startsWith(chrome.runtime.getURL(""));
  const fromPage = Boolean(sender.tab) && sender.frameId === 0 && !ownPage;
  const fromPopup = ownPage; // popup.html, also when opened as a tab
  // Content scripts send location.href (it follows pushState); keep it on the tab's origin.
  const pageUrl = fromPage && sameOrigin(msg.url, sender.url) ? msg.url : sender.url;

  if (fromPage) {
    switch (msg.type) {
      case "list": {
        const res = await native({ op: "list", url: pageUrl, etag: msg.etag });
        await updateBadge(sender.tab.id, res);
        if (res.ok && res.project && msg.first) res.openNote = await takePendingOpen(sender.tab.id);
        if (res.ok && msg.first) res.settings = await settings();
        return res;
      }
      case "create":
        return native({ op: "create", url: pageUrl, note: msg.note, png: msg.png });
      case "update":
        return native({ op: "update", url: pageUrl, id: msg.id, action: msg.action, text: msg.text });
      case "shot":
        return native({ op: "shot", url: pageUrl, id: msg.id });
      case "capture":
        return capture(sender.tab, msg.rect, msg.viewport);
      case "navigate-to-note":
        await setPendingOpen(sender.tab.id, msg.id);
        return { ok: true };
      default:
        return { ok: false, error: `unknown message ${msg.type}` };
    }
  }

  if (fromPopup) {
    switch (msg.type) {
      case "status":
        return popupStatus(msg.tabId);
      case "checkdir":
        return native({ op: "checkdir", root: msg.root });
      case "link": {
        const res = await native({ op: "link", prefix: msg.prefix, root: msg.root });
        if (!res.ok) return res;
        await sync();
        if (await chrome.permissions.contains({ origins: [originPattern(msg.prefix)] })) {
          await injectInto(msg.tabId);
        }
        return res;
      }
      case "unlink":
        return unlinkPrefix(msg.prefix);
      case "granted":
        await sync();
        await injectOpenTabs();
        return { ok: true };
      case "pick":
        return { ok: await sendToTab(msg.tabId, { type: "pick" }) };
      case "settings": {
        const current = await settings();
        const next = { ...current, ...msg.settings };
        await chrome.storage.local.set({ settings: next });
        return { ok: true, settings: next };
      }
      default:
        return { ok: false, error: `unknown message ${msg.type}` };
    }
  }
  return { ok: false, error: "unexpected sender" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return false;
  handleMessage(msg, sender).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

// ---------------------------------------------------------------------------
// browser events

function setup() {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  sync();
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) pollSummary();
});

chrome.permissions.onAdded.addListener(async () => {
  await sync();
  await injectOpenTabs();
});

chrome.permissions.onRemoved.addListener(() => sync());

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "pick") return;
  const target = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!target) return;
  if (!(await sendToTab(target.id, { type: "pick" }))) {
    try {
      await chrome.action.openPopup();
    } catch {
      // no focused window; nothing else to do
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  const what = info.menuItemId === MENU_AREA ? "area" : "element";
  await sendToTab(tab.id, { type: "menu", what, inFrame: info.frameId !== 0 });
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const { notificationTargets = {} } = await chrome.storage.session.get("notificationTargets");
  const target = notificationTargets[notificationId];
  chrome.notifications.clear(notificationId);
  if (target?.url) await openNoteInTab(target.url, target.id);
});
