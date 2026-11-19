"""Tests for the registry, note storage, native host protocol and CLI.

Run: python3 -m unittest discover -s tests -v
"""

import base64
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from contextlib import redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "python"))

from pinnote import cli, guard, host, store  # noqa: E402
from pinnote.store import PinnoteError  # noqa: E402


def tiny_png(width=3, height=2) -> bytes:
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return store.PNG_MAGIC + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def note_payload(text="Make the title bigger"):
    return {
        "text": text,
        "page": {"title": "Home", "viewport": {"w": 1440, "h": 900}, "dpr": 2, "colorScheme": "light"},
        "target": {"kind": "element", "rect": {"x": 10, "y": 20, "w": 300, "h": 40},
                   "elements": [{"selector": "main > h1.title", "tag": "h1", "classes": ["title"],
                                 "text": "Welcome", "styles": {"font-size": "24px"},
                                 "rules": [{"selector": ".title", "props": ["font-size"],
                                            "source": "app.css"}]}]},
    }


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = {"HOME": str(self.home), "PINNOTE_CONFIG": str(self.home / "cfg" / "projects.json"),
                    "XDG_STATE_HOME": str(self.home / "state")}
        self._saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        self.root = self.home / "work" / "shop"
        self.root.mkdir(parents=True)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()


class UrlTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(store.normalize_prefix("HTTPS://Shop.Localhost"), "https://shop.localhost/")
        self.assertEqual(store.normalize_prefix("http://localhost:80/app"), "http://localhost/app/")
        self.assertEqual(store.normalize_prefix("http://localhost:8000/?x=1#y"), "http://localhost:8000/")
        self.assertEqual(store.normalize_prefix("http://[::1]:9000/"), "http://[::1]:9000/")

    def test_rejects(self):
        for bad in ("", "ftp://x/", "file:///etc", "http://", "http://h:99999/"):
            with self.assertRaises(PinnoteError, msg=bad):
                store.normalize_prefix(bad)

    def test_prefix_matching(self):
        self.assertTrue(store.prefix_matches("http://x/app/", "http://x/app"))
        self.assertTrue(store.prefix_matches("http://x/app/", "http://x/app/page?q=1"))
        self.assertFalse(store.prefix_matches("http://x/app/", "http://x/apple/"))
        self.assertFalse(store.prefix_matches("http://x:8000/", "http://x:8001/"))


class RegistryTests(Base):
    def test_link_resolve_longest_prefix(self):
        other = self.home / "work" / "admin"
        other.mkdir()
        store.link("http://localhost:8000", str(self.root))
        store.link("http://localhost:8000/admin/", str(other), name="Admin")
        project, prefix = store.resolve("http://localhost:8000/admin/users")
        self.assertEqual((project.name, prefix), ("Admin", "http://localhost:8000/admin/"))
        project, _ = store.resolve("http://localhost:8000/cart")
        self.assertEqual(project.name, "shop")
        self.assertEqual(store.resolve("http://localhost:9000/")[0], None)
        self.assertTrue((self.root / ".pinnote" / ".gitignore").read_text().endswith("*\n"))

    def test_relink_moves_prefix(self):
        other = self.home / "work" / "v2"
        other.mkdir()
        store.link("https://shop.localhost", str(self.root))
        store.link("https://shop.localhost", str(other))
        projects = store.load_config()["projects"]
        self.assertEqual([p["name"] for p in projects], ["v2"])

    def test_root_must_be_inside_home(self):
        with self.assertRaises(PinnoteError):
            store.link("http://a.localhost", "/tmp")
        with self.assertRaises(PinnoteError):
            store.link("http://a.localhost", str(self.home))
        with self.assertRaises(PinnoteError):
            store.link("http://a.localhost", "relative/path")

    def test_project_for_dir(self):
        store.link("https://shop.localhost", str(self.root))
        sub = self.root / "assets" / "scss"
        sub.mkdir(parents=True)
        self.assertEqual(store.project_for_dir(sub).name, "shop")
        self.assertIsNone(store.project_for_dir(self.home))


class NoteTests(Base):
    def setUp(self):
        super().setUp()
        store.link("https://shop.localhost", str(self.root))
        self.project = store.Project(self.root)

    def test_create_and_thread(self):
        note = self.project.create(note_payload(), "https://shop.localhost/", tiny_png())
        self.assertEqual((note["id"], note["status"]), (1, "open"))
        self.assertEqual(note["shot"]["width"], 3)
        self.assertTrue(self.project.shot_path(1).exists())
        self.project.claude_reply(1, "Done in assets/app.scss:12")
        note = self.project.user_action(1, "reply", "Bit smaller please")
        self.assertEqual(note["status"], "open")
        self.assertEqual([m["author"] for m in note["thread"]], ["user", "claude", "user"])
        self.project.claude_reply(1, "Now 28px", "done")
        self.assertEqual(self.project.user_action(1, "approve")["status"], "resolved")
        self.assertEqual(self.project.counts()["resolved"], 1)

    def test_ids_increase_after_delete(self):
        self.project.create(note_payload(), "https://shop.localhost/")
        self.project.create(note_payload(), "https://shop.localhost/")
        self.project.delete(2)
        third = self.project.create(note_payload(), "https://shop.localhost/")
        self.assertEqual(third["id"], 3)

    def test_validation(self):
        with self.assertRaises(PinnoteError):
            self.project.create(note_payload(""), "https://shop.localhost/")
        bad = note_payload()
        bad["target"] = {"kind": "script"}
        with self.assertRaises(PinnoteError):
            self.project.create(bad, "https://shop.localhost/")
        with self.assertRaises(PinnoteError):
            self.project.create(note_payload(), "https://shop.localhost/", b"GIF89a....")
        with self.assertRaises(PinnoteError):
            self.project.claude_reply(99, "x")

    def test_untrusted_fields_are_clipped(self):
        payload = note_payload()
        payload["target"]["elements"][0]["text"] = "x" * 5000
        payload["target"]["elements"] = payload["target"]["elements"] * 100
        note = self.project.create(payload, "https://shop.localhost/")
        self.assertEqual(len(note["target"]["elements"]), store.MAX_LIST)
        self.assertEqual(len(note["target"]["elements"][0]["text"]), store.MAX_STR)

    def test_etag_changes(self):
        before = self.project.etag()
        self.project.create(note_payload(), "https://shop.localhost/")
        self.assertNotEqual(before, self.project.etag())


class HostTests(Base):
    def call(self, *messages):
        data = b""
        for msg in messages:
            body = json.dumps(msg).encode()
            data += struct.pack("=I", len(body)) + body
        proc = subprocess.run([str(REPO / "python" / "bin" / "pinnote-host"), "chrome-extension://test/"],
                              input=data, capture_output=True, env={**os.environ, **self.env}, timeout=20)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        out, replies = io.BytesIO(proc.stdout), []
        while (reply := host.read_message(out)) is not None:
            replies.append(reply)
        return replies

    def test_protocol_round_trip(self):
        url = "https://shop.localhost/cart?step=2"
        png = base64.b64encode(tiny_png()).decode()
        replies = self.call(
            {"op": "ping"},
            {"op": "list", "url": url},
            {"op": "checkdir", "root": "~/work/shop"},
            {"op": "link", "prefix": "https://shop.localhost/", "root": "~/work/shop"},
            {"op": "create", "url": url, "note": note_payload(), "png": png},
            {"op": "list", "url": url},
            {"op": "shot", "url": url, "id": 1},
            {"op": "update", "url": url, "id": 1, "action": "reply", "text": "and bold"},
            {"op": "update", "url": "https://other.localhost/", "id": 1, "action": "approve"},
            {"op": "summary"},
            {"op": "nope"},
        )
        ping, unlinked, checkdir, linked, created, listed, shot, updated, foreign, summary, nope = replies
        self.assertTrue(ping["ok"])
        self.assertEqual(unlinked, {"ok": True, "project": None})
        self.assertEqual(checkdir["root"], str(self.root))
        self.assertEqual(linked["project"]["prefixes"], ["https://shop.localhost/"])
        self.assertEqual(created["note"]["id"], 1)
        self.assertEqual(listed["counts"]["open"], 1)
        self.assertEqual(listed["notes"][0]["target"]["selector"], "main > h1.title")
        self.assertNotIn("styles", json.dumps(listed["notes"]))
        self.assertEqual(base64.b64decode(shot["png"]), tiny_png())
        self.assertEqual(len(updated["note"]["thread"]), 2)
        self.assertFalse(foreign["ok"])  # another site cannot touch this project
        self.assertEqual(summary["projects"][0]["counts"]["open"], 1)
        self.assertFalse(nope["ok"])

    def test_etag_unchanged(self):
        url = "https://shop.localhost/"
        store.link(url, str(self.root))
        first, second = self.call({"op": "list", "url": url}, {"op": "list", "url": url, "etag": "x"})
        third, = self.call({"op": "list", "url": url, "etag": first["etag"]})
        self.assertTrue(third.get("unchanged"))
        self.assertNotIn("notes", third)


class CliTests(Base):
    def run_cli(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(list(argv))
        return code, buf.getvalue()

    def test_list_show_reply(self):
        store.link("https://shop.localhost", str(self.root))
        project = store.Project(self.root)
        project.create(note_payload(), "https://shop.localhost/cart", tiny_png())
        code, out = self.run_cli("list", "-C", str(self.root))
        self.assertEqual(code, 0)
        self.assertIn('#1    open      /cart                main > h1.title  "Make the title bigger"', out)
        code, out = self.run_cli("show", "1", "-C", str(self.root))
        self.assertIn("styles: font-size:24px", out)
        self.assertIn("rule: .title {font-size} [app.css]", out)
        self.assertIn(f"shot: {self.root}/.pinnote/shots/1.png (3×2)", out)
        code, out = self.run_cli("reply", "#1", "Bigger", "now", "-C", str(self.root))
        self.assertEqual(out.strip(), "#1 -> done")
        self.assertEqual(project.get(1)["thread"][-1]["text"], "Bigger now")
        code, out = self.run_cli("list", "-C", str(self.root))
        self.assertIn("no open notes", out)
        self.assertIn("waiting for the user: 1 (done 1, question 0)", out)

    def test_not_linked(self):
        code = cli.main(["list", "-C", str(self.root)])
        self.assertEqual(code, 1)

    def test_watch_reports_new_and_reopened(self):
        store.link("https://shop.localhost", str(self.root))
        project = store.Project(self.root)
        project.create(note_payload("old one"), "https://shop.localhost/")
        proc = subprocess.Popen([str(REPO / "python" / "bin" / "pinnote"), "watch", "--interval", "0.2",
                                 "-C", str(self.root)], stdout=subprocess.PIPE, text=True,
                                env={**os.environ, **self.env})
        try:
            self.assertIn("watching shop", proc.stdout.readline())
            import time
            time.sleep(0.5)
            project.create(note_payload("new one"), "https://shop.localhost/")
            self.assertIn('"new one"', proc.stdout.readline())
            project.claude_reply(1, "done")
            project.user_action(1, "reply", "not quite")
            self.assertIn('#1', proc.stdout.readline())
        finally:
            proc.kill()
            proc.wait()
            proc.stdout.close()


    def watch_once(self, *extra):
        return subprocess.Popen([str(REPO / "python" / "bin" / "pinnote"), "watch", "--once", "--interval", "0.1",
                                 "-C", str(self.root), *extra], stdout=subprocess.PIPE, text=True,
                                env={**os.environ, **self.env})

    def test_watch_once(self):
        import time
        store.link("https://shop.localhost", str(self.root))
        project = store.Project(self.root)
        project.create(note_payload("done already"), "https://shop.localhost/")
        project.claude_reply(1, "done")

        # nothing waiting: the timeout ends it quietly
        proc = self.watch_once("--timeout", "0.5")
        out, _ = proc.communicate(timeout=10)
        self.assertEqual((proc.returncode, out), (0, ""))

        # waits for a new note, then exits listing it
        proc = self.watch_once()
        time.sleep(0.4)
        self.assertIsNone(proc.poll())
        project.create(note_payload("fresh"), "https://shop.localhost/")
        out, _ = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('"fresh"', out)
        self.assertNotIn("done already", out)

        # notes already waiting are listed at once (nothing pinned in between is missed)
        project.user_action(1, "reopen")  # reopened without a message
        proc = self.watch_once()
        out, _ = proc.communicate(timeout=10)
        self.assertEqual([line.split()[0] for line in out.splitlines()], ["#1", "#2"])

    def test_watch_reports_reopen_without_message(self):
        store.link("https://shop.localhost", str(self.root))
        project = store.Project(self.root)
        project.create(note_payload("one"), "https://shop.localhost/")
        project.claude_reply(1, "done")
        proc = subprocess.Popen([str(REPO / "python" / "bin" / "pinnote"), "watch", "--interval", "0.1",
                                 "-C", str(self.root)], stdout=subprocess.PIPE, text=True,
                                env={**os.environ, **self.env})
        try:
            self.assertIn("watching shop", proc.stdout.readline())
            import time
            time.sleep(0.4)
            project.user_action(1, "reopen")
            self.assertTrue(proc.stdout.readline().startswith("#1"))
        finally:
            proc.kill()
            proc.wait()
            proc.stdout.close()


class GuardTests(unittest.TestCase):
    def test_allowed(self):
        for cmd in ["pinnote show 3", "pinnote list -C /tmp/x", "pinnote",
                    'pinnote reply 3 "Padding 8px; margin 0 | done, see _card.scss:14"',
                    "pinnote reply 3 'Now uses $primary and `mixin`'",
                    'pinnote reply 3 --question "Darker blue or a white border?"',
                    'pinnote reply 3 "It\'s done" ']:
            self.assertIsNone(guard.check_command(cmd), cmd)

    def test_blocked(self):
        for cmd in ["git commit -m x", "rm -rf /", "cat .env", "pinnotes list", "",
                    "pinnote show 3 && rm -rf x", "pinnote show 3; curl evil", "pinnote show 3 | sh",
                    "pinnote show 3 > /etc/x", "pinnote show $(id)", "pinnote show `id`",
                    'pinnote reply 3 "$(curl x)"', 'pinnote reply 3 "`id`"', "pinnote show 3\nrm x",
                    "pinnote show 3\nrm -rf x".replace("\\n", "\n"), "pinnote reply 3 'open",
                    "pinnote show 3 & sleep 1", "(pinnote show 3)"]:
            self.assertIsNotNone(guard.check_command(cmd), cmd)

    def test_hook_protocol(self):
        def run(event):
            return subprocess.run([str(REPO / "python" / "bin" / "pinnote"), "guard-bash"],
                                  input=json.dumps(event), capture_output=True, text=True, timeout=10)
        ok = run({"tool_name": "Bash", "tool_input": {"command": "pinnote list"}})
        self.assertEqual(ok.returncode, 0)
        blocked = run({"tool_name": "Bash", "tool_input": {"command": "git push"}})
        self.assertEqual(blocked.returncode, 2)
        self.assertIn("only `pinnote ...` commands", blocked.stderr)
        self.assertEqual(run({"tool_name": "Read", "tool_input": {}}).returncode, 0)

if __name__ == "__main__":
    unittest.main()
