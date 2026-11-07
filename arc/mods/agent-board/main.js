import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Avatar, AvatarImage, AvatarFallback, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { appHome, exec, hc, notify, props, setShared, shared, spaces, theme } from "herdr";
import { image } from "gpui-kit";
import { clipboardImage, droppedImage, isImagePath, previewPath, withImages } from "./images.js";
import {
  NEXT_STATE, acceptAgentTask, assignUserCard, deriveCards, moveUserCard, newUserCard,
  planUserTransitions, pruneRejected, rejectAgentTask, rejectUserCard, sendArgs,
  taskProgress, visibleCards,
} from "./board-logic.js";
import { initToggle, renderToggle } from "./toggle.js";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const CYCLE = ["ansi4", "ansi3", "ansi6", "ansi5", "ansi2", "ansi1"];
// Same logos as arc-sidebar's LOGOS (files in mods/arc-sidebar/logos/).
const LOGOS = {};
const COLORS = { todo: "dim", doing: "working", review: "done", done: "ansi2" };
const COLUMNS = [
  { key: "todo", icon: "todo" },
  { key: "doing", icon: "doing" },
  { key: "review", icon: "review" },
  { key: "done", icon: "pass", locked: true },
];
const WORDS = {
  en: {
    board: "Board", thisProject: "This project", all: "All", add: "Add todo", todo: "Todo", doing: "Doing", review: "Review", done: "Accepted",
    unassigned: "No session", userSource: "Added by you", agentSource: "Agent task list", locked: "Only you can put cards here",
    empty: "Empty", addHere: "Click to add a todo", emptyDoing: "Drop a card here to send it to an agent", emptyReview: "Finished agent work appears here",
    newPlaceholder: "Write a todo, paste or drop images. Enter adds, click away saves",
    image: "Image", removeImage: "Remove image", imagesOnly: (n) => `${n} image${n > 1 ? "s" : ""}`, reasonPlaceholder: "What is wrong? Enter to return it",
    pass: "Accept", reject: "Return", returned: "Returned", needsYou: "Needs you", queued: (name) => `Queued · waiting for ${name}`,
    sent: (name) => `Sent to ${name}`, assign: "Assign to", noSessions: "No Claude Code sessions in this project",
    busy: "busy · will queue", free: "available", moveHint: "Drag to another column, or right-click to move forward",
    waiting: "Sessions waiting for you", reviewCount: "Waiting for your acceptance", project: "Project", thisComputer: "This computer",
    filter: (name) => `Filter project ${name}`, newTodo: "New todo", rejectReason: "Return reason", sendFailed: "Board could not send the message",
    working: "Working", idle: "Idle", doneStatus: "Done", blocked: "Blocked", noUpdate: "No status update",
    justNow: "now", minutes: (n) => `${n}m`, hours: (n) => `${n}h`, yesterday: "yesterday",
    acceptCard: (text) => `Accept ${text}`, rejectCard: (text) => `Return ${text}`, session: "Session",
  },
  zh: {
    board: "看板", thisProject: "本项目", all: "全部", add: "加待办", todo: "待办", doing: "进行中", review: "待验收", done: "已验收",
    unassigned: "未指定会话", userSource: "你加的", agentSource: "agent 的任务清单", locked: "只有你能放进来",
    empty: "空", addHere: "点这里写一条待办", emptyDoing: "拖一张卡进来，发给空闲的 agent", emptyReview: "agent 做完的会出现在这里",
    newPlaceholder: "写一条待办，可粘贴或拖入图片；回车添加，点别处保存",
    image: "图片", removeImage: "移除图片", imagesOnly: (n) => `${n} 张图片`, reasonPlaceholder: "哪里不对？回车退回给 agent",
    pass: "通过", reject: "不通过", returned: "退回", needsYou: "等你", queued: (name) => `排队 · 等 ${name} 空闲`,
    sent: (name) => `已发给 ${name}`, assign: "交给", noSessions: "这个项目没有 Claude Code 会话",
    busy: "忙，会排队", free: "空闲", moveHint: "拖到另一栏，或右键顺移一栏",
    waiting: "等你处理的会话", reviewCount: "待你验收", project: "项目", thisComputer: "本机",
    filter: (name) => `按项目 ${name} 筛选`, newTodo: "新待办", rejectReason: "退回原因", sendFailed: "看板发送失败",
    working: "进行中", idle: "空闲", doneStatus: "已完成", blocked: "等你处理", noUpdate: "还没有状态",
    justNow: "刚刚", minutes: (n) => `${n} 分钟`, hours: (n) => `${n} 小时`, yesterday: "昨天",
    acceptCard: (text) => `通过 ${text}`, rejectCard: (text) => `退回 ${text}`, session: "会话",
  },
};
const W = () => WORDS[props()?.lang] ?? WORDS.en;
const initial = (name) => ([...(name ?? "")][0] ?? "?").toUpperCase();
const deviceName = (machine) => props()?.machines?.[machine ?? "local"] ?? machine ?? W().thisComputer;
const icon = (name, size = 14) => svg(`mods/agent-board/${name}.svg`).size(size).flex_none();

function hash(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// Same project fill as arc-sidebar, including its stored overrides and stable fallback.
function fill(t, space) {
  const stored = (shared("space.colors") ?? {})[space.id];
  const name = stored ?? CYCLE[hash(space.id) % CYCLE.length];
  return name.startsWith("#") ? name : (MARK[name] ?? t[name] ?? t.accent);
}

function relativeTime(ms, now, w) {
  if (!Number.isFinite(ms)) return "";
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 60_000) return w.justNow;
  if (elapsed < 3_600_000) return w.minutes(Math.floor(elapsed / 60_000));
  if (elapsed < 86_400_000) return w.hours(Math.floor(elapsed / 3_600_000));
  if (elapsed < 172_800_000) return w.yesterday;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export default class AgentBoard extends View {
  init(_props, cx) {
    if (props()?.role === "toggle") { this.toggle = true; initToggle(this, cx); return; }
    this.allProjects = false;
    this.filter = null;
    this.adding = false;
    this.rejecting = null;
    this.rejected = {};
    this.drag = null;
    this.over = null;
    this.handle = cx.focus_handle();
    this.newInput = TextareaState.new({ placeholder: W().newPlaceholder, rows: 2 });
    this.newInput.on("submit", (event, cx) => { if (!event?.shift) this.addCard(cx); });
    // A paste with no text on the clipboard: look for an image there.
    this.newInput.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.draftImages = [];
    this.rejectInput = InputState.new({ placeholder: W().reasonPlaceholder });
    this.rejectInput.on("submit", (_event, cx) => this.submitRejection(cx));
    // Live shared data already redraws the mod. This timer is only for queued sends,
    // turn-based review, and retiring a local agent rejection; no work runs in render.
    cx.timer.every(1000, (cx) => this.tick(cx));
    cx.timer.every(60_000, (cx) => cx.notify());
  }

  // agentnow.py names the space; cards and filters use the space id (same name can live on two machines).
  agents() {
    const raw = shared("agent.now") ?? {};
    const ids = {};
    for (const space of spaces()) ids[`${space.machine ?? ""}|${space.name}`] = space.id;
    return Object.fromEntries(Object.entries(raw).map(([address, agent]) =>
      [address, { ...agent, space: ids[`${agent.machine ?? ""}|${agent.space}`] ?? agent.space }]));
  }
  cards() { return Array.isArray(shared("board.cards")) ? shared("board.cards") : []; }
  accepted() { return Array.isArray(shared("board.accepted")) ? shared("board.accepted") : []; }
  allCards() {
    return deriveCards({ cards: this.cards(), agents: this.agents(), accepted: this.accepted(), rejected: this.rejected });
  }

  tick(cx) {
    const agents = this.agents();
    const pruned = pruneRejected(this.rejected, agents);
    if (pruned.changed) this.rejected = pruned.rejected;
    const planned = planUserTransitions(this.cards(), agents, Date.now());
    if (planned.changed) setShared("board.cards", planned.cards);
    for (const send of planned.sends) this.deliver(send, cx);
    if (pruned.changed || planned.changed) cx.notify();
  }

  deliver(send, cx) {
    if (!send) return;
    cx.spawn(async () => {
      let images = send.images ?? [];
      // A path means nothing on another machine: send each image there and use where it landed.
      if (images.length && send.address.includes("/")) {
        const landed = [];
        for (const path of images) {
          const r = await hc(["put", send.address, path]).catch(() => null);
          const there = r?.code === 0 ? r.stdout.trim().split("\n").pop() : "";
          if (there.startsWith("/")) landed.push(there);
        }
        images = landed;
      }
      const result = await hc(sendArgs(send.address, withImages(send.text, images))).catch((error) => ({ code: -1, stderr: String(error) }));
      if (result.code !== 0) notify({ title: W().sendFailed, body: String(result.stderr || result.stdout || "").slice(0, 240), level: "error" });
    });
  }

  applyUser(result, cx) {
    if (result.changed) setShared("board.cards", result.cards);
    if (result.send) this.deliver(result.send, cx);
    cx.notify();
  }

  move(id, state, cx) {
    this.rejecting = null;
    this.applyUser(moveUserCard(this.cards(), id, state, { agents: this.agents(), now: Date.now() }), cx);
  }

  assign(card, address, cx) {
    this.applyUser(assignUserCard(this.cards(), card.id, address, { agents: this.agents(), now: Date.now() }), cx);
  }

  addCard(cx) {
    const text = this.newInput.value().trim();
    const images = this.draftImages;
    const space = spaces().find((item) => item.active)?.id;
    if ((text || images.length) && space) {
      const id = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const card = newUserCard({ id, text, space, now: Date.now(), images });
      setShared("board.cards", [card, ...this.cards()]);
    }
    this.closeEditor(cx);
  }

  // Esc, or a click outside with nothing written: drop the draft.
  closeEditor(cx) {
    this.adding = false;
    this.newInput.set_value("");
    this.draftImages = [];
    cx.notify();
  }

  pasteImage(cx) {
    cx.spawn(async (cx) => {
      const path = await clipboardImage(exec, appHome()).catch(() => null);
      if (path) { this.draftImages = [...this.draftImages, path]; cx.notify(); }
    });
  }

  dropFiles(paths, cx) {
    cx.spawn(async (cx) => {
      for (const path of paths.filter(isImagePath)) {
        const copy = await droppedImage(exec, appHome(), path);
        if (copy) this.draftImages = [...this.draftImages, copy];
      }
      cx.notify();
    });
  }

  thumbs(t, paths, size, onRemove) {
    return h_flex().flex_wrap().gap(6).children(paths.map((path, i) => {
      const rel = previewPath(appHome(), path);
      const box = div().id(`thumb-${size}-${i}`).relative().size(size).flex_none().rounded(6).overflow_hidden()
        .border_1().border_color(t.border).bg(t.raised).tooltip(path.split("/").pop()).accessibility_label(W().image)
        .child(rel ? image(rel).size_full() : icon("plus", 12));
      return onRemove ? box.child(div().id(`thumb-x-${i}`).absolute().top(1).right(1).size(16).rounded_full().bg(t.background)
        .flex().items_center().justify_center().text_size(11).text_color(t.foreground).cursor_pointer()
        .accessibility_label(W().removeImage).on_click((_e, cx) => { cx.stop_propagation(); onRemove(i, cx); }).child("×")) : box;
    }));
  }

  startAdding(cx) {
    this.adding = true;
    this.newInput.set_value("");
    cx.notify();
    cx.timer.after(0, () => this.newInput.focus());
  }

  accept(card, cx) {
    if (card.source === "user") {
      this.move(card.id, "done", cx);
      return;
    }
    setShared("board.accepted", acceptAgentTask(this.accepted(), card.key));
    const next = { ...this.rejected };
    delete next[card.key];
    this.rejected = next;
    cx.notify();
  }

  startRejection(card, cx) {
    this.rejecting = card.key;
    this.rejectInput.set_value("");
    cx.notify();
    cx.timer.after(0, () => this.rejectInput.focus());
  }

  submitRejection(cx) {
    const key = this.rejecting;
    const card = this.allCards().find((item) => item.key === key && item.state === "review");
    const reason = this.rejectInput.value().trim();
    this.rejecting = null;
    this.rejectInput.set_value("");
    if (!card || !reason) { cx.notify(); return; }
    if (card.source === "user") {
      this.applyUser(rejectUserCard(this.cards(), card.id, reason, { agents: this.agents(), now: Date.now() }), cx);
      return;
    }
    const result = rejectAgentTask(this.rejected, card.key, card.terminal, reason, card.agent?.turn);
    this.rejected = result.rejected;
    this.deliver(result.send, cx);
    cx.notify();
  }

  keyDown(event, cx) {
    if (event.key !== "escape") return;
    let changed = false;
    if (this.adding) { this.adding = false; this.newInput.set_value(""); this.draftImages = []; changed = true; }
    if (this.rejecting) { this.rejecting = null; this.rejectInput.set_value(""); changed = true; }
    if (this.drag != null) { this.drag = this.over = null; changed = true; }
    if (changed) { cx.stop_propagation(); cx.notify(); }
  }

  avatar(t, space, size = 18, radius = 5) {
    // An icon picked in the sidebar's menu (shared arc.icons) wins over the bundled logo.
    const saved = (shared("arc.icons") ?? {})[space.id];
    const custom = typeof saved === "string" && saved
      ? `mods/arc-sidebar/icons/${saved.replace(/^arc-icons\//, "").replace(/[^A-Za-z0-9_.-]/g, "_")}` : null;
    const body = custom || LOGOS[space.name]
      ? Avatar.new().w(size).h(size).flex_none().rounded(radius).overflow_hidden()
        .image(AvatarImage.new(custom ?? `mods/arc-sidebar/logos/${LOGOS[space.name]}.png`).size_full())
        .fallback(AvatarFallback.new().size_full().bg(fill(t, space)).items_center().justify_center()
          .text_size(Math.round(size * 0.48)).font_bold().text_color("#ffffff").child(initial(space.name)))
      : h_flex().size(size).flex_none().rounded(radius).bg(fill(t, space)).items_center().justify_center()
        .text_size(Math.round(size * 0.48)).font_bold().text_color("#ffffff").child(initial(space.name));
    return h_flex().flex_none().tooltip(`${space.name} · ${deviceName(space.machine)}`)
      .accessibility_label(`${W().project} ${space.name}`).child(body);
  }

  scopeControl(t) {
    const button = (id, label, selected, action) => h_flex().id(`scope-${id}`).h(24).px(9).items_center().justify_center().rounded(6)
      .text_size(11.5).font_medium().cursor_pointer().bg(selected ? t.selection : t.canvas)
      .text_color(selected ? t.foreground : t.muted).hover((el) => el.text_color(t.foreground))
      .tooltip(label).accessibility_label(label).on_click(action).child(label);
    return h_flex().p(2).gap(2).rounded(8).bg(t.canvas).border_1().border_color(t.border)
      .child(button("project", W().thisProject, !this.allProjects, (_e, cx) => { this.allProjects = false; this.filter = null; cx.notify(); }))
      .child(button("all", W().all, this.allProjects, (_e, cx) => { this.allProjects = true; cx.notify(); }));
  }

  projectFilter(t, space) {
    const blocked = Object.values(this.agents()).filter((agent) => agent.space === space.id && agent.status === "blocked").length;
    const selected = this.filter === space.id;
    return h_flex().id(`filter-${space.id}`).relative().p(2).flex_none().rounded(8).cursor_pointer()
      .border(1.5).border_color(selected ? fill(t, space) : t.canvas).opacity(selected ? 1 : 0.58)
      .hover((el) => el.opacity(1)).aria_selected(selected)
      .tooltip(space.name).accessibility_label(W().filter(space.name))
      .on_click((_e, cx) => { this.filter = selected ? null : space.id; cx.notify(); })
      .child(this.avatar(t, space, 24, 6))
      .when(blocked > 0, (el) => el.child(h_flex().absolute().top(-5).right(-5).h(15).min_w(15).px(2).items_center().justify_center()
        .rounded_full().bg(t.blocked).border(1.5).border_color(t.canvas).text_size(9.5).font_bold().text_color("#ffffff").child(String(blocked))));
  }

  header(t, active, scoped) {
    const w = W();
    const waiting = Object.values(this.agents()).filter((agent) => agent.status === "blocked").length;
    const review = scoped.filter((card) => card.state === "review").length;
    const stat = (name, number, color, label) => h_flex().gap(5).items_center().text_size(12).text_color(t.muted)
      .tooltip(label).accessibility_label(`${label} ${number}`)
      .child(h_flex().text_color(color).child(icon(name, 13))).child(div().text_size(14).font_semibold().text_color(color).child(String(number)));
    return h_flex().h(52).flex_none().px(20).gap(12).items_center().border_b(1).border_color(t.border)
      .when(this.allProjects, (el) => el.child(div().text_size(15).font_semibold().child(w.board)))
      .when(!this.allProjects && active, (el) => el.child(this.avatar(t, active, 20, 5))
        .child(div().max_w(180).truncate().text_size(15).font_semibold().child(active.name)))
      .when(!this.allProjects && !active, (el) => el.child(div().text_size(15).font_semibold().child(w.board)))
      .child(this.scopeControl(t))
      .when(this.allProjects, (el) => el.child(h_flex().gap(4).items_center().children(spaces().map((space) => this.projectFilter(t, space)))))
      .child(div().flex_1())
      .child(stat("user", waiting, t.blocked, w.waiting))
      .child(stat("review", review, t.done, w.reviewCount))
      .when(Boolean(active), (el) => el.child(h_flex().id("add-todo").h(30).px(12).gap(6).flex_none().items_center().justify_center()
        .rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_semibold().cursor_pointer()
        .hover((style) => style.opacity(0.88)).tooltip(w.add).accessibility_label(w.add)
        .on_click((_e, cx) => this.startAdding(cx)).child(icon("plus", 13)).child(w.add)));
  }

  pill(text, color, iconName = null) {
    return h_flex().h(18).px(6).gap(4).flex_none().items_center().rounded(5).bg(`${color}26`)
      .text_size(10.5).font_semibold().text_color(color)
      .when(Boolean(iconName), (el) => el.child(icon(iconName, 11))).child(text);
  }

  statusLine(t, card) {
    const w = W();
    const agent = card.agent;
    const name = agent?.tab ?? card.terminal ?? w.unassigned;
    if (card.queued) return h_flex().gap(6).items_center().child(this.pill(w.queued(name), t.working, "clock"));
    if (!agent) return null;
    const now = div().flex_1().min_w(0).truncate().text_color(t.muted).child(agent.now ?? w.noUpdate);
    if (agent.status === "working") return h_flex().h(18).gap(7).items_center()
      .child(h_flex().tooltip(w.working).accessibility_label(w.working).child(icon("spinner", 12).text_color(t.working).spin(900))).child(now);
    if (agent.status === "blocked") return h_flex().h(18).gap(7).items_center().child(this.pill(w.needsYou, t.blocked)).child(now);
    if (card.sentTurn != null) return h_flex().h(18).gap(7).items_center().child(this.pill(w.sent(name), t.done, "send"));
    return h_flex().h(18).gap(7).items_center()
      .child(div().size(7).mx(2).flex_none().rounded_full().bg(t.dim).tooltip(agent.status === "done" ? w.doneStatus : w.idle)
        .accessibility_label(agent.status === "done" ? w.doneStatus : w.idle)).child(now);
  }

  actionButton(t, id, label, iconName, color, filled, onClick) {
    return h_flex().id(id).h(26).flex_1().min_w(0).gap(5).items_center().justify_center().rounded(7)
      .border_1().border_color(filled ? `${color}55` : t.input).bg(filled ? `${color}22` : t.raised)
      .text_color(color).text_size(12).font_semibold().cursor_pointer().hover((el) => el.opacity(0.82))
      .tooltip(label).accessibility_label(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(onClick)
      .child(icon(iconName, 12)).child(label);
  }

  reviewActions(t, card) {
    if (this.rejecting === card.key) {
      return div().mt(1).child(Input.new(this.rejectInput).id(`reject-${card.key}`).h(28).w_full().px(9).rounded(7)
        .border_1().border_color(t.blocked).bg(t.background).text_size(12.5).text_color(t.foreground)
        .accessibility_label(W().rejectReason));
    }
    return h_flex().gap(6).mt(1)
      .child(this.actionButton(t, `pass-${card.key}`, W().pass, "check", t.ansi2, true, (_e, cx) => this.accept(card, cx)))
      .child(this.actionButton(t, `return-${card.key}`, W().reject, "undo", t.blocked, false, (_e, cx) => this.startRejection(card, cx)));
  }

  assignment(t, card, byId) {
    const candidates = Object.entries(this.agents()).filter(([, agent]) => agent.space === card.space);
    if (!candidates.length) return div().text_size(11.5).text_color(t.dim).child(W().noSessions);
    return h_flex().gap(6).items_center().flex_wrap().child(div().text_size(11.5).text_color(t.muted).child(W().assign))
      .children(candidates.map(([address, agent]) => {
        const busy = agent.status !== "done" && agent.status !== "idle" && agent.status !== null;
        const space = byId[agent.space] ?? { id: agent.space ?? "?", name: agent.space ?? "?", machine: agent.machine };
        const label = `${agent.tab ?? address} · ${busy ? W().busy : W().free}`;
        return h_flex().id(`assign-${card.key}-${address}`).relative().p(2).flex_none().rounded(7).cursor_pointer()
          .border(1.5).border_color(t.raised).hover((el) => el.border_color(t.input))
          .tooltip(label).accessibility_label(`${W().assign} ${label}`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.assign(card, address, cx))
          .child(this.avatar(t, space, 20, 5))
          .when(busy, (el) => el.child(div().absolute().right(-1).bottom(-1).size(7).rounded_full().bg(t.working).border(1.5).border_color(t.raised)));
      }));
  }

  progress(t, card) {
    if (card.source !== "agent" || card.state !== "doing") return null;
    const value = taskProgress({ ...card.agent, address: card.terminal }, this.accepted());
    if (!value) return null;
    return h_flex().h(8).gap(10).items_center().text_size(11.5).text_color(t.dim)
      .child(div().flex_none().child(`${value.done}/${value.total}`))
      .child(div().relative().flex_1().h(4).rounded_full().bg(t.hover).overflow_hidden()
        .child(div().absolute().left(0).top(0).h(4).rounded_full().bg(t.working).w(`${Math.round(value.done / value.total * 100)}%`)));
  }

  card(t, card, byId) {
    const space = byId[card.space] ?? { id: card.space ?? "?", name: card.space ?? "?", machine: card.agent?.machine ?? null };
    const sessionName = card.agent?.tab ?? card.terminal ?? W().unassigned;
    const sourceLabel = card.source === "user" ? W().userSource : W().agentSource;
    const age = relativeTime(card.moved_ms ?? card.created_ms ?? card.agent?.now_ms, Date.now(), W());
    const dragging = this.drag != null && card.source === "user" && this.drag === card.id;
    const source = h_flex().gap(4).flex_none().items_center().text_color(t.dim).text_size(11.5)
      .child(h_flex().tooltip(sourceLabel).accessibility_label(sourceLabel).child(icon(card.source === "user" ? "user" : "bot", 12)))
      .when(age, (el) => el.child(age));
    const title = div().max_h(38).overflow_hidden().line_height("19px").text_size(13.5).font_medium().text_color(t.foreground)
      .when(card.state === "done", (el) => el.line_through()).child(card.text || W().imagesOnly(card.images?.length ?? 0));
    const status = card.state === "doing" ? this.statusLine(t, card) : null;
    const progress = this.progress(t, card);
    return v_flex().id(`card-${card.key}`).p(10).gap(7).flex_none().rounded(10).bg(t.raised).border_1().border_color(t.border)
      .opacity(dragging ? 0.35 : card.state === "done" ? 0.7 : 1)
      .hover((el) => el.border_color(t.input))
      .when(card.source === "user", (el) => el.cursor_pointer().tooltip(`${card.text} · ${W().moveHint}`)
        .accessibility_label(`${card.text}. ${W().moveHint}`)
        .on_mouse_down("left", () => { this.drag = card.id; this.over = card.state; })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.move(card.id, NEXT_STATE[card.state], cx); }))
      .when(card.source === "agent", (el) => el.accessibility_label(`${card.text}. ${sourceLabel}`))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
        .child(this.avatar(t, space, 18, 5))
        .child(div().flex_1().min_w(0).truncate().tooltip(`${space.name} · ${sessionName}`)
          .accessibility_label(`${W().session} ${sessionName}`).child(sessionName)).child(source))
      .child(title)
      .when((card.images?.length ?? 0) > 0, (el) => el.child(this.thumbs(t, card.images, 36)))
      .when(Boolean(status), (el) => el.child(status))
      .when(card.state === "doing" && card.back, (el) => el.child(h_flex().gap(7).items_center()
        .child(this.pill(W().returned, t.blocked, "undo"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.blocked).tooltip(card.back).child(card.back))))
      .when(card.state === "doing" && card.source === "user" && !card.terminal, (el) => el.child(this.assignment(t, card, byId)))
      .when(Boolean(progress), (el) => el.child(progress))
      .when(card.state === "review", (el) => el.child(this.reviewActions(t, card)));
  }

  newCardEditor(t) {
    // A click anywhere else saves what's written, or drops an empty draft. Images come by paste or drop.
    return v_flex().id("new-todo").mx(8).mb(10).gap(6)
      .on_mouse_down_out((_e, cx) => {
        if (!this.adding) return;
        if (this.newInput.value().trim() || this.draftImages.length) this.addCard(cx); else this.closeEditor(cx);
      })
      .on_drop((event, cx) => this.dropFiles(event.paths, cx))
      .child(Textarea.new(this.newInput).id("new-todo-input").h(60).w_full().p(9).rounded(10)
        .border_1().border_color(t.accent).bg(t.raised).text_size(13).text_color(t.foreground).accessibility_label(W().newTodo))
      .when(this.draftImages.length > 0, (el) => el.child(this.thumbs(t, this.draftImages, 44, (i, cx) => {
        this.draftImages = this.draftImages.filter((_p, k) => k !== i); cx.notify();
      })));
  }

  column(t, definition, cards, byId) {
    const color = t[COLORS[definition.key]] ?? t.muted;
    const target = this.drag != null && this.over === definition.key;
    const emptyText = definition.key === "doing" ? W().emptyDoing : definition.key === "review" ? W().emptyReview : W().empty;
    return v_flex().id(`column-${definition.key}`).flex_1().h_full().min_w(0).min_h(0).rounded(12).bg(t.background)
      .border_1().border_color(target ? color : t.background)
      .accessibility_label(W()[definition.key])
      .on_mouse_move((_e, cx) => {
        if (this.drag != null && this.over !== definition.key) { this.over = definition.key; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag == null) return;
        const id = this.drag;
        this.drag = this.over = null;
        cx.stop_propagation();
        this.move(id, definition.key, cx);
      })
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center()
        .child(h_flex().size(22).flex_none().items_center().justify_center().rounded(6).bg(`${color}26`).text_color(color)
          .child(icon(definition.icon, 14)))
        .child(div().text_size(13).font_semibold().child(W()[definition.key]))
        .when(definition.locked, (el) => el.child(h_flex().text_color(t.dim).tooltip(W().locked).accessibility_label(W().locked).child(icon("lock", 12))))
        .child(div().flex_1())
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(String(cards.length))))
      .when(definition.key === "todo" && this.adding, (el) => el.child(this.newCardEditor(t)))
      .child(v_flex().flex_1().min_h(0).px(8).pb(10).gap(8).overflow_y_scrollbar()
        .children(cards.map((card) => this.card(t, card, byId)))
        .when(!cards.length && !(definition.key === "todo" && this.adding), (el) => el.child(div().id(`empty-${definition.key}`).m(4).p(14).rounded(10).border_1().border_dashed().border_color(t.input)
          .text_size(12).text_center().text_color(t.dim)
          // The todo column's empty box is the place to type: a click opens the editor.
          .when(definition.key === "todo", (box) => box.cursor_pointer().hover((st) => st.border_color(t.muted).text_color(t.foreground))
            .accessibility_label(W().addHere).on_click((_e, cx) => this.startAdding(cx)))
          .child(definition.key === "todo" ? W().addHere : emptyText)))
        .when(definition.key === "todo" && cards.length > 0 && !this.adding, (el) => el.child(h_flex().id("todo-add").h(30).px(10).gap(6).items_center()
          .rounded(8).text_size(12).text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
          .accessibility_label(W().addHere).on_click((_e, cx) => this.startAdding(cx))
          .child(icon("plus", 12)).child(W().addHere))));
  }

  render() {
    if (this.toggle) return renderToggle();
    const t = theme();
    const allSpaces = spaces();
    const active = allSpaces.find((space) => space.active) ?? null;
    const byId = Object.fromEntries(allSpaces.map((space) => [space.id, space]));
    const all = this.allCards().sort((a, b) => (b.moved_ms ?? b.created_ms ?? b.agent?.now_ms ?? 0) - (a.moved_ms ?? a.created_ms ?? a.agent?.now_ms ?? 0));
    const scoped = visibleCards(all, { all: this.allProjects, activeSpace: active?.id ?? null });
    const visible = this.filter && this.allProjects ? scoped.filter((card) => card.space === this.filter) : scoped;
    return v_flex().id("agent-board").size_full().min_h(0).bg(t.canvas).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((event, cx) => this.keyDown(event, cx))
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag != null) { this.drag = this.over = null; cx.notify(); }
      })
      .child(this.header(t, active, scoped))
      .child(h_flex().flex_1().min_h(0).gap(12).px(16).pt(14).pb(16)
        .children(COLUMNS.map((definition) => this.column(t, definition, visible.filter((card) => card.state === definition.key), byId))));
  }
}
