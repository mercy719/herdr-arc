#!/usr/bin/env python3
"""CPU, memory and SSD of this computer and every connected Herdr machine, for the sidebar's device headers.

Prints {"machines": {"local": {"cpu": 31, "mem": 58, "used_gb": 18.6, "total_gb": 32, "disk": 85, "free_gb": 140}, "cn": {...}}}.
A machine that doesn't answer is left out, so its header just shows nothing.
"""
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

# shortcut: macOS only (ps/sysctl/vm_stat); add a /proc branch if a Linux machine joins.
PROBE = "ps -A -o %cpu=; echo ==; sysctl -n hw.ncpu hw.memsize; echo ==; vm_stat; echo ==; df -k /System/Volumes/Data"
TIMEOUT = 12  # Herdr kills a mod's exec after 30 s


def hc(args):
    hc_bin = shutil.which("hc") or os.path.expanduser("~/.local/bin/hc")
    try:
        p = subprocess.run([hc_bin] + args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=TIMEOUT)
        return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def parse(text):
    """The PROBE output -> stats, or None when it isn't what macOS prints."""
    try:
        cpus, sysctl, vm, df = text.split("==\n")
        # The data volume holds everything but the sealed system; used = size - available, as Finder counts it.
        size_k, avail_k = (int(x) for x in df.splitlines()[-1].split()[1:4:2])
        ncpu, memsize = (int(x) for x in sysctl.split()[:2])
        busy = sum(float(x) for x in cpus.split())
        page = int(vm.split("page size of ")[1].split()[0])
        pages = {}
        for line in vm.splitlines()[1:]:
            name, _, num = line.rpartition(":")
            if num.strip().rstrip(".").isdigit():
                pages[name.strip().strip('"')] = int(num.strip().rstrip("."))
        # What Activity Monitor calls Memory Used: app memory + wired + compressed.
        used = (pages["Pages active"] + pages["Pages wired down"] + pages.get("Pages occupied by compressor", 0)) * page
    except (ValueError, IndexError, KeyError):
        return None
    return {"cpu": min(100, round(busy / ncpu)), "mem": min(100, round(100 * used / memsize)),
            "used_gb": round(used / 2**30, 1), "total_gb": round(memsize / 2**30),
            "disk": round(100 * (size_k - avail_k) / size_k), "free_gb": round(avail_k / 2**20)}


def local():
    try:
        p = subprocess.run(["sh", "-c", PROBE], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=TIMEOUT)
        return parse(p.stdout.decode("utf-8", "replace"))
    except (OSError, subprocess.SubprocessError):
        return None


def remote(name):
    return parse(hc(["exec", "--on", name, "sh", "-c", PROBE]))


def main():
    try:
        listing = json.loads(hc(["ls", "--json"]) or "{}")
    except ValueError:
        listing = {}
    names = [m["name"] for m in listing.get("machines", []) if m.get("state") == "connected"]
    with ThreadPoolExecutor(max_workers=len(names) + 1) as pool:
        jobs = {"local": pool.submit(local), **{n: pool.submit(remote, n) for n in names}}
        out = {k: j.result() for k, j in jobs.items()}
    json.dump({"machines": {k: v for k, v in out.items() if v}}, sys.stdout)
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sample = ("  10.0\n 30.0\n==\n4\n8589934592\n==\nMach Virtual Memory Statistics: (page size of 16384 bytes)\n"
                  "Pages free:  100.\nPages active:  131072.\nPages wired down:  65536.\n"
                  "Pages occupied by compressor:  65536.\n==\nFilesystem 1024-blocks Used Available Capacity\n"
                  "/dev/disk3s5 1000000 700000 200000 78% 1 1 1% /System/Volumes/Data\n")
        got = parse(sample)
        assert got == {"cpu": 10, "mem": 50, "used_gb": 4.0, "total_gb": 8, "disk": 80, "free_gb": 0}, got
        assert parse("garbage") is None
        print("ok")
        sys.exit(0)
    sys.exit(main())
