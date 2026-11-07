import os
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
