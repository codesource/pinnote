# Pinnote

Pin notes on elements or areas of your dev sites in Chrome. Claude Code picks them up from the project folder, makes the change and answers on the note; you see the answer on the page and approve it or ask for more. It works with many projects open in many tabs at the same time.

```
Chrome tab ──► content script ──► service worker ──► native host (Python, started by Chrome)
                                                          │
Claude Code ──► pinnote CLI ──────────────────────────────┴──► <project>/.pinnote/
```

## How it works

- Each dev site (a URL prefix such as `https://shop.localhost/` or `http://localhost:8000/admin/`) is linked to one project folder in `~/.config/pinnote/projects.json`. Every tab resolves its own project from its URL, so several projects side by side never mix.
- A note targets an element (click) or an area (drag). It records the page URL, viewport and pixel ratio, a unique CSS selector, classes and a few attributes, a compact set of computed styles, the CSS rules that match (selector, stylesheet, media query) and a cropped screenshot (at most 800 px, about 500 image tokens).
- Notes are files in the project: `.pinnote/notes/<id>.json` and `.pinnote/shots/<id>.png`. The folder carries its own `.gitignore`, so it never ends up in git.
- Status: **open** (waiting for Claude) → **done** (please review) or **question** (Claude asks you) → **resolved** once you approve. A reply reopens the note.

## Install

1. `./install.sh`
   registers the native host for Chrome/Chromium, links `pinnote` into `~/.local/bin` and the skill into `~/.claude/skills/pinnote`.
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → this repo's `extension/` folder.
3. Open your dev site, click the Pinnote icon, enter the project folder, **Link this site**. Chrome asks to let Pinnote run on that site only.

Linking also works from the terminal: `pinnote link https://shop.localhost ~/projects/shop` (then grant access once from the popup).

## Pinning notes

- **Alt+Shift+N** (change it at `chrome://extensions/shortcuts`), **right-click → Pin a note on this element / on an area**, or the toolbar popup.
- Picking: click an element, or drag an area. **↑ / ↓** move to the parent or back to the child, **Enter** selects, **Esc** cancels. Hover states stay visible while you pick, and links or buttons are not triggered.
- Write the note, **Ctrl+Enter** to save.
- Screenshots: Chrome only lets an extension capture a tab after you invoked it there (shortcut, right-click menu or toolbar button). The dock's own "Pin a note" button still works, just without a screenshot unless you used one of those on the page before.

On the page:

- Pins: blue open, orange question, green done, grey resolved (hidden unless "Show resolved"). Click a pin to read the thread, answer, approve, reopen or delete.
- The dock (bottom right) lists the project's notes on every page; a click jumps to the note, also on another page. Hide it from the popup if you prefer.
- The toolbar badge counts the notes waiting for you in this tab's project, and a desktop notification tells you when Claude answers (toggle in the popup).

## In Claude Code

In the project folder:

- `/pinnote`: work through all open notes now.
- `/pinnote watch`: keep watching and handle each note as you pin it.

The skill uses the CLI, which you can use too:

```
pinnote list                      open notes (Claude's queue)
pinnote list -a                   every note
pinnote show 12                   details: target, styles, rules, screenshot path, thread
pinnote reply 12 "Done in ..."    answer and mark done
pinnote reply 12 --question "..." ask instead
pinnote watch                     one line per new or reopened note
pinnote projects                  linked projects and counts
pinnote link URL [DIR]            link a site prefix to a project folder
pinnote unlink URL
```

## Security and privacy

- Pinnote runs only on the sites you link and grant, one by one (optional host permissions). It never asks for access to all sites.
- No network port: Chrome starts the native host on demand, only for this extension's ID (fixed by the `key` in the manifest).
- The host resolves the project from the page URL itself, so a page cannot choose where data is written; project folders must be inside your home folder.
- Values of form fields are never captured. The page UI lives in a closed shadow root and all text is set with `textContent`.

## Development

- Python tests: `python3 -m unittest discover -s tests`
- End-to-end test in headless Chrome with a throwaway profile: `node tests/e2e.mjs [--shots DIR] [--keep]`
- After changing extension files, reload Pinnote at `chrome://extensions`, then reload open pages.
- Host errors are logged to `~/.local/state/pinnote/host.log`.

## Uninstall

`./install.sh --uninstall`, then remove the extension in `chrome://extensions`. Notes in your projects and the registry are kept.
