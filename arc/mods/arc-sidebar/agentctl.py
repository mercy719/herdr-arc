#!/usr/bin/env python3
"""Close, resume and restart the Claude Code agent in a Herdr terminal, keeping the terminal.

  agentctl.py stop <address> <tab>     exit claude; remember its conversation under the tab id
  agentctl.py resume <tab>             start `claude --resume <id>` again in that terminal
  agentctl.py restart <address> <tab>  stop, then resume (a freshly updated claude picks it up)
  agentctl.py list                     {tab: record} for terminals that can be resumed

Prints one JSON object. Runs as `python3 -I -S agentctl.py` (standard library only).
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agentnow  # noqa: E402  (same folder; -I leaves it off sys.path)

EXIT_WAIT_S = 8
# Flags worth carrying into the resumed session; prompts, --resume/--continue and the rest are dropped.
KEEP_FLAGS = {"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--chrome",
              "--no-chrome", "--ide", "--verbose", "--brief"}
KEEP_VALUES = {"--model", "--permission-mode", "--effort", "--settings", "--mcp-config", "--agent",
               "--fallback-model", "--add-dir", "--plugin-dir", "--append-system-prompt"}


def store_path():
    return os.path.join(agentnow.home_dir(), ".cache", "herdr-agent-board", "resume.json")


def load():
    try:
        with open(store_path(), "rb") as f:
            data = json.loads(f.read())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(records):
    path = store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False)
    os.replace(tmp, path)


def kept_flags(argv):
    """The flags of the old command line that a resumed session should keep."""
    out, i = [], 1
    while i < len(argv):
        a = argv[i]
        name = a.split("=", 1)[0]
        if a in KEEP_FLAGS:
            out.append(a)
        elif name in KEEP_VALUES:
            if "=" in a:
                out.append(a)
            elif i + 1 < len(argv):
                out += [a, argv[i + 1]]
                i += 1
        elif name in ("--resume", "-r", "--session-id", "--name", "-n") and "=" not in a and i + 1 < len(argv) \
                and not argv[i + 1].startswith("-"):
            i += 1  # skip its value too
        i += 1
    return out


def resume_command(rec):
    # Plain `claude` so a restart runs whatever version is installed now, not the old binary path.
    words = ["claude"] + rec.get("flags", []) + ["--resume", rec["sid"]]
    return "cd %s && %s" % (shlex.quote(rec["cwd"]), " ".join(shlex.quote(w) for w in words))


def terminal(address):
    code, out = agentnow.run_hc(["get", address, "--json"])
    if code != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def is_claude(info):
    return bool(info) and (info.get("status") or {}).get("app") == "claude-code"


def machine_of(address):
    machine, _, bare = address.partition("/")
    return machine if bare else None


def signal(address, pid, sig):
    machine = machine_of(address)
    if machine:
        agentnow.run_hc(["exec", "--on", machine, "kill", "-" + sig, str(pid)])
    else:
        try:
            os.kill(pid, {"TERM": 15, "KILL": 9}[sig])
        except OSError:
            pass


def gone(address, pid, seconds):
    end = time.time() + seconds
    while time.time() < end:
        info = terminal(address)
        if info is None:
            return True
        if (info.get("foreground") or {}).get("pid") != pid:
            return True
        time.sleep(0.5)
    return False


def stop(address, tab):
    info = terminal(address)
    if not is_claude(info):
        return {"ok": False, "error": "not-claude"}
    fg = info.get("foreground") or {}
    pid = fg.get("pid")
    machine = machine_of(address)
    home = agentnow.machine_home(machine, {}) if machine else agentnow.home_dir()
    text = agentnow.read_text("%s/.claude/sessions/%d.json" % (home, pid), machine) if home and pid else None
    try:
        sess = json.loads(text) if text else {}
    except ValueError:
        sess = {}
    sid = sess.get("sessionId")
    if not isinstance(sid, str) or not agentnow.SESSION_ID.match(sid):
        return {"ok": False, "error": "no-session"}
    rec = {"address": address, "sid": sid, "cwd": sess.get("cwd") or fg.get("cwd") or home,
           "flags": kept_flags(fg.get("argv") or []), "name": (info.get("labels") or {}).get("where"),
           "stopped_ms": int(time.time() * 1000)}
    records = load()
    records[tab] = rec
    save(records)  # remembered before it exits, so a failed exit still leaves a way back
    # A signal, not a typed /exit: `hc send` always wraps text in an <hc from=…> note, which claude reads as a message.
    # claude saves as it goes and exits cleanly on TERM, printing its own resume hint.
    signal(address, pid, "TERM")
    if not gone(address, pid, EXIT_WAIT_S):
        signal(address, pid, "KILL")
        if not gone(address, pid, 3):
            return {"ok": False, "error": "still-running", "record": rec}
    return {"ok": True, "record": rec}


def write_file(path, text, machine):
    if machine:
        try:
            p = subprocess.run([agentnow.hc_bin(), "file", "write", "--on", machine, path], input=text.encode("utf-8"),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=agentnow.HC_TIMEOUT)
            return p.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return True
    except OSError:
        return False


def shell_ready(address, seconds=8):
    """Wait for the shell that replaced claude to settle, so the first keys aren't swallowed while it starts."""
    end = time.time() + seconds
    while time.time() < end:
        info = terminal(address) or {}
        if not is_claude(info) and (info.get("foreground") or {}).get("name"):
            time.sleep(1.5)
            return
        time.sleep(0.5)


def resume(tab):
    records = load()
    rec = records.get(tab)
    if not rec:
        return {"ok": False, "error": "no-record"}
    info = terminal(rec["address"])
    if info is None:
        return {"ok": False, "error": "terminal-gone"}
    if is_claude(info):
        return {"ok": False, "error": "still-running"}
    # Typed as keys: `hc send` would wrap it in an <hc from=…> note the shell can't parse, and `hc keys`
    # only knows letters, digits, space . / - — so the command goes into a file and the shell sources it.
    # Keys type capitals as small letters, so the file sits in lowercase /tmp.
    machine = machine_of(rec["address"])
    path = "/tmp/herdr-resume-%s.sh" % rec["address"].rpartition("/")[2]
    if not re.fullmatch(r"[a-z0-9./-]+", path):
        return {"ok": False, "error": "untypeable-path"}
    shell_ready(rec["address"])
    if not write_file(path, resume_command(rec) + "\n", machine):
        return {"ok": False, "error": "write-failed"}
    code, _ = agentnow.run_hc(["keys", rec["address"]] + [("space" if c == " " else c) for c in ". " + path] + ["enter"])
    if code != 0:
        return {"ok": False, "error": "keys-failed"}
    records.pop(tab, None)
    save(records)
    return {"ok": True}


def listing():
    """Records whose terminal is still there and isn't running claude again."""
    code, out = agentnow.run_hc(["ls", "--json"])
    if code != 0:
        return {}
    try:
        terms = {t.get("address"): t for t in json.loads(out).get("terminals") or []}
    except ValueError:
        return {}
    records = load()
    live = {tab: r for tab, r in records.items()
            if r.get("address") in terms and terms[r["address"]].get("agent") != "claude-code"}
    if live != records:
        save(live)
    return live


def main(argv):
    # Run from inside a terminal, hc tags sent text as a note from that terminal; we type as the person.
    for k in ("HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"):
        os.environ.pop(k, None)
    cmd = argv[0] if argv else ""
    try:
        if cmd == "stop" and len(argv) == 3:
            result = stop(argv[1], argv[2])
        elif cmd == "resume" and len(argv) == 2:
            result = resume(argv[1])
        elif cmd == "restart" and len(argv) == 3:
            result = stop(argv[1], argv[2])
            if result.get("ok"):
                result = resume(argv[2])
        elif cmd == "list":
            result = listing()
        else:
            result = {"ok": False, "error": "usage"}
    except Exception as e:  # the sidebar shows a failed op, never a traceback
        result = {"ok": False, "error": type(e).__name__}
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
