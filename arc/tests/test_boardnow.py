import os
import subprocess
import sys
import unittest

BOARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mods", "arc-board", "boardnow.py")


class BoardSelfCheck(unittest.TestCase):
    def test_self_check(self):
        # boardnow.py carries its own offline self-check (fake transcript, model reply and gh output).
        p = subprocess.run([sys.executable, "-I", "-S", BOARD, "--self-test"], capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        self.assertIn("self-check passed", p.stdout)


if __name__ == "__main__":
    unittest.main()
