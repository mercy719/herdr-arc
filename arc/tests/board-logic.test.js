import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NEXT_STATE, acceptAgentTask, agentKey, assignUserCard, deriveCards, moveUserCard,
  newUserCard, planUserTransitions, pruneRejected, rejectAgentTask, rejectUserCard,
  sendArgs, taskProgress, visibleCards,
} from "../mods/agent-board/board-logic.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/board-sample.json", import.meta.url), "utf8"));
const NOW = 1762500001000;
const card = (over = {}) => ({
  id: "u1", text: "修好看板", space: "Work", terminal: "t1", state: "todo",
  queued: false, sentTurn: null, back: null, created_ms: 1, moved_ms: 1, ...over,
});
const agent = (over = {}) => ({
  space: "Work", tab: "Nerd", status: "idle", turn: 7, now: "空闲", now_ms: 2, tasks: [], ...over,
});
const one = (cards) => cards.find((item) => item.id === "u1");

test("fixture derives both sources and all four states without storing agent tasks", () => {
  const list = deriveCards(fixture);
  assert.equal(list.filter((item) => item.source === "user").length, fixture.cards.length);
  assert.equal(list.filter((item) => item.source === "agent").length, 5);
  assert.equal(list.find((item) => item.key === "t24#1").state, "todo");
  assert.equal(list.find((item) => item.key === "t24#2").state, "doing");
  assert.equal(list.find((item) => item.key === "t24#3").state, "review");
  assert.equal(list.find((item) => item.key === "t24#4").state, "done");
  assert.equal(fixture.cards.some((item) => item.id === "t24#1"), false);
  assert.deepEqual(taskProgress({ ...fixture.agents.t24, address: "t24" }, fixture.accepted), { done: 2, total: 4 });
});

test("default scope is the active project; all scope can filter by project", () => {
  const list = deriveCards(fixture);
  assert.ok(visibleCards(list, { activeSpace: "Work" }).every((item) => item.space === "Work"));
  assert.ok(visibleCards(list, { all: true, activeSpace: "Work", filter: "shop-api" }).every((item) => item.space === "shop-api"));
  assert.equal(visibleCards(list, { all: true, activeSpace: "Work" }).length, list.length);
});

test("new cards start unassigned in todo", () => {
  assert.deepEqual(newUserCard({ id: "u", text: "  一件事\n", space: "Work", now: 9 }), {
    id: "u", text: "一件事", images: [], space: "Work", terminal: null, state: "todo",
    queued: false, sentTurn: null, back: null, created_ms: 9, moved_ms: 9,
  });
});

test("moving to doing without a terminal asks for assignment and never sends", () => {
  const result = moveUserCard([card({ terminal: null })], "u1", "doing", { now: NOW });
  assert.equal(result.needsAssignment, true);
  assert.equal(result.send, null);
  assert.equal(one(result.cards).state, "doing");
  assert.equal(one(result.cards).terminal, null);
});

for (const status of ["done", "idle", null]) {
  test(`assigning a ${status} session sends now and records its turn`, () => {
    const result = assignUserCard([card({ terminal: null, state: "doing" })], "u1", "t1", { agents: { t1: agent({ status }) }, now: NOW });
    assert.deepEqual(result.send, { cardId: "u1", address: "t1", text: "修好看板", images: [] });
    assert.equal(one(result.cards).terminal, "t1");
    assert.equal(one(result.cards).sentTurn, 7);
    assert.equal(one(result.cards).queued, false);
    assert.equal(planUserTransitions(result.cards, { t1: agent({ status }) }, NOW + 1).sends.length, 0);
  });
}

test("a second assignment click cannot send the same card again", () => {
  const first = assignUserCard([card({ terminal: null, state: "doing" })], "u1", "t1", { agents: { t1: agent() }, now: NOW });
  const second = assignUserCard(first.cards, "u1", "t1", { agents: { t1: agent() }, now: NOW + 1 });
  assert.equal(second.changed, false);
  assert.equal(second.send, null);
  assert.equal(second.cards, first.cards);
});

for (const status of ["working", "blocked"]) {
  test(`assigning a ${status} session queues instead of sending`, () => {
    const agents = { t1: agent({ status }) };
    const result = assignUserCard([card({ terminal: null, state: "doing" })], "u1", "t1", { agents, now: NOW });
    assert.equal(result.send, null);
    assert.equal(one(result.cards).queued, true);
    assert.equal(one(result.cards).sentTurn, null);
    assert.equal(planUserTransitions(result.cards, agents, NOW + 1).changed, false);
  });
}

test("a queued card sends once when idle, with queued cleared before I/O", () => {
  const cards = [card({ state: "doing", queued: true })];
  const busy = planUserTransitions(cards, { t1: agent({ status: "working" }) }, NOW);
  assert.equal(busy.changed, false);
  assert.equal(busy.sends.length, 0);
  const ready = planUserTransitions(cards, { t1: agent({ status: "done", turn: 8 }) }, NOW);
  assert.equal(ready.sends.length, 1);
  assert.equal(one(ready.cards).queued, false);
  assert.equal(one(ready.cards).sentTurn, 8);
  const again = planUserTransitions(ready.cards, { t1: agent({ status: "done", turn: 8 }) }, NOW + 1);
  assert.equal(again.sends.length, 0);
  assert.equal(again.changed, false);
});

test("a queued card does not send to a missing session", () => {
  const result = planUserTransitions([card({ state: "doing", queued: true })], {}, NOW);
  assert.equal(result.changed, false);
  assert.equal(result.sends.length, 0);
});

test("doing auto-advances to review only after a later finished turn", () => {
  const cards = [card({ state: "doing", sentTurn: 7 })];
  for (const current of [agent({ status: "working", turn: 8 }), agent({ status: "idle", turn: 7 }), agent({ status: "blocked", turn: 8 })]) {
    assert.equal(planUserTransitions(cards, { t1: current }, NOW).changed, false);
  }
  for (const status of ["done", "idle"]) {
    const result = planUserTransitions(cards, { t1: agent({ status, turn: 8 }) }, NOW);
    assert.equal(one(result.cards).state, "review");
    assert.equal(one(result.cards).moved_ms, NOW);
  }
});

test("automatic flow never enters accepted, including after another turn", () => {
  const accepted = [card({ state: "done", sentTurn: 7 })];
  const result = planUserTransitions(accepted, { t1: agent({ status: "idle", turn: 99 }) }, NOW);
  assert.equal(result.changed, false);
  assert.equal(one(result.cards).state, "done");
});

test("manual moves can enter accepted and right-click order has a non-drag path", () => {
  assert.deepEqual(NEXT_STATE, { todo: "doing", doing: "review", review: "done", done: "todo" });
  const result = moveUserCard([card({ state: "review", sentTurn: 7 })], "u1", "done", { now: NOW });
  assert.equal(one(result.cards).state, "done");
  assert.equal(result.send, null);
});

test("manual doing with an assigned idle session sends; todo resets stale send state", () => {
  const started = moveUserCard([card()], "u1", "doing", { agents: { t1: agent() }, now: NOW });
  assert.equal(started.send.address, "t1");
  const reset = moveUserCard(started.cards, "u1", "todo", { now: NOW + 1 });
  assert.equal(one(reset.cards).sentTurn, null);
  assert.equal(one(reset.cards).queued, false);
});

test("accepting an agent task only adds its key, idempotently", () => {
  const once = acceptAgentTask([], "t24#3");
  assert.deepEqual(once, ["t24#3"]);
  assert.deepEqual(acceptAgentTask(once, "t24#3"), once);
  assert.equal(deriveCards({ agents: fixture.agents, accepted: once }).find((item) => item.key === "t24#3").state, "done");
});

test("rejecting a user card sends the exact reason and returns to doing", () => {
  const result = rejectUserCard([card({ state: "review", sentTurn: 7 })], "u1", "  没测边界  ", { agents: { t1: agent({ turn: 8 }) }, now: NOW });
  assert.deepEqual(result.send, { cardId: "u1", address: "t1", text: "验收没通过：没测边界" });
  assert.equal(one(result.cards).state, "doing");
  assert.equal(one(result.cards).back, "没测边界");
  assert.equal(one(result.cards).sentTurn, 8);
  assert.equal(one(result.cards).queued, false);
  const reviewed = planUserTransitions(result.cards, { t1: agent({ status: "idle", turn: 9 }) }, NOW + 1);
  assert.equal(one(reviewed.cards).state, "review");
  assert.equal(one(reviewed.cards).state === "done", false);
});

test("an empty rejection does nothing", () => {
  const cards = [card({ state: "review" })];
  assert.equal(rejectUserCard(cards, "u1", "  ").changed, false);
});

test("agent rejection is a local doing overlay until the next turn completes", () => {
  const rejected = rejectAgentTask({}, "t24#3", "t24", "截图没脱敏", 31);
  const agents = { t24: agent({ status: "done", turn: 31, tasks: [{ id: "3", subject: "开源", status: "completed" }] }) };
  const derived = deriveCards({ agents, rejected: rejected.rejected });
  assert.equal(derived[0].state, "doing");
  assert.equal(derived[0].back, "截图没脱敏");
  assert.deepEqual(rejected.send, { cardId: "t24#3", address: "t24", text: "验收没通过：截图没脱敏" });
  assert.equal(pruneRejected(rejected.rejected, agents).changed, false);
  const later = { t24: agent({ status: "idle", turn: 32, tasks: agents.t24.tasks }) };
  const pruned = pruneRejected(rejected.rejected, later);
  assert.equal(pruned.changed, true);
  assert.equal(deriveCards({ agents: later, rejected: pruned.rejected })[0].state, "review");
});

test("a task status change also retires its rejection overlay", () => {
  const { rejected } = rejectAgentTask({}, "t24#3", "t24", "再改", 31);
  const agents = { t24: agent({ tasks: [{ id: "3", subject: "开源", status: "in_progress" }] }) };
  assert.equal(pruneRejected(rejected, agents).changed, true);
  assert.equal(deriveCards({ agents }).find((item) => item.key === agentKey("t24", "3")).state, "doing");
});

test("hc send protects a leading dash and leaves ordinary text alone", () => {
  assert.deepEqual(sendArgs("t1", "-重新整理"), ["send", "t1", "--", "-重新整理"]);
  assert.deepEqual(sendArgs("cn/t5", "普通文本"), ["send", "cn/t5", "普通文本"]);
});

test("a card's images travel with its send, one path per line after the text", async () => {
  const { withImages, previewPath, isImagePath } = await import("../mods/agent-board/images.js");
  const card = { ...newUserCard({ id: "i", text: "看图改", space: "Work", now: 1, images: ["/h/board-images/1-a.png"] }), terminal: "t1" };
  const r = moveUserCard([card], "i", "doing", { agents: { t1: { status: "idle", turn: 2 } }, now: 2 });
  assert.deepEqual(r.send.images, ["/h/board-images/1-a.png"]);
  assert.equal(withImages("看图改", r.send.images), "看图改\n/h/board-images/1-a.png");
  assert.equal(withImages("", ["/a.png"]), "/a.png");
  assert.equal(previewPath("/h", "/h/board-images/1-a.png"), "board-images/1-a.png");
  assert.equal(previewPath("/h", "/elsewhere/x.png"), null);
  assert.equal(isImagePath("/x/shot.PNG"), true);
  assert.equal(isImagePath("/x/notes.txt"), false);
});
