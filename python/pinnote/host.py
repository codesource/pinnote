"""Chrome native messaging host.

Chrome starts this program on demand and talks to it over stdin/stdout: each
message is a 32-bit length in native byte order followed by UTF-8 JSON.
Only the Pinnote extension may connect (allowed_origins in the host manifest).

Every request is {"op": ..., ...}; every answer is {"ok": true, ...} or
{"ok": false, "error": "..."}. Project-scoped requests carry the page URL,
taken by the extension from the tab itself, and the project is resolved here
from the registry, so a page can never choose where data is written.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import struct
import sys
import traceback
from pathlib import Path

from . import VERSION, store
from .store import PinnoteError

MAX_RESPONSE = 1024 * 1024  # Chrome's limit for host -> extension messages


def log_path() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return Path(base) / "pinnote" / "host.log"


def log(text: str) -> None:
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 512 * 1024:
            path.unlink()
        with open(path, "a") as fh:
            fh.write(f"{store.now_iso()} {text}\n")
    except OSError:
        pass


def ok(**data) -> dict:
    return {"ok": True, **data}


def project_or_none(msg: dict):
    url = msg.get("url")
    try:
        return store.resolve(url)
    except PinnoteError:
        return None, None


def project_list() -> list[dict]:
    result = []
    for p in store.load_config()["projects"]:
        project = store.Project(p["root"], p["name"])
        result.append({**p, "counts": project.counts()})
    return result


def summary() -> list[dict]:
    """Per project: counts and the notes Claude answered, for badges and notifications."""
    result = []
    for p in store.load_config()["projects"]:
        project = store.Project(p["root"], p["name"])
        notes = project.notes()
        replies = []
        for n in notes:
            last = store.last_message(n)
            if n.get("status") in store.CLAUDE_STATUSES and last.get("author") == "claude":
                replies.append({"id": n["id"], "status": n["status"], "at": last.get("at"),
                                "text": last.get("text", "")[:160],
                                "url": (n.get("page") or {}).get("url")})
        result.append({"name": p["name"], "root": p["root"], "prefixes": p["prefixes"],
                       "counts": project.counts(notes), "replies": replies})
    return result


def handle(msg) -> dict:
    if not isinstance(msg, dict):
        return {"ok": False, "error": "invalid request"}
    op = msg.get("op")
    try:
        if op == "ping":
            return ok(version=VERSION, config=str(store.config_path()))
        if op == "projects":
            return ok(projects=project_list())
        if op == "summary":
            return ok(projects=summary())
        if op == "checkdir":
            return ok(root=str(store.check_root(msg.get("root"))))
        if op == "link":
            return ok(project=store.link(msg.get("prefix"), msg.get("root"), msg.get("name")))
        if op == "unlink":
            return ok(removed=store.unlink(msg.get("prefix")))

        project, prefix = project_or_none(msg)
        if op == "resolve":
            return ok(project=project.info(prefix) if project else None)
        if project is None:
            return ok(project=None) if op == "list" else {
                "ok": False, "error": "this page is not linked to a project"}

        if op == "list":
            etag = project.etag()
            info = project.info(prefix)
            if msg.get("etag") == etag:
                return ok(project=info, etag=etag, unchanged=True)
            notes = project.notes()
            return ok(project=info, etag=etag, counts=project.counts(notes),
                      notes=[store.brief(n) for n in notes])
        if op == "create":
            png = None
            if msg.get("png"):
                try:
                    png = base64.b64decode(msg["png"], validate=True)
                except (binascii.Error, TypeError) as exc:
                    raise PinnoteError("the screenshot is not valid base64") from exc
            note = project.create(msg.get("note"), msg.get("url"), png)
            return ok(note=store.brief(note))
        if op == "update":
            action = msg.get("action")
            if action == "delete":
                project.delete(msg.get("id"))
                return ok(deleted=True)
            note = project.user_action(msg.get("id"), action, msg.get("text", ""))
            return ok(note=store.brief(note))
        if op == "shot":
            data = project.shot(msg.get("id"))
            return ok(png=base64.b64encode(data).decode())
        return {"ok": False, "error": f"unknown op {op!r}"}
    except PinnoteError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - report, never crash the host
        log(f"{op}: {traceback.format_exc()}")
        return {"ok": False, "error": f"internal error: {exc}"}


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    body = stream.read(length)
    if len(body) < length:
        return None
    return json.loads(body)


def write_message(stream, obj) -> None:
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
    if len(data) > MAX_RESPONSE:
        data = json.dumps({"ok": False, "error": "response too large"}).encode()
    stream.write(struct.pack("=I", len(data)))
    stream.write(data)
    stream.flush()


def main() -> int:
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        try:
            msg = read_message(stdin)
        except ValueError:
            write_message(stdout, {"ok": False, "error": "invalid JSON"})
            continue
        if msg is None:
            return 0
        write_message(stdout, handle(msg))
