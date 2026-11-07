import json
import os
import tempfile
import unittest
from unittest import mock

import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mods", "arc-sidebar"))
import agentnow  # noqa: E402


def line(obj):
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


def user_text(text, meta=False):
    o = {"type": "user", "message": {"role": "user", "content": text}}
    if meta:
        o["isMeta"] = True
    return line(o)


def tool_use(tid, name, inp):
    return line({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": tid, "name": name, "input": inp}]}})


def tool_result(tid, text):
    return line({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tid, "content": text}]}})


class ParseTail(unittest.TestCase):
    def test_user_text_not_tool_result(self):
        data = b"".join([
            user_text("first real ask"),
            tool_use("t1", "Read", {"file_path": "/a/b.py"}),
            tool_result("t1", "file contents"),
            user_text("second real ask"),
        ])
        out = agentnow.parse_tail(data, False)
        self.assertEqual(out["last_prompt"], "second real ask")

    def test_tool_result_only_leaves_prompt(self):
        data = b"".join([user_text("the ask"), tool_use("t1", "Bash", {"command": "ls"}),
                         tool_result("t1", "a\nb")])
        self.assertEqual(agentnow.parse_tail(data, False)["last_prompt"], "the ask")

    def test_half_first_line_dropped(self):
        full = b"".join([user_text("dropped"), user_text("kept")])
        out = agentnow.parse_tail(full, truncated=True)
        self.assertEqual(out["last_prompt"], "kept")
        same = agentnow.parse_tail(full, truncated=False)
        self.assertEqual(same["last_prompt"], "kept")

    def test_tool_args_shortened_and_last_six(self):
        data = b"".join([tool_use("x%d" % i, "Bash", {"command": "c" * 200}) for i in range(8)])
        tools = agentnow.parse_tail(data, True)["tools"]
        self.assertEqual(len(tools), 6)
        self.assertEqual(tools[0][0], "Bash")
        self.assertEqual(len(tools[0][1]), 80)

    def test_taskcreate_taskupdate_fold(self):
        data = b"".join([
            tool_use("a1", "TaskCreate", {"subject": "写脚本", "description": "d"}),
            tool_result("a1", "Task #1 created successfully: 写脚本"),
            tool_use("a2", "TaskCreate", {"subject": "写测试", "description": "d"}),
            tool_result("a2", "Task #2 created successfully: 写测试"),
            tool_use("a3", "TaskUpdate", {"taskId": "1", "status": "in_progress"}),
            tool_use("a4", "TaskUpdate", {"taskId": "2", "status": "completed"}),
        ])
        tasks = agentnow.parse_tail(data, False)["tasks"]
        self.assertEqual(tasks, [
            {"id": "1", "subject": "写脚本", "status": "in_progress"},
            {"id": "2", "subject": "写测试", "status": "completed"},
        ])

    def test_task_ids_from_results_else_sequence(self):
        data = b"".join([
            tool_use("a1", "TaskCreate", {"subject": "one", "description": "d"}),
            tool_result("a1", "Task #7 created successfully: one"),
            tool_use("a2", "TaskCreate", {"subject": "two", "description": "d"}),
            tool_use("a3", "TaskUpdate", {"taskId": "7", "status": "completed"}),
        ])
        tasks = agentnow.parse_tail(data, False)["tasks"]
        self.assertEqual([t["id"] for t in tasks], ["7", "2"])
        self.assertEqual(tasks[0]["status"], "completed")
        self.assertEqual(tasks[1]["status"], "pending")

    def test_todowrite_replaces_list(self):
        data = b"".join([
            tool_use("a1", "TodoWrite", {"todos": [{"content": "旧一", "status": "pending"}]}),
            tool_use("a2", "TodoWrite", {"todos": [
                {"content": "新一", "status": "completed"},
                {"content": "新二", "status": "in_progress"}]}),
        ])
        tasks = agentnow.parse_tail(data, False)["tasks"]
        self.assertEqual([t["subject"] for t in tasks], ["新一", "新二"])
        self.assertEqual([t["status"] for t in tasks], ["completed", "in_progress"])

    def test_bad_json_lines_skipped(self):
        data = b"not json\n" + user_text("ok") + b"{broken\n"
        self.assertEqual(agentnow.parse_tail(data, False)["last_prompt"], "ok")

    def test_meta_and_injected_text_ignored(self):
        meta = json.loads(user_text("Base directory for this skill: /x"))
        meta["isMeta"] = True
        data = line(meta) + user_text("real ask") + user_text("<task-notification>\n<task-id>x")
        self.assertEqual(agentnow.parse_tail(data, False)["last_prompt"], "real ask")

    def test_last_prompt_entry_wins(self):
        data = user_text("typed ask") + line({"type": "last-prompt", "lastPrompt": "新问题"})
        self.assertEqual(agentnow.parse_tail(data, False)["last_prompt"], "新问题")

    def test_sidechain_ignored(self):
        side = json.loads(user_text("subagent talk"))
        side["isSidechain"] = True
        data = line(side) + user_text("main talk")
        self.assertEqual(agentnow.parse_tail(data, False)["last_prompt"], "main talk")

    def test_empty(self):
        self.assertEqual(agentnow.parse_tail(b"", False)["tools"], [])


HERE = os.path.dirname(os.path.abspath(__file__))


def fixture(name):
    with open(os.path.join(HERE, "fixtures", name), "rb") as f:
        return f.read()


class Fixtures(unittest.TestCase):
    def test_tasks_fixture(self):
        out = agentnow.parse_tail(fixture("tasks.jsonl"), False)
        self.assertEqual(out["last_prompt"], "先写解析，再补测试")
        self.assertEqual(out["tasks"], [
            {"id": "1", "subject": "写尾部解析", "status": "completed"},
            {"id": "2", "subject": "补单元测试", "status": "in_progress"},
        ])
        self.assertEqual([n for n, _ in out["tools"]], ["Read", "TaskCreate", "TaskCreate",
                                                        "TaskUpdate", "TaskUpdate", "Bash"])
        self.assertTrue(out["last_text"].startswith("测试全绿"))

    def test_todo_fixture_skips_meta(self):
        out = agentnow.parse_tail(fixture("todo.jsonl"), False)
        self.assertEqual(out["last_prompt"], "帮我把看板接上")
        self.assertEqual([t["status"] for t in out["tasks"]],
                         ["completed", "in_progress", "pending"])
        self.assertEqual(out["tools"][-1], ["Edit", "/Users/x/project/mods/agent-board/main.luau"])


class Phrase(unittest.TestCase):
    def test_thinking_block_ignored_and_punct_stripped(self):
        body = json.dumps({"content": [
            {"type": "thinking", "thinking": "let me think"},
            {"type": "text", "text": "写测试用例。"}]})
        self.assertEqual(agentnow.phrase_of(body), "写测试用例")

    def test_text_first_also_works(self):
        body = json.dumps({"content": [{"type": "text", "text": " 读文件并改代码!\n"}]})
        self.assertEqual(agentnow.phrase_of(body), "读文件并改代码")

    def test_long_truncated_to_20(self):
        body = json.dumps({"content": [{"type": "text", "text": "一" * 40}]})
        self.assertEqual(len(agentnow.phrase_of(body)), 20)

    def test_garbage(self):
        self.assertIsNone(agentnow.phrase_of("<html>405</html>"))
        self.assertIsNone(agentnow.phrase_of(json.dumps({"content": []})))

    def test_call_model_posts_expected_shape(self):
        seen = {}

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps({"content": [{"type": "text", "text": "检查状态"}]}).encode()

        def fake_urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["headers"] = {k.lower(): v for k, v in req.header_items()}
            seen["body"] = json.loads(req.data)
            seen["timeout"] = timeout
            return Resp()

        with mock.patch("agentnow.urllib.request.urlopen", fake_urlopen):
            got = agentnow.call_model("活动", "http://x:1", "tok")
        self.assertEqual(got, "检查状态")
        self.assertEqual(seen["url"], "http://x:1/v1/messages")
        self.assertEqual(seen["headers"]["x-api-key"], "tok")
        self.assertEqual(seen["headers"]["authorization"], "Bearer tok")
        self.assertEqual(seen["body"]["model"], "deepseek-v4.1-flash")
        self.assertEqual(seen["body"]["thinking"], {"type": "disabled"})
        self.assertEqual(seen["timeout"], 15)

    def test_call_model_failure_is_none(self):
        with mock.patch("agentnow.urllib.request.urlopen", side_effect=OSError("no")):
            self.assertIsNone(agentnow.call_model("x", "http://x:1", "tok"))



class Build(unittest.TestCase):
    TERMS = [
        (None, {"address": "t1", "agent": "claude-code", "status": "working", "turn": 3,
                "where": "Work / Demo"}),
        ("cn", {"address": "t5", "agent": "claude-code", "status": "done", "turn": 9,
                "where": "shop-api / 平台工程"}),
    ]

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cache = os.path.join(self.tmp, "now.json")
        self.calls = []

    def run_build(self, argv, extractions, phrase="读文件"):
        def fake_inspect(machine, addr, homes):
            ex = extractions.get(addr)
            return dict(ex) if ex else None

        def fake_call(text, base, token):
            self.calls.append(text)
            return phrase

        with mock.patch.object(agentnow, "cache_path", lambda: self.cache), \
             mock.patch.object(agentnow, "discover", lambda: list(self.TERMS)), \
             mock.patch.object(agentnow, "inspect", fake_inspect), \
             mock.patch.object(agentnow, "model_config", lambda: ("http://x:1", "tok")), \
             mock.patch.object(agentnow, "call_model", fake_call):
            return json.loads(json.dumps(agentnow.build(argv)))

    def test_shape_matches_contract(self):
        ex = {"last_prompt": "看板不错 做吧", "last_text": "好", "tools": [["Bash", "ls"]], "tasks": []}
        out = self.run_build([], {"t1": ex, "cn/t5": ex})
        self.assertIn("generated_ms", out)
        a = out["agents"]["cn/t5"]
        self.assertEqual(a["machine"], "cn")
        self.assertEqual(a["space"], "shop-api")
        self.assertEqual(a["tab"], "平台工程")
        self.assertIsNone(out["agents"]["t1"]["machine"])
        self.assertEqual(out["agents"]["t1"]["last_prompt"], "看板不错 做吧")
        self.assertEqual(a["now"], "读文件")

    def test_only_filters(self):
        ex = {"last_prompt": "p", "tools": [], "last_text": None, "tasks": []}
        out = self.run_build(["--only", "cn/t5"], {"t1": ex, "cn/t5": ex})
        self.assertEqual(list(out["agents"]), ["cn/t5"])

    def test_only_keeps_other_cache_entries(self):
        ex = {"last_prompt": "p", "tools": [["Bash", "ls"]], "last_text": None, "tasks": []}
        self.run_build([], {"t1": ex, "cn/t5": ex})
        self.run_build(["--only", "t1", "--no-llm"], {"t1": ex, "cn/t5": ex})
        with open(self.cache) as f:
            self.assertEqual(sorted(json.load(f)["agents"]), ["cn/t5", "t1"])

    def test_no_llm_never_calls(self):
        ex = {"last_prompt": "p", "tools": [], "last_text": None, "tasks": []}
        out = self.run_build(["--no-llm"], {"t1": ex, "cn/t5": ex})
        self.assertEqual(self.calls, [])
        self.assertEqual(out["agents"]["t1"]["now"], None)

    def test_cache_reused_within_30s(self):
        ex = {"last_prompt": "p", "tools": [["Bash", "ls"]], "last_text": None, "tasks": []}
        first = self.run_build([], {"t1": ex})
        self.assertEqual(len(self.calls), 1)
        second = self.run_build([], {"t1": ex})
        self.assertEqual(len(self.calls), 1, "same fingerprint and fresh cache must not call")
        self.assertEqual(second["agents"]["t1"]["now"], first["agents"]["t1"]["now"])
        with open(self.cache) as f:
            raw = f.read()
        self.assertNotIn("tok", raw)

    def test_changed_fingerprint_after_30s_regenerates(self):
        ex = {"last_prompt": "p", "tools": [["Bash", "ls"]], "last_text": None, "tasks": []}
        self.run_build([], {"t1": ex})
        with open(self.cache) as f:
            saved = json.load(f)
        saved["agents"]["t1"]["now_ms"] -= 31000
        with open(self.cache, "w") as f:
            json.dump(saved, f)
        self.run_build([], {"t1": dict(ex, last_prompt="p2")}, phrase="改测试")
        self.assertEqual(self.calls[-1].find("p2") >= 0, True)
        with open(self.cache) as f:
            self.assertEqual(json.load(f)["agents"]["t1"]["now"], "改测试")

    def test_changed_fingerprint_too_soon_keeps_cache(self):
        ex = {"last_prompt": "p", "tools": [["Bash", "ls"]], "last_text": None, "tasks": []}
        self.run_build([], {"t1": ex})
        out = self.run_build([], {"t1": dict(ex, last_prompt="p2")})
        self.assertEqual(len(self.calls), 1, "under 30s keeps the old phrase")
        self.assertEqual(out["agents"]["t1"]["now"], "读文件")

    def test_failed_model_keeps_old_phrase(self):
        ex = {"last_prompt": "p", "tools": [["Bash", "ls"]], "last_text": None, "tasks": []}
        self.run_build([], {"t1": ex})
        with open(self.cache) as f:
            saved = json.load(f)
        saved["agents"]["t1"]["now_ms"] -= 31000
        with open(self.cache, "w") as f:
            json.dump(saved, f)
        out = self.run_build([], {"t1": dict(ex, last_prompt="p3")}, phrase=None)
        self.assertEqual(out["agents"]["t1"]["now"], "读文件")

    def test_one_broken_terminal_skipped(self):
        def boom(machine, addr, homes):
            if addr == "t1":
                raise RuntimeError("hc died")
            return {"last_prompt": "p", "tools": [], "last_text": None, "tasks": []}
        with mock.patch.object(agentnow, "cache_path", lambda: self.cache), \
             mock.patch.object(agentnow, "discover", lambda: list(self.TERMS)), \
             mock.patch.object(agentnow, "inspect", boom), \
             mock.patch.object(agentnow, "model_config", lambda: (None, None)):
            out = agentnow.build(["--no-llm"])
        self.assertIn("t1", out["agents"])          # still listed, just no details
        self.assertEqual(out["agents"]["t1"]["tasks"], [])
        self.assertEqual(out["agents"]["cn/t5"]["last_prompt"], "p")

    def test_fingerprint_changes_with_tools(self):
        base = {"last_prompt": "p", "tools": [["Bash", "ls"]], "last_text": None, "tasks": []}
        other = dict(base, tools=[["Bash", "pwd"]])
        self.assertNotEqual(agentnow.fingerprint(3, base), agentnow.fingerprint(3, other))
        self.assertNotEqual(agentnow.fingerprint(3, base), agentnow.fingerprint(4, base))


class Slugs(unittest.TestCase):
    def test_project_slug(self):
        self.assertEqual(agentnow.project_slug("/Users/a/b c"), "-Users-a-b-c")
        self.assertEqual(agentnow.project_slug("/Users/x/Documents/AB测试中心"),
                         "-Users-x-Documents-AB----")


class Discover(unittest.TestCase):
    def test_remote_addresses_split(self):
        payload = json.dumps({"terminals": [
            {"address": "t1", "agent": "claude-code", "turn": 1},
            {"address": "cn/t5", "agent": "claude-code", "turn": 2},
            {"address": "t2", "agent": "zsh", "turn": 0},
        ]}).encode()
        with mock.patch.object(agentnow, "run_hc", lambda args, timeout=0: (0, payload)):
            terms = agentnow.discover()
        self.assertEqual([(m, t["address"]) for m, t in terms], [(None, "t1"), ("cn", "t5")])

    def test_broken_hc_is_empty(self):
        with mock.patch.object(agentnow, "run_hc", lambda args, timeout=0: (1, b"")):
            self.assertEqual(agentnow.discover(), [])


if __name__ == "__main__":
    unittest.main()


class TurnOrigin(unittest.TestCase):
    def test_latest_turn_origin_wins(self):
        rows = [
            {"type": "user", "turnOrigin": "human", "message": {"role": "user", "content": "巡检一下"}},
            {"type": "user", "isMeta": True, "turnOrigin": "scheduled", "message": {"role": "user", "content": "【每小时巡检】"}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}},
        ]
        data = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows).encode()
        ex = agentnow.parse_tail(data, False)
        self.assertEqual(ex["origin"], "scheduled")
        self.assertTrue(agentnow.agent_record(None, {"where": "a / b"}, ex)["auto"])
        ex2 = agentnow.parse_tail(data.split(b"\n", 1)[0], False)
        self.assertFalse(agentnow.agent_record(None, {"where": "a / b"}, ex2)["auto"])
