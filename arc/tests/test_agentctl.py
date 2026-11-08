import json
import multiprocessing
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mods", "arc-sidebar"))
import agentctl  # noqa: E402


class KeptFlags(unittest.TestCase):
    def test_keeps_model_and_permissions_drops_resume_and_prompt(self):
        argv = ["claude", "--resume", "abc", "--model", "opus", "--dangerously-skip-permissions",
                "--permission-mode=plan", "fix the bug"]
        self.assertEqual(agentctl.kept_flags(argv),
                         ["--model", "opus", "--dangerously-skip-permissions", "--permission-mode=plan"])

    def test_bare_continue(self):
        self.assertEqual(agentctl.kept_flags(["claude", "-c"]), [])


class ResumeCommand(unittest.TestCase):
    def test_quotes_cwd_and_uses_plain_claude(self):
        rec = {"cwd": "/a b/c", "flags": ["--model", "opus"], "sid": "1fdec523-b2e9-4f07-bc85-beaafd59abca"}
        self.assertEqual(agentctl.resume_command(rec),
                         "cd '/a b/c' && claude --model opus --resume 1fdec523-b2e9-4f07-bc85-beaafd59abca")


def _add(args):
    home, tab = args
    with mock.patch.object(agentctl.agentnow, "home_dir", return_value=home):
        agentctl.update(lambda r: r.__setitem__(tab, {"address": "cn/" + tab}))


class Records(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        p = mock.patch.object(agentctl.agentnow, "home_dir", return_value=self.home)
        p.start()
        self.addCleanup(p.stop)

    def test_ops_at_once_keep_every_record(self):
        # Restarting several rows together runs one process each; none may drop another's record.
        tabs = ["t%d" % i for i in range(16)]
        with multiprocessing.get_context("fork").Pool(8) as pool:
            pool.map(_add, [(self.home, t) for t in tabs])
        self.assertEqual(sorted(agentctl.load()), sorted(tabs))

    def test_restart_resumes_with_the_record_it_made(self):
        rec = {"address": "cn/t1", "sid": "s", "cwd": "/", "flags": []}
        seen = {}
        with mock.patch.object(agentctl, "stop", return_value={"ok": True, "record": rec}), \
                mock.patch.object(agentctl, "resume", side_effect=lambda tab, r=None: seen.update(tab=tab, rec=r) or {"ok": True}), \
                mock.patch("sys.stdout"):
            agentctl.main(["restart", "cn/t1", "tab1"])
        self.assertEqual(seen, {"tab": "tab1", "rec": rec})

    def listing(self, terminals):
        out = json.dumps({"terminals": terminals})
        with mock.patch.object(agentctl.agentnow, "run_hc", return_value=(0, out)):
            return agentctl.listing()

    def test_listing_keeps_a_record_whose_claude_is_still_exiting(self):
        now = int(time.time() * 1000)
        agentctl.save({"a": {"address": "cn/t1", "stopped_ms": now}, "b": {"address": "cn/t2", "stopped_ms": now - 120000}})
        shown = self.listing([{"address": "cn/t1", "agent": "claude-code"}, {"address": "cn/t2", "agent": "claude-code"}])
        self.assertEqual(shown, {})
        self.assertEqual(sorted(agentctl.load()), ["a"])  # fresh one kept, old one (resumed long ago) dropped

    def test_listing_keeps_records_of_a_machine_missing_from_it(self):
        agentctl.save({"a": {"address": "cn/t1", "stopped_ms": 0}, "b": {"address": "t9", "stopped_ms": 0}})
        shown = self.listing([{"address": "t3", "agent": "zsh"}])
        self.assertEqual(shown, {})
        self.assertEqual(sorted(agentctl.load()), ["a"])  # cn absent: kept; local t9 gone: dropped


if __name__ == "__main__":
    unittest.main()
