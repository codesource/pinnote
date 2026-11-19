"""Project registry and note storage.

The registry (~/.config/pinnote/projects.json) maps URL prefixes of dev sites
to project folders. Notes live in each project, in <root>/.pinnote/:

    notes/<id>.json   one file per note, written atomically
    shots/<id>.png    optional cropped screenshot
    counter           last id handed out
    .lock             flock target for read-modify-write
    .gitignore        "*", so the folder never ends up in git

The native host (browser side) and the CLI (Claude side) both go through this
module, so every write takes the same lock.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import math
import os
import struct
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

DATA_DIR = ".pinnote"
STATUSES = ("open", "question", "done", "resolved")
CLAUDE_STATUSES = ("done", "question")
USER_ACTIONS = ("reply", "approve", "reopen")
DEFAULT_PORTS = {"http": 80, "https": 443}

MAX_NOTE_TEXT = 10_000
MAX_SHOT_BYTES = 8 * 1024 * 1024
MAX_STR = 600
MAX_LIST = 24
MAX_KEYS = 48
MAX_DEPTH = 6
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class PinnoteError(Exception):
    """An error whose message is meant for the user."""


# --------------------------------------------------------------------------
# helpers


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def config_path() -> Path:
    env = os.environ.get("PINNOTE_CONFIG")
    if env:
        return Path(env).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "pinnote" / "projects.json"


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def write_json(path: Path, obj) -> None:
    atomic_write(path, (json.dumps(obj, ensure_ascii=False, indent=1) + "\n").encode())


@contextlib.contextmanager
def locked(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def clip(value, depth: int = 0):
    """Bound the size of untrusted JSON coming from the page."""
    if depth > MAX_DEPTH:
        return None
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value[:MAX_STR]
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return round(value, 3) if math.isfinite(value) else None
    if isinstance(value, list):
        return [clip(v, depth + 1) for v in value[:MAX_LIST]]
    if isinstance(value, dict):
        return {str(k)[:80]: clip(v, depth + 1) for k, v in list(value.items())[:MAX_KEYS]}
    return None


def png_size(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or not data.startswith(PNG_MAGIC) or data[12:16] != b"IHDR":
        raise PinnoteError("the screenshot is not a PNG image")
    return struct.unpack(">II", data[16:24])


# --------------------------------------------------------------------------
# URLs


def normalize_url(url: str) -> str:
    """scheme://host[:port]/path, lowercase host, default port and query dropped."""
    if not isinstance(url, str) or not url.strip():
        raise PinnoteError("missing URL")
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme not in DEFAULT_PORTS:
        raise PinnoteError(f"only http and https URLs are supported, not {url!r}")
    host = (parts.hostname or "").lower()
    if not host:
        raise PinnoteError(f"no host in {url!r}")
    try:
        port = parts.port
    except ValueError as exc:
        raise PinnoteError(f"invalid port in {url!r}") from exc
    netloc = f"[{host}]" if ":" in host else host
    if port and port != DEFAULT_PORTS[scheme]:
        netloc += f":{port}"
    return f"{scheme}://{netloc}{parts.path or '/'}"


def normalize_prefix(url: str) -> str:
    norm = normalize_url(url)
    return norm if norm.endswith("/") else norm + "/"


def prefix_matches(prefix: str, url: str) -> bool:
    norm = normalize_url(url)
    candidate = norm if norm.endswith("/") else norm + "/"
    return candidate.startswith(prefix)


# --------------------------------------------------------------------------
# registry


def _empty_config() -> dict:
    return {"version": 1, "projects": []}


def load_config() -> dict:
    path = config_path()
    try:
        cfg = json.loads(path.read_text())
    except FileNotFoundError:
        return _empty_config()
    except (OSError, ValueError) as exc:
        raise PinnoteError(f"cannot read {path}: {exc}") from exc
    if not isinstance(cfg, dict) or not isinstance(cfg.get("projects"), list):
        raise PinnoteError(f"{path} has an unexpected format")
    projects = []
    for p in cfg["projects"]:
        if isinstance(p, dict) and isinstance(p.get("root"), str):
            prefixes = [x for x in p.get("prefixes", []) if isinstance(x, str)]
            projects.append({"name": str(p.get("name") or Path(p["root"]).name),
                             "root": p["root"], "prefixes": prefixes})
    return {"version": 1, "projects": projects}


@contextlib.contextmanager
def editing_config():
    path = config_path()
    with locked(path.with_name(path.name + ".lock")):
        cfg = load_config()
        yield cfg
        write_json(path, cfg)


def check_root(root: str) -> Path:
    if not isinstance(root, str) or not root.strip():
        raise PinnoteError("enter the project folder")
    path = Path(root.strip()).expanduser()
    if not path.is_absolute():
        raise PinnoteError("use an absolute path (or one starting with ~)")
    path = path.resolve()
    home = Path.home().resolve()
    if not path.is_dir():
        raise PinnoteError(f"{path} is not a folder")
    if path == home or home not in path.parents:
        raise PinnoteError(f"the project folder must be inside {home}")
    return path


def link(prefix_url: str, root: str, name: str | None = None) -> dict:
    prefix = normalize_prefix(prefix_url)
    root_path = check_root(root)
    with editing_config() as cfg:
        for p in cfg["projects"]:
            if prefix in p["prefixes"]:
                p["prefixes"].remove(prefix)
        project = next((p for p in cfg["projects"] if p["root"] == str(root_path)), None)
        if project is None:
            project = {"name": name or root_path.name, "root": str(root_path), "prefixes": []}
            cfg["projects"].append(project)
        elif name:
            project["name"] = name
        project["prefixes"].append(prefix)
        project["prefixes"].sort()
        cfg["projects"] = [p for p in cfg["projects"] if p["prefixes"]]
        cfg["projects"].sort(key=lambda p: p["name"].lower())
    Project(project["root"], project["name"]).ensure()
    return dict(project)


def unlink(prefix_url: str) -> bool:
    prefix = normalize_prefix(prefix_url)
    found = False
    with editing_config() as cfg:
        for p in cfg["projects"]:
            if prefix in p["prefixes"]:
                p["prefixes"].remove(prefix)
                found = True
        cfg["projects"] = [p for p in cfg["projects"] if p["prefixes"]]
    return found


def resolve(url: str) -> tuple[Project | None, str | None]:
    """Project whose prefix matches the URL best (longest prefix wins)."""
    best = None
    for p in load_config()["projects"]:
        for prefix in p["prefixes"]:
            if prefix_matches(prefix, url) and (best is None or len(prefix) > len(best[1])):
                best = (p, prefix)
    if best is None:
        return None, None
    return Project(best[0]["root"], best[0]["name"]), best[1]


def project_for_dir(directory: str | os.PathLike) -> Project | None:
    """Linked project whose root contains the directory (deepest root wins)."""
    target = Path(directory).resolve()
    best = None
    for p in load_config()["projects"]:
        root = Path(p["root"])
        if (root == target or root in target.parents) and (
                best is None or len(str(root)) > len(best["root"])):
            best = p
    return Project(best["root"], best["name"]) if best else None


# --------------------------------------------------------------------------
# notes


def last_message(note: dict) -> dict:
    thread = note.get("thread") or []
    return thread[-1] if thread else {}


def last_user_text(note: dict) -> str:
    for msg in reversed(note.get("thread") or []):
        if msg.get("author") == "user":
            return msg.get("text", "")
    return ""


class Project:
    def __init__(self, root: str | os.PathLike, name: str | None = None):
        self.root = Path(root)
        self.name = name or self.root.name
        self.dir = self.root / DATA_DIR
        self.notes_dir = self.dir / "notes"
        self.shots_dir = self.dir / "shots"

    def info(self, prefix: str | None = None) -> dict:
        data = {"name": self.name, "root": str(self.root)}
        if prefix:
            data["prefix"] = prefix
        return data

    def ensure(self) -> None:
        self.notes_dir.mkdir(parents=True, exist_ok=True)
        self.shots_dir.mkdir(exist_ok=True)
        ignore = self.dir / ".gitignore"
        if not ignore.exists():
            atomic_write(ignore, b"# Pinnote notes and screenshots stay local\n*\n")

    def lock(self):
        return locked(self.dir / ".lock")

    def note_path(self, nid: int) -> Path:
        return self.notes_dir / f"{int(nid)}.json"

    def shot_path(self, nid: int) -> Path:
        return self.shots_dir / f"{int(nid)}.png"

    # reading -------------------------------------------------------------

    def etag(self) -> str:
        try:
            entries = sorted(
                (e.name, e.stat().st_mtime_ns, e.stat().st_size)
                for e in os.scandir(self.notes_dir) if e.name.endswith(".json"))
        except FileNotFoundError:
            return "empty"
        return hashlib.sha1(repr(entries).encode()).hexdigest()[:16]

    def get(self, nid) -> dict:
        try:
            nid = int(nid)
        except (TypeError, ValueError) as exc:
            raise PinnoteError(f"invalid note id {nid!r}") from exc
        try:
            return json.loads(self.note_path(nid).read_text())
        except FileNotFoundError as exc:
            raise PinnoteError(f"note #{nid} does not exist in {self.name}") from exc

    def notes(self) -> list[dict]:
        result = []
        try:
            entries = list(os.scandir(self.notes_dir))
        except FileNotFoundError:
            return result
        for entry in entries:
            stem = entry.name[:-5]
            if not entry.name.endswith(".json") or not stem.isdigit():
                continue
            try:
                result.append(json.loads(Path(entry.path).read_text()))
            except (OSError, ValueError):
                continue  # a half-written file cannot happen (atomic writes); skip foreign junk
        result.sort(key=lambda n: n.get("id", 0))
        return result

    def counts(self, notes: list[dict] | None = None) -> dict:
        counts = dict.fromkeys(STATUSES, 0)
        for n in self.notes() if notes is None else notes:
            if n.get("status") in counts:
                counts[n["status"]] += 1
        return counts

    def shot(self, nid) -> bytes:
        note = self.get(nid)
        if not note.get("shot"):
            raise PinnoteError(f"note #{note['id']} has no screenshot")
        return self.shot_path(note["id"]).read_bytes()

    # writing -------------------------------------------------------------

    def _next_id(self) -> int:
        counter = self.dir / "counter"
        try:
            last = int(counter.read_text().strip() or 0)
        except (FileNotFoundError, ValueError):
            last = 0
        existing = [int(p.stem) for p in self.notes_dir.glob("*.json") if p.stem.isdigit()]
        nid = max([last, *existing]) + 1
        atomic_write(counter, f"{nid}\n".encode())
        return nid

    def create(self, payload: dict, page_url: str, shot_png: bytes | None = None) -> dict:
        if not isinstance(payload, dict):
            raise PinnoteError("invalid note")
        text = str(payload.get("text") or "").strip()
        if not text:
            raise PinnoteError("the note is empty")
        if len(text) > MAX_NOTE_TEXT:
            raise PinnoteError(f"the note is longer than {MAX_NOTE_TEXT} characters")
        target = payload.get("target")
        if not isinstance(target, dict) or target.get("kind") not in ("element", "area"):
            raise PinnoteError("the note has no target element or area")
        page = payload.get("page") if isinstance(payload.get("page"), dict) else {}
        shot_meta = None
        if shot_png:
            if len(shot_png) > MAX_SHOT_BYTES:
                raise PinnoteError("the screenshot is too large")
            width, height = png_size(shot_png)
            shot_meta = {"width": width, "height": height,
                         "clipped": bool((payload.get("shot") or {}).get("clipped"))}

        self.ensure()
        with self.lock():
            nid = self._next_id()
            now = now_iso()
            note = {
                "id": nid,
                "version": 1,
                "status": "open",
                "createdAt": now,
                "updatedAt": now,
                "page": {**clip(page), "url": str(page_url)[:2000]},
                "target": clip(target),
                "shot": None,
                "thread": [{"author": "user", "text": text, "at": now}],
            }
            if shot_meta:
                atomic_write(self.shot_path(nid), shot_png)
                note["shot"] = {"file": f"{DATA_DIR}/shots/{nid}.png", **shot_meta}
            write_json(self.note_path(nid), note)
        return note

    def _update(self, nid, mutate) -> dict:
        with self.lock():
            note = self.get(nid)
            mutate(note)
            note["updatedAt"] = now_iso()
            write_json(self.note_path(note["id"]), note)
        return note

    def user_action(self, nid, action: str, text: str = "") -> dict:
        if action not in USER_ACTIONS:
            raise PinnoteError(f"unknown action {action!r}")
        text = (text or "").strip()
        if len(text) > MAX_NOTE_TEXT:
            raise PinnoteError("the reply is too long")
        if action == "reply" and not text:
            raise PinnoteError("the reply is empty")

        def mutate(note):
            if text:
                note["thread"].append({"author": "user", "text": text, "at": now_iso()})
            note["status"] = "resolved" if action == "approve" else "open"

        return self._update(nid, mutate)

    def claude_reply(self, nid, text: str, status: str = "done") -> dict:
        if status not in CLAUDE_STATUSES:
            raise PinnoteError(f"status must be one of {', '.join(CLAUDE_STATUSES)}")
        text = (text or "").strip()
        if not text:
            raise PinnoteError("the reply is empty")

        def mutate(note):
            note["thread"].append({"author": "claude", "text": text[:MAX_NOTE_TEXT],
                                   "at": now_iso(), "status": status})
            note["status"] = status

        return self._update(nid, mutate)

    def delete(self, nid) -> None:
        with self.lock():
            note = self.get(nid)
            self.note_path(note["id"]).unlink()
            with contextlib.suppress(FileNotFoundError):
                self.shot_path(note["id"]).unlink()


def brief(note: dict) -> dict:
    """Note without the heavy element details, for the browser."""
    target = note.get("target") or {}
    elements = target.get("elements") if isinstance(target.get("elements"), list) else []
    first = elements[0] if elements and isinstance(elements[0], dict) else {}
    thread = note.get("thread") or []
    if note.get("status") == "resolved" and len(thread) > 2:
        thread = [thread[0], thread[-1]]
    page = note.get("page") or {}
    return {
        "id": note.get("id"),
        "status": note.get("status"),
        "createdAt": note.get("createdAt"),
        "updatedAt": note.get("updatedAt"),
        "page": {"url": page.get("url"), "title": page.get("title")},
        "target": {"kind": target.get("kind"), "rect": target.get("rect"),
                   "selector": first.get("selector"), "count": len(elements)},
        "shot": bool(note.get("shot")),
        "thread": thread,
    }
