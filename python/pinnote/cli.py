"""Command line used by Claude Code (and by you) to work through notes.

Output is plain and compact on purpose: it is read by a model, so every line
costs tokens. Screenshots are only referenced by path; open them when needed.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime
from urllib.parse import urlsplit

from . import VERSION, guard, store
from .store import PinnoteError

STATUS_LABEL = {"open": "open", "question": "question", "done": "done", "resolved": "resolved"}


# --------------------------------------------------------------------------
# formatting


def short_time(iso: str | None) -> str:
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return iso
    today = datetime.now(dt.tzinfo).date()
    return dt.strftime("%H:%M") if dt.date() == today else dt.strftime("%Y-%m-%d %H:%M")


def page_path(note: dict) -> str:
    url = (note.get("page") or {}).get("url") or ""
    parts = urlsplit(url)
    return (parts.path or "/") + (f"?{parts.query}" if parts.query else "")


def one_line(text: str, width: int = 90) -> str:
    line = " ".join((text or "").split())
    return line if len(line) <= width else line[: width - 1] + "…"


def target_label(note: dict) -> str:
    target = note.get("target") or {}
    elements = [e for e in target.get("elements") or [] if isinstance(e, dict)]
    if target.get("kind") == "area":
        rect = target.get("rect") or {}
        count = len(elements)
        return f"area {rect.get('w', '?')}×{rect.get('h', '?')} ({count} element{'' if count == 1 else 's'})"
    return elements[0].get("selector", "?") if elements else "?"


def fmt_styles(styles) -> str:
    if not isinstance(styles, dict) or not styles:
        return ""
    return "; ".join(f"{k}:{v}" for k, v in styles.items())


def fmt_rule(rule: dict) -> str:
    props = ",".join(rule.get("props") or [])
    text = f"{rule.get('selector', '?')} {{{props}}}"
    if rule.get("source"):
        text += f" [{rule['source']}]"
    if rule.get("media"):
        text += f" @{rule['media']}"
    return text


def fmt_element(el: dict, indent: str) -> list[str]:
    lines = []
    tag = el.get("tag", "?")
    classes = "".join(f".{c}" for c in el.get("classes") or [])
    ident = f"#{el['id']}" if el.get("id") else ""
    head = f"{indent}{el.get('selector', '?')}  <{tag}{ident}{classes}>"
    if el.get("text"):
        head += f'  "{one_line(el["text"], 60)}"'
    lines.append(head)
    rect = el.get("rect") or {}
    if rect:
        lines.append(f"{indent}  box: {rect.get('w')}×{rect.get('h')} at {rect.get('x')},{rect.get('y')}")
    attrs = el.get("attrs")
    if isinstance(attrs, dict) and attrs:
        lines.append(f"{indent}  attrs: " + " ".join(f'{k}="{v}"' for k, v in attrs.items()))
    styles = fmt_styles(el.get("styles"))
    if styles:
        lines.append(f"{indent}  styles: {styles}")
    for rule in el.get("rules") or []:
        if isinstance(rule, dict):
            lines.append(f"{indent}  rule: {fmt_rule(rule)}")
    return lines


def fmt_note(project: store.Project, note: dict) -> str:
    page = note.get("page") or {}
    out = [f"#{note['id']} {note.get('status')} · {project.name} · created {short_time(note.get('createdAt'))}"]
    vp = page.get("viewport") or {}
    env = []
    if vp:
        env.append(f"viewport {vp.get('w')}×{vp.get('h')}")
    if page.get("dpr"):
        env.append(f"dpr {page['dpr']}")
    if page.get("colorScheme"):
        env.append(page["colorScheme"])
    out.append(f"page: {page.get('url')}" + (f" ({', '.join(env)})" if env else ""))
    if page.get("title"):
        out.append(f"title: {one_line(page['title'], 80)}")
    if page.get("state"):
        out.append(f"state: {page['state']}")

    target = note.get("target") or {}
    elements = [e for e in target.get("elements") or [] if isinstance(e, dict)]
    if target.get("kind") == "area":
        rect = target.get("rect") or {}
        out.append(f"target: area {rect.get('w')}×{rect.get('h')} at {rect.get('x')},{rect.get('y')}"
                   f", {len(elements)} element(s) inside")
        container = target.get("container")
        if isinstance(container, dict) and container.get("selector"):
            out.append(f"  container: {container['selector']}")
    else:
        out.append("target: element")
    for el in elements:
        out.extend(fmt_element(el, "  "))

    shot = note.get("shot")
    if shot:
        clipped = ", clipped by the viewport" if shot.get("clipped") else ""
        out.append(f"shot: {project.root / shot['file']} ({shot.get('width')}×{shot.get('height')}{clipped})")
    out.append("thread:")
    for msg in note.get("thread") or []:
        who = "claude" if msg.get("author") == "claude" else "user"
        status = f" [{msg['status']}]" if msg.get("status") else ""
        text = (msg.get("text") or "").strip().replace("\n", "\n    ")
        out.append(f"  {who} {short_time(msg.get('at'))}{status}: {text}")
    return "\n".join(out)


def fmt_list_line(note: dict) -> str:
    text = store.last_user_text(note)
    return (f"#{note['id']:<4} {STATUS_LABEL.get(note.get('status'), '?'):<9} "
            f"{page_path(note):<20} {target_label(note)}  \"{one_line(text, 80)}\"")


# --------------------------------------------------------------------------
# commands


def find_project(args) -> store.Project:
    directory = args.project or os.getcwd()
    project = store.project_for_dir(directory)
    if project is None:
        raise PinnoteError(
            f"{os.path.abspath(directory)} is not inside a linked project.\n"
            "Link one with: pinnote link <dev-site-url> <project-folder>")
    return project


def default_root() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, check=True, timeout=5)
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return os.getcwd()


def cmd_link(args) -> int:
    root = args.dir or default_root()
    project = store.link(args.url, os.path.abspath(os.path.expanduser(root)), args.name)
    prefix = store.normalize_prefix(args.url)
    print(f"linked {prefix} -> {project['root']} ({project['name']})")
    print("In Chrome, open the site, click the Pinnote icon and grant access if asked.")
    return 0


def cmd_unlink(args) -> int:
    if store.unlink(args.url):
        print(f"unlinked {store.normalize_prefix(args.url)} (notes stay in the project folder)")
        return 0
    print(f"{store.normalize_prefix(args.url)} was not linked", file=sys.stderr)
    return 1


def cmd_projects(_args) -> int:
    projects = store.load_config()["projects"]
    if not projects:
        print("no linked projects")
        return 0
    for p in projects:
        counts = store.Project(p["root"], p["name"]).counts()
        print(f"{p['name']}  {p['root']}")
        print(f"  sites: {', '.join(p['prefixes'])}")
        print(f"  open {counts['open']} · question {counts['question']} · done {counts['done']}"
              f" · resolved {counts['resolved']}")
    return 0


def cmd_list(args) -> int:
    project = find_project(args)
    notes = project.notes()
    shown = notes if args.all else [n for n in notes if n.get("status") == "open"]
    for note in shown:
        print(fmt_list_line(note))
    counts = project.counts(notes)
    waiting = counts["done"] + counts["question"]
    if not args.all:
        if not shown:
            print(f"no open notes in {project.name}")
        print(f"waiting for the user: {waiting} (done {counts['done']}, question {counts['question']})"
              f" · resolved {counts['resolved']}")
    return 0


def cmd_show(args) -> int:
    project = find_project(args)
    for i, nid in enumerate(args.ids):
        if i:
            print()
        print(fmt_note(project, project.get(nid.lstrip("#"))))
    return 0


def cmd_reply(args) -> int:
    project = find_project(args)
    status = "question" if args.question else "done"
    note = project.claude_reply(args.id.lstrip("#"), " ".join(args.text), status)
    print(f"#{note['id']} -> {status}")
    return 0


def waiting_for_claude(note: dict) -> bool:
    # Claude's replies always set done or question, so "open" means it is Claude's turn,
    # including a note reopened from the page without a new message.
    return note.get("status") == "open"


def cmd_watch(args) -> int:
    project = find_project(args)
    if args.once:
        return watch_once(project, args)
    print(f"watching {project.name} ({project.root}) for open notes", flush=True)
    seen: dict[int, tuple] = {}
    last_etag = None
    first = True
    while True:
        try:
            etag = project.etag()
            if etag != last_etag:
                last_etag = etag
                current = {}
                for note in project.notes():
                    signature = (note.get("status"), len(note.get("thread") or []))
                    current[note["id"]] = signature
                    if not waiting_for_claude(note) or seen.get(note["id"]) == signature:
                        continue
                    if first and not args.existing:
                        continue
                    print(fmt_list_line(note), flush=True)
                seen = current
                first = False
        except Exception as exc:  # noqa: BLE001 - keep watching, but say so
            print(f"pinnote watch error: {exc}", flush=True)
        time.sleep(args.interval)


def watch_once(project: store.Project, args) -> int:
    """Wait until at least one note waits for Claude, print all of them, exit.

    Notes already open count too: whoever runs this handles every listed note
    before starting it again, so nothing pinned in between can be missed.
    """
    deadline = time.monotonic() + args.timeout if args.timeout else None
    last_etag = None
    while deadline is None or time.monotonic() < deadline:
        try:
            etag = project.etag()
            if etag != last_etag:
                last_etag = etag
                waiting = [n for n in project.notes() if waiting_for_claude(n)]
                if waiting:
                    for note in waiting:
                        print(fmt_list_line(note), flush=True)
                    return 0
        except Exception as exc:  # noqa: BLE001 - wake the caller instead of spinning
            print(f"pinnote watch error: {exc}", flush=True)
            return 1
        time.sleep(args.interval)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pinnote", description="Notes pinned on dev-site elements, per project.")
    parser.add_argument("--version", action="version", version=f"pinnote {VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)

    def with_project(p):
        p.add_argument("-C", "--project", metavar="DIR",
                       help="project folder (default: current directory)")
        return p

    p = sub.add_parser("link", help="link a dev-site URL prefix to a project folder")
    p.add_argument("url", help="e.g. https://shop.localhost or http://localhost:8000/app/")
    p.add_argument("dir", nargs="?", help="project folder (default: git root or current folder)")
    p.add_argument("--name", help="display name (default: folder name)")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("unlink", help="remove a URL prefix (notes are kept)")
    p.add_argument("url")
    p.set_defaults(func=cmd_unlink)

    p = sub.add_parser("projects", help="list linked projects with counts")
    p.set_defaults(func=cmd_projects)

    p = with_project(sub.add_parser("list", help="open notes (Claude's queue)"))
    p.add_argument("-a", "--all", action="store_true", help="every note, any status")
    p.set_defaults(func=cmd_list)

    p = with_project(sub.add_parser("show", help="full details of one or more notes"))
    p.add_argument("ids", nargs="+", metavar="ID")
    p.set_defaults(func=cmd_show)

    p = with_project(sub.add_parser("reply", help="answer a note (marks it done)"))
    p.add_argument("id")
    p.add_argument("text", nargs="+")
    p.add_argument("--question", action="store_true",
                   help="ask the user something instead of marking it done")
    p.set_defaults(func=cmd_reply)

    p = with_project(sub.add_parser("watch", help="print a line for each new or reopened note"))
    p.add_argument("--existing", action="store_true", help="also print notes already open")
    p.add_argument("--once", action="store_true",
                   help="exit as soon as notes wait for Claude, after listing all of them")
    p.add_argument("--timeout", type=float, default=0,
                   help="with --once: give up after this many seconds, printing nothing (default: never)")
    p.add_argument("--interval", type=float, default=1.0, help="seconds between checks")
    p.set_defaults(func=cmd_watch)

    p = sub.add_parser("guard-bash", help="PreToolUse hook of the pinnote-worker agent (reads the hook JSON on stdin)")
    p.set_defaults(func=lambda _args: guard.main())
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except PinnoteError as exc:
        print(f"pinnote: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
