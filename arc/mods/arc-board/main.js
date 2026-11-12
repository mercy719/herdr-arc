import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Avatar, AvatarImage, AvatarFallback, TextView } from "gpui-base";
import { spaces, agents, focused, theme, shared, setShared, exec, appHome, readTextFile } from "herdr";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const CYCLE = ["ansi4", "ansi3", "ansi6", "ansi5", "ansi2", "ansi1"];
// Optional project logos, same as the sidebar: { "space name": "file" } for mods/arc-sidebar/logos/<file>.png.
// A logo picked from the sidebar's right-click menu (arc.logoIds) is used too.
const LOGOS = {};
const GREEN = "#34c759";
const SEND_DELAY_MS = 3000;
const DEFAULT_BLOCKS = [
  { id: "asks", kind: "asks", title: "等你", source: { type: "ai" }, refresh: "agent-stop" },
  { id: "next", kind: "next", title: "下一步", source: { type: "ai" }, refresh: "agent-stop" },
  { id: "pipeline", kind: "pipeline", title: "PR", source: { type: "gh" }, refresh: "5m" },
  { id: "gates", kind: "gates", title: "能不能上线", source: { type: "ai" }, refresh: "agent-stop" },
];
const KINDS = new Set(["asks", "next", "pipeline", "gates", "stat", "bars"]);
const STAGES = ["代码", "测试", "审查", "合入", "进包"];
const initial = (name) => ([...(name ?? "")][0] ?? "?").toUpperCase();
const list = (value) => Array.isArray(value) ? value : [];
const ago = (ms) => ms < 60e3 ? "刚刚" : ms < 3600e3 ? `${Math.floor(ms / 60e3)} 分钟前` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)} 小时前` : `${Math.floor(ms / 86400e3)} 天前`;

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

function fill(t, space) {
  const stored = (shared("space.colors") ?? {})[space.id];
  const name = stored ?? CYCLE[hash(space.id) % CYCLE.length];
  return name.startsWith("#") ? name : (MARK[name] ?? t[name] ?? t.accent);
}

export default class ArcBoard extends View {
  init(_props, cx) {
    const view = localStorage.getItem("view");
    this.which = view === "project" ? "project" : "chat";
    this.pending = {};
    this.sends = {};  // decision buttons: key → { label, say, agent, due, state: wait|sending|sent|failed, error }
    this.running = {};
    this.opened = new Set();
    this.lastGh = {};
    this.lastAll = {};
    this.configs = {};
    this.configLoading = new Set();
    this.agentStatus = Object.fromEntries(agents().map((a) => [a.address, a.status]));
    // The pump only runs queued work. Live agent changes arrive through render(), not polling.
    cx.timer.every(1000, (cx) => this.pump(cx));
    cx.timer.every(30000, (cx) => cx.notify());
    // Only while a decision is counting down: redraw its bar smoothly.
    cx.timer.every(100, (cx) => { if (Object.values(this.sends).some((s) => s.state === "wait")) cx.notify(); });
  }

  async close() { this.closed = true; }

  data(id) { return (shared("arc.board") ?? {})[id] ?? null; }

  schedule(id, mode, reason, delay = 0, force = false) {
    const old = this.pending[id];
    const all = mode === "all" || old?.mode === "all";
    this.pending[id] = {
      due: old ? Math.min(old.due, Date.now() + delay) : Date.now() + delay,
      mode: all ? "all" : "gh",
      reason: all && old?.mode === "all" && !force ? old.reason : reason,
      force: force || Boolean(old?.force),  // manual refresh: rerun the model even if the transcript is unchanged
    };
  }

  observe() {
    const now = {};
    for (const a of agents()) {
      const before = this.agentStatus[a.address];
      if (before === "working" && ["done", "blocked", "idle"].includes(a.status)) {
        this.schedule(a.space, "all", `${a.tab_name}：working → ${a.status}`, 10000);
        this.schedule(`${a.space}#${a.address}`, "all", `${a.tab_name}：working → ${a.status}`, 10000);
      }
      now[a.address] = a.status;
    }
    this.agentStatus = now;
  }

  targetForKey(key) {
    const at = key.indexOf("#");
    const spaceId = at < 0 ? key : key.slice(0, at);
    const space = spaces().find((s) => s.id === spaceId);
    if (!space) return null;
    if (at < 0) return { key, space, agent: null };
    const address = key.slice(at + 1);
    const agent = agents().find((a) => a.space === spaceId && a.address === address);
    return agent ? { key, space, agent } : null;
  }

  pump(cx) {
    if (this.closed) return;
    const now = Date.now(), key = this.currentKey;
    if (this.copied && now - this.copied.at >= 1500) { this.copied = null; cx.notify(); }
    this.pumpSends(cx, now);
    // The board on screen has no model summary yet (first run failed, timed out or never ran): retry every 2 min.
    const shown = key ? this.data(key) : null;
    if (key && (!shown || shown.ai_status === "gh-only" || String(shown.ai_status).startsWith("failed"))
        && now - (this.lastAll[key] ?? 0) >= 120000 && !this.pending[key] && !this.running[key]) {
      this.schedule(key, "all", shown ? "上次没拿到总结，重试" : "首次打开");
    }
    // Every 5 min the board on screen is rechecked in full: the transcript is re-read and the model only runs
    // when it changed (fingerprint), so a conversation that moved on without finishing a turn still updates.
    if (key && now - (this.lastGh[key] ?? 0) >= 300000 && !this.pending[key] && !this.running[key]) {
      this.schedule(key, "all", "每 5 分钟检查");
    }
    const due = Object.entries(this.pending).filter(([id, p]) => p.due <= now && !this.running[id]).sort((a, b) => a[1].due - b[1].due)[0];
    if (!due) return;
    const [id, job] = due;
    delete this.pending[id];
    const target = this.targetForKey(id);
    if (!target) return;
    this.running[id] = true;
    this.lastGh[id] = now;
    if (job.mode === "all") this.lastAll[id] = now;
    this.refresh(cx, target, job.mode, job.reason, job.force);
  }

  // A click waits UNDO_MS so it can be taken back, then boardnow.py pastes the reply into that session with hc send.
  pumpSends(cx, now) {
    const waiting = Object.entries(this.sends).filter(([, s]) => s.state === "wait");
    if (!waiting.length) return;
    for (const [id, s] of waiting) {
      if (s.due > now) continue;
      s.state = "sending";
      cx.spawn(async (cx) => {
        const script = `${appHome()}/mods/arc-board/boardnow.py`;
        const result = await exec("python3", ["-I", "-S", script, "--send", s.agent, s.say], { timeout: 30000 }).catch(() => null);
        if (this.closed || this.sends[id] !== s) return;
        let out = null;
        try { out = JSON.parse(result?.stdout ?? ""); } catch { /* treated as failed below */ }
        s.state = out?.ok ? "sent" : "failed";
        s.error = out?.error ?? "没发出去";
        cx.notify();
      });
    }
    cx.notify();  // the countdown text changes every second
  }

  refresh(cx, target, mode, reason, force = false) {
    cx.spawn(async (cx) => {
      const { space, agent, key } = target;
      const encode = (a) => ({
        address: a.address, tab_name: a.tab_name, status: a.status, app: a.app,
        changed_at: space.tabs.find((tab) => tab.id === a.tab)?.changed_at ?? null,
      });
      const payload = {
        id: key, chat: Boolean(agent), cwd: space.folder || "~", machine: space.machine, mode, force,
        agents: agent ? [encode(agent)] : agents().filter((a) => a.space === space.id).map(encode),
      };
      const script = `${appHome()}/mods/arc-board/boardnow.py`;
      const result = await exec("python3", ["-I", "-S", script, JSON.stringify(payload)], { timeout: 90000 }).catch(() => null);
      if (this.closed) return;
      if (result?.code === 0) {
        try {
          const data = JSON.parse(result.stdout);
          if (data.space === key) {
            const boards = shared("arc.board") ?? {};
            const old = boards[key];
            if (data.gh_state === "unreachable" && !list(data.prs).length && list(old?.prs).length) data.prs = old.prs;
            setShared("arc.board", { ...boards, [key]: { ...data, refresh_reason: reason, received_ms: Date.now() } });
          }
        } catch { /* malformed output keeps the previous shared board */ }
      }
      delete this.running[key];
      cx.notify();
    });
  }

  ensureConfig(cx, space) {
    if (this.configs[space.id] || this.configLoading.has(space.id)) return;
    this.configLoading.add(space.id);
    cx.spawn(async (cx) => {
      const path = `${appHome()}/data/arc-board/${encodeURIComponent(space.id)}.json`;
      const text = await readTextFile(path).catch(() => null);
      let blocks = DEFAULT_BLOCKS;
      if (text) {
        try {
          const parsed = JSON.parse(text);
          const rows = Array.isArray(parsed) ? parsed : parsed.blocks;
          if (!Array.isArray(rows)) throw new Error("blocks");
          blocks = rows.filter((b) => b && KINDS.has(b.kind)).map((b, i) => ({
            ...b, id: String(b.id ?? `${b.kind}-${i}`), title: String(b.title ?? b.kind),
            source: b.source && typeof b.source === "object" ? b.source : { type: b.kind === "pipeline" ? "gh" : ["stat", "bars"].includes(b.kind) ? "static" : "ai" },
            refresh: String(b.refresh ?? (b.kind === "pipeline" ? "5m" : "agent-stop")),
          }));
          if (!blocks.length) blocks = DEFAULT_BLOCKS;
        } catch { blocks = DEFAULT_BLOCKS; }
      }
      this.configs[space.id] = blocks;
      this.configLoading.delete(space.id);
      cx.notify();
    });
  }

  avatar(t, space, size = 34) {
    const logo = LOGOS[space.name] ?? (shared("arc.logoIds") ?? {})[space.id];
    const fallback = () => h_flex().size(size).flex_none().rounded(Math.round(size * .26)).bg(fill(t, space)).items_center().justify_center()
      .text_size(Math.round(size * .45)).font_bold().text_color("#ffffff").child(initial(space.name));
    const mark = logo ? Avatar.new().w(size).h(size).flex_none().rounded(Math.round(size * .26)).overflow_hidden()
      .image(AvatarImage.new(`mods/arc-sidebar/logos/${logo}.png`).size_full())
      .fallback(AvatarFallback.new().size_full().bg(fill(t, space)).items_center().justify_center()
        .text_size(Math.round(size * .45)).font_bold().text_color("#ffffff").child(initial(space.name))) : fallback();
    return h_flex().flex_none().tooltip(space.name).accessibility_label(`项目 ${space.name}`).child(mark);
  }

  // Phosphor regular (ph/, MIT): flat one-colour glyphs tinted by the caller, so a state keeps one colour everywhere.
  icon(name, size, color) {
    const file = name === "gh" ? "gh.svg" : `ph/${name}.svg`;
    const box = name === "gh" ? size : Math.round(size * 1.15);  // Phosphor leaves ~12% padding inside its box
    return svg(`mods/arc-board/${file}`).size(box).flex_none().text_color(color);
  }

  sourceIcon(t, block) {
    const type = block.source?.type ?? "static";
    const name = type === "ai" ? "ai" : type === "gh" ? "gh" : "terminal";
    const label = type === "ai" ? "DS 读会话" : type === "gh" ? "GitHub / gh" : type === "cmd" ? "命令来源：待批准，未执行" : "配置里的静态值";
    const hint = `${label} · 刷新：${block.refresh ?? "agent-stop"}`;
    return h_flex().size(18).flex_none().items_center().justify_center().text_color(t.dim).tooltip(hint).accessibility_label(hint)
      .child(this.icon(name, 11, t.dim));
  }

  stats(space, data = this.data(space.id), agent = null) {
    const asks = data ? list(data.asks).length : agent ? (agent.status === "blocked" ? 1 : 0) : agents().filter((a) => a.space === space.id && a.status === "blocked").length;
    return { asks, pr: list(data?.prs).length, ready: list(data?.gates).filter((g) => g.ok).length, code: data?.gh_available !== false };
  }

  heroCount(t, icon, number, label, color) {
    return h_flex().gap(3).items_center().tooltip(label).accessibility_label(`${label} ${number}`)
      .child(this.icon(icon, 11, color)).child(div().font_semibold().text_color(t.foreground).child(String(number)))
      .child(div().text_size(11).text_color(t.dim).child(label));
  }

  hero(t, space, data, agent = null) {
    const n = this.stats(space, data, agent);
    return h_flex().gap(10).items_center().child(this.avatar(t, space, 34))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(div().truncate().text_size(16).font_semibold().child(agent?.tab_name ?? space.name))
        .child(h_flex().gap(9).items_center()
          .child(this.heroCount(t, "fork", n.asks, "等你", t.blocked))
          .child(this.heroCount(t, "pr", n.pr, "PR", t.working))
          .child(this.heroCount(t, "ship", n.ready, n.code ? "可上线" : "做完", t.success ?? GREEN))));
  }

  sectionHead(t, block, count, subtitle) {
    return h_flex().h(20).gap(6).items_center()
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child(block.title))
      .when(Boolean(subtitle), (el) => el.child(div().text_size(11).text_color(t.dim).child(subtitle)))
      .child(div().flex_1())
      .when(count != null, (el) => el.child(div().text_size(12).font_semibold().text_color(count > 0 && block.kind === "asks" ? t.blocked : t.foreground).child(String(count))))
      .when((block.source?.type ?? "static") !== "ai", (el) => el.child(this.sourceIcon(t, block)));  // AI is the default; only other sources get a mark
  }

  // Model-written text as a selectable span; escaped so a "#946" or "<b>" stays literal.
  sel(id, text) {
    const html = String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return TextView.html(id, `<span>${html}</span>`).selectable(true);
  }

  empty(t, text) { return div().py(4).text_size(11.5).text_color(t.dim).child(text); }

  since(value) {
    if (typeof value === "number") {
      const ms = value < 1e12 ? value * 1000 : value;
      return { text: ago(Math.max(0, Date.now() - ms)), hint: new Date(ms).toLocaleString() };
    }
    return { text: value || "", hint: "等待时长由 DS 从会话记录抽取" };
  }

  asks(t, data, key) {
    const rows = list(data?.asks);
    if (!data) return this.empty(t, "读取会话中…");
    if (!rows.length) return this.empty(t, "没有等你的事");
    return v_flex().gap(5).children(rows.map((ask, i) => {
      const decision = ask.kind === "decision";
      const color = decision ? t.blocked : t.working;
      const age = this.since(ask.since);
      return h_flex().id(`ask-${i}`).p(9).gap(9).rounded(9).bg(t.raised).items_start()
        .child(h_flex().size(22).flex_none().rounded(6).bg(color + "22").items_center().justify_center()
          .tooltip(decision ? "要你决策" : "要你配合").accessibility_label(decision ? "要你决策" : "要你配合")
          .child(this.icon(decision ? "fork" : "hand", 13, color)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(13).text_color(t.foreground).child(this.sel(`ask-title-${i}`, ask.title)))
          .when(Boolean(ask.detail), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(this.sel(`ask-detail-${i}`, ask.detail))))
          .when(list(ask.options).length > 0 && Boolean(ask.agent), (el) => el.child(this.decide(t, `${key}|${ask.agent}|${ask.title}`, i, ask))))
        .child(v_flex().flex_none().items_end().gap(6)
          .when(Boolean(age.text), (el) => el.child(div().pt(2).text_size(11).text_color(decision ? t.blocked : t.dim)
            .tooltip(age.hint).child(age.text)))
          .child(this.copyButton(t, `ask-copy-${i}`, ask.detail ? `${ask.title}\n${ask.detail}` : ask.title)));
    }));
  }

  decide(t, id, i, ask) {
    const s = this.sends[id];
    const target = agents().find((a) => a.address === ask.agent);
    const tab = target?.tab_name || ask.agent;
    const ok = t.success ?? GREEN;
    if (s && s.state !== "failed") {
      const pct = Math.max(0, Math.min(100, (s.due - Date.now()) / SEND_DELAY_MS * 100));
      const text = s.state === "wait" ? `发给「${tab}」：${s.say}` : s.state === "sending" ? `正在发给「${tab}」…` : `已发给「${tab}」：${s.label}`;
      const row = h_flex().gap(6).items_center()
        .child(this.icon(s.state === "sent" ? "check" : "terminal", 11, s.state === "sent" ? ok : t.working))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(s.state === "sent" ? t.dim : t.foreground).tooltip(s.say).child(text))
        .when(s.state === "wait", (el) => el.child(h_flex().id(`ask-undo-${i}`).px(6).h(20).rounded(5).items_center().cursor_pointer()
          .hover((st) => st.bg(t.hover)).accessibility_label("撤回").text_size(11.5).text_color(t.accent)
          .on_click((_e, cx) => { delete this.sends[id]; cx.notify(); }).child("撤回")));
      if (s.state !== "wait") return v_flex().pt(4).child(row);
      return v_flex().pt(4).gap(4).child(row)
        .child(div().w("100%").h(3).rounded(2).bg(t.hover).tooltip("倒计时结束就发出，期间可撤回")
          .child(div().h(3).rounded(2).w(`${pct}%`).bg(t.working)));
    }
    // Sendable any time: a busy claude queues the pasted reply for its next turn. Only a gone session can't receive.
    const busy = !target;
    const why = busy ? "这个会话已经不在了" : `点了 3 秒后发给「${tab}」，期间可撤回`;
    return h_flex().pt(5).gap(6).items_center()
      .children(list(ask.options).map((opt, j) => h_flex().id(`ask-opt-${i}-${j}`).px(9).h(24).gap(4).rounded(6).items_center()
        .border_1().border_color(opt.rec ? t.accent : t.border).bg(opt.rec ? t.accent + "22" : t.hover)
        .when(busy, (el) => el.opacity(0.45))
        .when(!busy, (el) => el.cursor_pointer().hover((st) => st.border_color(t.foreground))
          .on_click((_e, cx) => { this.sends[id] = { label: opt.label, say: opt.say, agent: ask.agent, due: Date.now() + SEND_DELAY_MS, state: "wait" }; cx.notify(); }))
        .tooltip(`${opt.say}\n${why}`).accessibility_label(`${opt.label}${opt.rec ? "（建议）" : ""}`)
        .child(div().text_size(12).text_color(t.foreground).child(opt.label))
        .when(Boolean(opt.rec), (el) => el.child(div().text_size(10.5).text_color(t.accent).child("★ 建议")))))
      .when(s?.state === "failed", (el) => el.child(div().text_size(11).text_color(t.blocked).tooltip(s.error).child("上次没发出去")));
  }

  copyButton(t, id, text) {
    const done = this.copied?.id === id && Date.now() - this.copied.at < 1500;
    return h_flex().id(id).size(20).rounded(5).items_center().justify_center().cursor_pointer()
      .hover((st) => st.bg(t.hover)).tooltip(done ? "已复制" : "复制").accessibility_label(done ? "已复制" : "复制")
      .on_click((_e, cx) => { cx.write_to_clipboard(text); this.copied = { id, at: Date.now() }; cx.notify(); })
      .child(this.icon(done ? "check" : "copy", 12, done ? (t.success ?? GREEN) : t.dim));
  }

  next(t, space, data) {
    if (!data) return this.empty(t, "读取会话中…");
    if (!data.next?.text) return this.empty(t, "暂无下一步建议");
    // The ETA can be a whole sentence, so it goes under the text instead of beside it.
    return h_flex().p(10).gap(9).rounded(9).bg(fill(t, space) + "22").items_start()
      .child(this.icon("flag", 14, fill(t, space)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(13).child(this.sel("next-text", data.next.text)))
        .when(Boolean(data.next.eta), (el) => el.child(div().text_size(11).text_color(t.dim).child(this.sel("next-eta", data.next.eta)))));
  }

  pipeline(t, data) {
    if (!data) return this.empty(t, "读取 GitHub 中…");
    const rows = list(data.prs);
    const stale = data.gh_state === "unreachable";
    if (!rows.length) return this.empty(t, stale ? "GitHub 暂时读不到" : "没有开着或最近合入的 PR");
    const head = h_flex().gap(3).px(4).children(STAGES.map((name) => div().flex_1().min_w(0).text_center().text_size(10).text_color(t.dim).child(name)));
    const out = v_flex().gap(2).when(stale, (el) => el.child(this.empty(t, "GitHub 暂时读不到，下面是上一次的结果"))).child(head);
    for (const pr of rows) {
      const cells = h_flex().gap(3);
      list(pr.cells).forEach((cell, i) => {
        const color = cell.state === "ok" ? (t.success ?? GREEN) : cell.state === "run" ? t.working : cell.state === "bad" ? t.blocked : t.dim;
        const label = `${STAGES[i]}：${cell.text || "未开始"}`;
        cells.child(h_flex().flex_1().min_w(0).h(20).rounded(4).items_center().justify_center().text_size(10)
          .bg(cell.state ? color + "24" : t.raised).text_color(color).tooltip(label).accessibility_label(label)
          .child(div().truncate().child(cell.text || "")));
      });
      out.child(v_flex().py(7).px(4).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(7).items_baseline().tooltip(`#${pr.number} ${pr.title}${pr.branch ? " · " + pr.branch : ""}`)
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${pr.number}`))
          .child(div().flex_1().min_w(0).text_size(12.5).child(this.sel(`pr-title-${pr.number}`, pr.title))))
        .child(cells));
    }
    return out;
  }

  gates(t, data) {
    if (!data) return this.empty(t, "整理上线项中…");
    const rows = list(data.gates);
    // Projects without a repo have nothing to ship; their gates read as done / stuck.
    const code = data?.gh_available !== false, done = code ? "可上线" : "已做完", notDone = code ? "还不能上线" : "卡住或没做完";
    if (!rows.length) return this.empty(t, code ? "暂无上线结论" : "暂无完成情况");
    return v_flex().p(10).gap(8).rounded(9).bg(t.raised).children(rows.map((gate, i) => {
      // ok null = done but unconfirmed: someone has to look before it counts.
      const unsure = gate.ok === null, color = gate.ok ? (t.success ?? GREEN) : unsure ? t.working : t.blocked;
      const label = gate.ok ? done : unsure ? "待确认" : notDone;
      return h_flex().gap(8).items_start()
        .child(h_flex().flex_none().tooltip(label).accessibility_label(label)
          .child(this.icon(gate.ok ? "ok" : unsure ? "ask" : "bad", 16, color)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12.5).text_color(gate.ok || unsure ? t.foreground : t.dim).child(this.sel(`gate-title-${i}`, gate.title)))
          .when(Boolean(gate.why), (el) => el.child(div().text_size(11).text_color(t.dim).child(this.sel(`gate-why-${i}`, gate.why)))));
    }));
  }

  stat(t, block) {
    const items = Array.isArray(block.items) ? block.items : [{ value: block.value ?? "—", label: block.label ?? block.title, tone: block.tone }];
    return h_flex().gap(6).children(items.map((item) => {
      const color = item.tone === "bad" ? t.blocked : item.tone === "run" ? t.working : item.tone === "ok" ? (t.success ?? GREEN) : t.foreground;
      return v_flex().flex_1().min_w(0).p(9).gap(3).rounded(8).bg(t.raised)
        .child(div().text_size(18).font_semibold().text_color(color).child(String(item.value ?? "—")))
        .child(div().truncate().text_size(11).text_color(t.dim).child(String(item.label ?? "")));
    }));
  }

  bars(t, block) {
    const items = list(block.items);
    if (!items.length) return this.empty(t, "配置里没有 bars.items");
    const max = Math.max(1, ...items.map((item) => Number(item.value) || 0));
    return h_flex().gap(6).children(items.map((item) => {
      const value = Number(item.value) || 0;
      const color = item.color ?? (item.tone === "bad" ? t.blocked : item.tone === "run" ? t.working : t.accent);
      return v_flex().flex_1().min_w(0).gap(3).items_center()
        .child(div().h(14).text_size(10).text_color(t.dim).child(String(item.value ?? 0)))
        .child(h_flex().h(76).w_full().items_end().justify_center()
          .child(div().w(18).h(Math.max(2, Math.round(76 * value / max))).rounded(4).bg(color)))
        .child(div().h(14).max_w(54).truncate().text_size(10).text_color(t.dim).child(String(item.label ?? "")));
    }));
  }

  pending(t) {
    return h_flex().p(10).gap(8).rounded(8).bg(t.raised).items_center().text_color(t.working)
      .child(this.icon("terminal", 13, t.working)).child(div().text_size(12).child("待批准"))
      .child(div().text_size(11).text_color(t.dim).child("命令未执行"));
  }

  section(t, space, block, data, chat = false) {
    if (block.kind === "pipeline" && (data?.gh_available === false || (chat && data && !list(data.prs).length))) return null;
    if (block.kind === "gates" && data?.gh_available === false && block.title === "能不能上线") block = { ...block, title: "完成情况" };
    const count = block.kind === "asks" ? list(data?.asks).length : block.kind === "pipeline" ? list(data?.prs).length : null;
    let body;
    if (block.source?.type === "cmd") body = this.pending(t);
    else if (block.kind === "asks") body = this.asks(t, data, this.currentKey);
    else if (block.kind === "next") body = this.next(t, space, data);
    else if (block.kind === "pipeline") body = this.pipeline(t, data);
    else if (block.kind === "gates") body = this.gates(t, data);
    else if (block.kind === "stat") body = this.stat(t, block);
    else body = this.bars(t, block);
    return v_flex().id(`block-${block.id}`).gap(6)
      .child(this.sectionHead(t, block, count, block.kind === "asks" ? "决策和配合" : null)).child(body);
  }

  segment(t, id, label) {
    const on = this.which === id;
    return h_flex().id(`view-${id}`).h(22).px(8).rounded(5).items_center().justify_center().cursor_pointer()
      .bg(on ? t.hover : t.chrome).text_color(on ? t.foreground : t.dim).text_size(11.5)
      .hover((st) => st.bg(t.hover)).tooltip(label).accessibility_label(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.which = id; localStorage.setItem("view", id); cx.notify(); }).child(label);
  }

  top(t, key) {
    const latest = key ? this.data(key) : null;
    const running = key ? this.running[key] : false;
    const hint = `${running ? "正在刷新" : "点击立即刷新"} · 刷新原因：${latest?.refresh_reason ?? "等待首次刷新"} · 模型：${latest?.ai_status ?? "尚未运行"}`;
    return h_flex().h(43).px(12).gap(7).flex_none().items_center().border_b(1).border_color(t.border)
      .child(this.icon("chart", 14, t.foreground)).child(div().text_size(13).font_semibold().child("进度"))
      .child(h_flex().id("board-refresh").gap(4).px(5).py(2).rounded(5).items_center().text_size(10.5).text_color(t.dim)
        .tooltip(hint).accessibility_label(hint).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { if (key && !running) { this.schedule(key, "all", "手动刷新", 0, true); cx.notify(); } })
        .child(running ? this.icon("refresh", 11, t.working).spin(900) : this.icon("refresh", 11, t.dim))
        // The age of the summary itself; a GitHub recheck alone must not make old content look fresh.
        .child((latest?.summary_ms ?? latest?.generated_ms) ? ago(Date.now() - (latest.summary_ms ?? latest.generated_ms)) : "未刷新"))
      .child(div().flex_1())
      .child(h_flex().p(2).rounded(7).bg(t.background).child(this.segment(t, "chat", "这个对话")).child(this.segment(t, "project", "这个项目")));
  }

  render(cx) {
    const t = theme(), all = spaces(), focus = focused();
    this.observe();
    const focusedAgent = agents().find((a) => a.address === focus?.agent) ?? null;
    const active = this.which === "chat" && focusedAgent
      ? all.find((s) => s.id === focusedAgent.space)
      : all.find((s) => s.id === focus?.space) ?? all.find((s) => s.active) ?? all[0];
    if (active && this.active !== active.id) {
      this.active = active.id;
      this.ensureConfig(cx, active);
    }
    const chat = this.which === "chat";
    const agent = chat && focusedAgent?.app === "claude-code" && focusedAgent.space === active?.id ? focusedAgent : null;
    const key = active ? (chat ? (agent ? `${active.id}#${agent.address}` : null) : active.id) : null;
    if (key && this.currentKey !== key) {
      if (chat) {
        // A GitHub-only recheck can land first and leave data with no model result; that still counts as unread.
        const seen = this.data(key);
        if (!seen || seen.ai_status === "gh-only") this.schedule(key, "all", "首次打开对话");
      } else if (!this.opened.has(key)) {
        this.opened.add(key);
        this.schedule(key, "all", "首次打开项目");
      }
    }
    this.currentKey = key;
    const body = v_flex().flex_1().min_h(0).px(12).py(12).gap(16).overflow_y_scrollbar();
    if (!active) body.child(this.empty(t, "还没有项目"));
    else if (chat && !agent) {
      body.child(v_flex().gap(4)
        .child(this.empty(t, "这个终端不是 Claude 对话"))
        .child(this.empty(t, "可切到「这个项目」查看项目总览")));
    } else {
      const data = this.data(key);
      body.child(this.hero(t, active, data, agent));
      for (const block of this.configs[active.id] ?? DEFAULT_BLOCKS) {
        const section = this.section(t, active, block, data, chat);
        if (section) body.child(section);
      }
    }
    return v_flex().id("arc-board-root").size_full().min_w(0).bg(t.chrome).text_size(13)
      .child(this.top(t, key)).child(body);
  }
}
