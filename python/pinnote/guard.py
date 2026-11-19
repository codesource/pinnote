"""PreToolUse guard for the pinnote-worker agent's Bash tool.

The worker needs Bash only for `pinnote` itself. Claude Code cannot limit an
agent's Bash tool to a command pattern, so this hook does: it allows exactly
one plain `pinnote ...` command and rejects anything that could run something
else (chaining, pipes, redirections, subshells, command substitution).

Quoting is honoured: `;` or `|` inside quotes is just text, and `$` or a
backtick is allowed inside single quotes, where the shell does not expand them
(handy for SCSS variables such as '$primary' in a reply).
"""

from __future__ import annotations

import json
import sys

OPERATORS = set(";&|<>()\n")


def check_command(command) -> str | None:
    """None when the command is allowed, otherwise the reason it is not."""
    if not isinstance(command, str) or not command.strip():
        return "empty command"
    text = command.strip()
    if text != "pinnote" and not text.startswith(("pinnote ", "pinnote\t")):
        return "only `pinnote ...` commands are allowed here; use Read, Grep, Glob and Edit for files"
    state = None  # None, "'" or '"'
    i = 0
    while i < len(text):
        c = text[i]
        if state == "'":
            if c == "'":
                state = None
        elif state == '"':
            if c == "\\":
                i += 1  # \" \$ \` \\ are literal inside double quotes
            elif c == '"':
                state = None
            elif c in "$`":
                return "no $ or backtick inside double quotes; put that text in single quotes instead"
        else:
            if c == "\\":
                i += 1
            elif c in "'\"":
                state = c
            elif c in "$`":
                return "no $ or backtick outside single quotes"
            elif c in OPERATORS:
                return "one plain pinnote command only: no ; & | < > ( ) or line breaks outside quotes"
        i += 1
    if state is not None:
        return "unterminated quote"
    return None


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except ValueError:
        print("pinnote guard: unreadable hook input", file=sys.stderr)
        return 2
    if event.get("tool_name") != "Bash":
        return 0
    reason = check_command((event.get("tool_input") or {}).get("command"))
    if reason:
        print(f"Blocked by the pinnote-worker guard: {reason}.", file=sys.stderr)
        return 2  # exit code 2 blocks the tool call and shows stderr to the agent
    return 0
