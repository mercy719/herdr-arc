// Arc-style sidebar: pinned projects (spaces) as a tile grid on top; the
// chosen project's sessions (tabs) in a card tinted with its color below;
// every other project as a strip of small tiles at the bottom. Right-click a
// tile to pin or unpin it. Space colors are the same as the Spaces list's.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Avatar, AvatarImage, AvatarFallback } from "gpui-base";
import { spaces, agents, run, theme, shared, setShared, props, settings, exec, appHome } from "herdr";
import { openMenu, openTabMenu, renderMenu, watchIconPicks, watchAgentOps, customIcon, GLYPH } from "./menu.js";

// Same table as the shipped `spaces` mod, so a project has one color everywhere.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const CYCLE = ["ansi4", "ansi3", "ansi6", "ansi5", "ansi2", "ansi1"];
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
// Optional project logos: put a PNG in mods/arc-sidebar/logos/ and list the
// space name here, e.g. { "my-app": "my-app" } for logos/my-app.png. Only listed
// names get an image: a missing file draws blank instead of the initial.
// (Anyone can also pick an icon per project from its right-click menu.)
const LOGOS = {};
// Tiles stay about this wide; the column count follows the sidebar width.
// agentnow.py (beside this file) says what each agent is doing; it is rerun this often.
const NOW_EVERY_S = 20;
// Done is green across the sidebar; the theme's ansi green reads grey at dot size.
const DONE_GREEN = "#34c759";
// agentnow.py marks an agent whose latest turn was a scheduled wakeup.
const isAuto = (agent) => Boolean(agent && shared("agent.now")?.[agent.address]?.auto);
const TILE_MIN = 56, GAP = 4, PAD_X = 8;
const columnsFor = (w) => Math.max(2, Math.min(8, Math.floor((w - 2 * PAD_X + GAP) / (TILE_MIN + GAP))));
const OLDER_MS = 12 * 3600 * 1000;

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

function fill(t, space) {
  const stored = (shared("space.colors") ?? {})[space.id];
  // Unset: a stable pick from its id, so it never changes between screens.
  const name = stored ?? CYCLE[hash(space.id) % CYCLE.length];
  return name.startsWith("#") ? name : (MARK[name] ?? t[name] ?? t.accent);
}

const initial = (name) => ([...(name ?? "")][0] ?? "?").toUpperCase();
// Words in both languages; the layout picks one with "props": { "lang": "zh" } (default "en").
const WORDS = {
  en: {
    status: { blocked: "Needs you", done: "Done", working: "Working", idle: "Idle", auto: "Scheduled run done" },
    needsYou: "Needs you", unpinHint: "drag to reorder · right-click for more", pinHint: "right-click for more", renameHint: "double-click to rename · right-click for more", project: "Project",
    more_: "More", rename: "Rename", ops: { stop: "Closing agent…", restart: "Restarting agent…", resume: "Resuming…" },
    waiting: (n) => `${n} ${n === 1 ? "conversation" : "conversations"} waiting on you`, more: (n) => `${n} more`,
    newSession: "New session in this project",
    older: (n) => `Older ${n}`, olderHint: "Idle sessions quiet for 12 hours, only folded, not settled",
    settled: (n) => `Settled ${n}`, settledHint: "Settled sessions keep running; open to put them back",
    others: (n) => `Other projects ${n}`, thisComputer: "This computer", fold: "Fold", unfold: "Unfold",
    ago: (ms) => ms < 60e3 ? "now" : ms < 3600e3 ? `${Math.floor(ms / 60e3)}m ago` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)}h ago` : `${Math.floor(ms / 86400e3)}d ago`,
  },
  zh: {
    status: { blocked: "等你处理", done: "已完成", working: "进行中", idle: "空闲", auto: "定时任务已完成" },
    needsYou: "等你", unpinHint: "拖动排序 · 右键更多操作", pinHint: "右键更多操作", renameHint: "双击重命名 · 右键更多操作", project: "项目",
    more_: "更多", rename: "重命名", ops: { stop: "正在关闭 Agent…", restart: "正在重启 Agent…", resume: "正在恢复对话…" },
    waiting: (n) => `${n} 个对话在等你`, more: (n) => `还有 ${n} 个`,
    newSession: "在这个项目里新开会话",
    older: (n) => `较早 ${n}`, olderHint: "超过 12 小时没动静的空闲会话，只是折叠显示，不会被收起",
    settled: (n) => `已收起 ${n}`, settledHint: "收起的会话还在运行，点开可以放回列表",
    others: (n) => `其他项目 ${n}`, thisComputer: "本机", fold: "折叠", unfold: "展开",
    ago: (ms) => ms < 60e3 ? "刚刚" : ms < 3600e3 ? `${Math.floor(ms / 60e3)} 分钟前` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)} 小时前` : `${Math.floor(ms / 86400e3)} 天前`,
  },
};
const W = () => WORDS[props()?.lang] ?? WORDS.en;
const label = (status) => W().status[status];
// A machine's name for people: props.machines can rename one, e.g. { "cn": "Mac mini", "local": "MacBook Air" }.
const deviceName = (m) => props()?.machines?.[m ?? "local"] ?? m ?? W().thisComputer;
const deviceIcon = (m) => `mods/workspace-chrome/${m ? "server" : "monitor"}.svg`;
const multiDevice = (all) => new Set(all.map((s) => s.machine ?? null)).size > 1;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class ArcSidebar extends View {
  init(_props, cx) {
    if (props()?.menuFor || props()?.tabMenu) { this.menu = true; return; }
    watchIconPicks(this, cx);
    watchAgentOps(this, cx);
    this.watchNow(cx);
    this.open = { older: false, settled: false };
    this.columns = 4;
    this.pressed = this.over = null;
  }

  // One line per agent from agentnow.py into shared("agent.now"), for this list and the board.
  watchNow(cx) {
    const script = `${appHome()}/mods/arc-sidebar/agentnow.py`;
    cx.spawn(async () => {
      while (!this.closed) {
        const r = await exec("python3", ["-I", "-S", script]).catch(() => null);
        if (this.closed) return;
        if (r?.code === 0) {
          try {
            const agents = JSON.parse(r.stdout).agents ?? {};
            const seen = JSON.stringify(agents);
            if (seen !== this.nowSeen) { this.nowSeen = seen; setShared("agent.now", agents); }
          } catch { /* a bad run keeps the last lines */ }
        }
        await this.refreshResumable();
        await exec("sleep", [String(NOW_EVERY_S)]).catch(() => null);
      }
    });
  }

  async close() { this.closed = true; }

  // Pinned ids, in order; until you unpin one, every project (new ones too).
  pinned(all) {
    const ids = new Set(all.map((s) => s.id));
    const kept = shared("arc.pinned");
    if (Array.isArray(kept)) return kept.filter((id) => ids.has(id));
    return all.map((s) => s.id);
  }

  togglePin(id, all) {
    const now = this.pinned(all);
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    setShared("arc.pinned", next);
  }

  // Dragging toward the end of the list drops after the target, else before it.
  dragForward(all, target) {
    const order = this.pinned(all);
    return order.indexOf(this.pressed) < order.indexOf(target);
  }

  move(all, from, target) {
    const order = this.pinned(all);
    const forward = order.indexOf(from) < order.indexOf(target);
    const next = order.filter((id) => id !== from);
    next.splice(next.indexOf(target) + (forward ? 1 : 0), 0, from);
    setShared("arc.pinned", next);
  }

  statusDot(t, status, size = 8) {
    if (status === "blocked" || status === "done") {
      return div().size(size).flex_none().rounded_full().bg(t[status]).border(1.5).border_color(t.chrome);
    }
    if (status === "working") {
      return svg("mods/workspace-chrome/spinner.svg").size(size + 2).flex_none().text_color(t.working).spin(900);
    }
    return null;
  }

  // A bundled logo found by name is remembered by space id (arc.logoIds), so renaming a project keeps it.
  logoOf(s) { return LOGOS[s.name] ?? (shared("arc.logoIds") ?? {})[s.id] ?? null; }

  rememberLogos(all) {
    const kept = shared("arc.logoIds") ?? {};
    const fresh = all.filter((s) => LOGOS[s.name] && kept[s.id] !== LOGOS[s.name]);
    if (fresh.length) setShared("arc.logoIds", { ...kept, ...Object.fromEntries(fresh.map((s) => [s.id, LOGOS[s.name]])) });
  }

  avatar(t, s, size, radius) {
    const custom = customIcon(s.id);
    const logo = this.logoOf(s);
    if (!custom && !logo) {
      return h_flex().size(size).flex_none().rounded(radius).bg(fill(t, s)).items_center().justify_center()
        .text_size(Math.round(size * 0.48)).font_bold().text_color("#ffffff").child(initial(s.name));
    }
    return Avatar.new().w(size).h(size).flex_none().rounded(radius).overflow_hidden()
      .image(AvatarImage.new(custom ?? `mods/arc-sidebar/logos/${logo}.png`).size_full())
      .fallback(AvatarFallback.new().size_full().bg(fill(t, s)).items_center().justify_center()
        .text_size(Math.round(size * 0.48)).font_bold().text_color("#ffffff").child(initial(s.name)));
  }

  // A light per project: red blinks (an agent has a question), green holds (one finished
  // while you were away), amber blinks (still working). Needing you outranks working.
  badge(t, s, size) {
    const mine = agents().filter((a) => a.space === s.id);
    const has = (status) => mine.some((a) => a.status === status) || s.status === status;
    // A finished scheduled run (a /loop or cron wakeup) is blue: worth a glance, not a reply. It ranks under working.
    const doneBy = (auto) => mine.some((a) => a.status === "done" && isAuto(a) === auto);
    const green = t.success ?? DONE_GREEN;
    const [color, period, label] = has("blocked") ? [t.blocked, 700, "blocked"]
      : doneBy(false) ? [green, 0, "done"]
      : has("working") ? [t.working, 1100, "working"]
      : doneBy(true) ? [t.done, 0, "auto"]
      : has("done") ? [green, 0, "done"] : [];
    if (!color) return null;
    const d = Math.round(size * 0.64);
    return div().size(d).flex_none().rounded_full().bg(color).border(1.5).border_color(t.chrome)
      .accessibility_label(W().status[label] ?? label)
      .when(period > 0, (el) => el.loop("opacity", { from: 0.2, to: 1, period }));
  }

  tile(t, s, all) {
    const color = fill(t, s);
    const dot = this.badge(t, s, 14);
    return v_flex().id(`tile-${s.id}`).flex_1().min_w(0).h(46).rounded(8).gap(3).items_center().justify_center().relative()
      .bg(s.active ? color + "2e" : t.raised).border(1).border_color(s.active ? color : t.border)
      .hover((st) => st.bg(s.active ? color + "3a" : t.hover)).cursor_pointer()
      .tooltip(`${s.name}${s.status ? " · " + label(s.status) : ""} (${W().unpinHint})`)
      .accessibility_label(`${W().project} ${s.name}`)
      // Press and drag onto another tile of the same machine to reorder; a plain click selects.
      .when(this.pressed === s.id && this.over && this.over !== s.id, (el) => el.opacity(0.45))
      .when(Boolean(this.pressed) && this.over === s.id && this.pressed !== s.id, (el) => el.child(
        div().absolute().top(4).bottom(4).w(2).rounded(1).bg(t.accent)
          .when(this.dragForward(all, s.id), (line) => line.right(-3))
          .when(!this.dragForward(all, s.id), (line) => line.left(-3))))
      .on_mouse_down("left", () => { this.pressed = s.id; this.over = s.id; })
      .on_mouse_move((_e, cx) => {
        if (!this.pressed) return;
        const from = all.find((x) => x.id === this.pressed);
        const over = from && (from.machine ?? null) === (s.machine ?? null) ? s.id : null;
        if (this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed, over = this.over;
        this.pressed = this.over = null;
        if (from && over === s.id && from !== s.id) this.move(all, from, s.id);
        else if (from === s.id) run("space.select", { id: s.id });
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openMenu(s); })
      .child(this.avatar(t, s, 20, 6))
      .child(div().w_full().px(4).text_size(9.5).text_center().truncate().text_color(s.active ? t.foreground : t.muted).child(s.name))
      .when(Boolean(dot), (el) => el.child(div().absolute().top(4).right(4).child(dot)));
  }

  rows(t, list, all) {
    const rows = [];
    const tiles = list.map((s) => this.tile(t, s, all));
    const n = this.columns;
    for (let i = 0; i < tiles.length; i += n) {
      const slice = tiles.slice(i, i + n);
      const row = h_flex().gap(GAP).children(slice);
      for (let k = slice.length; k < n; k++) row.child(div().flex_1());
      rows.push(row);
    }
    return rows;
  }

  // One block of tiles per machine (this computer first) once there are several.
  grid(t, pinnedSpaces, all) {
    if (!multiDevice(all)) return v_flex().gap(4).children(this.rows(t, pinnedSpaces, all));
    const groups = new Map([[null, []]]);
    for (const s of pinnedSpaces) {
      const m = s.machine ?? null;
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(s);
    }
    const folded = shared("arc.folded") ?? [];
    const blocks = [];
    for (const [m, list] of groups) {
      if (!list.length) continue;
      const key = m ?? "local";
      const shut = folded.includes(key);
      // A folded machine still says how many of its agents need you.
      const ids = new Set(list.map((s) => s.id));
      const mine = agents().filter((a) => ids.has(a.space));
      const blocked = mine.filter((a) => a.status === "blocked").length;
      const done = mine.filter((a) => a.status === "done").length;
      const n = blocked || done;
      const head = h_flex().id(`device-${key}`).h(20).px(2).gap(5).items_center().rounded(5).text_size(11).text_color(t.dim)
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .tooltip(shut ? W().unfold : W().fold).accessibility_label(`${deviceName(m)} ${shut ? W().unfold : W().fold}`)
        .on_click((_e, cx) => { setShared("arc.folded", shut ? folded.filter((k) => k !== key) : [...folded, key]); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${shut ? "right" : "down"}.svg`).size(10).flex_none())
        .child(svg(deviceIcon(m)).size(11).flex_none())
        .child(div().truncate().child(deviceName(m)))
        .child(div().child(String(list.length)))
        .when(shut && n > 0, (el) => el.child(h_flex().h(14).min_w(14).px(n > 9 ? 3 : 0).rounded_full()
          .bg(blocked ? t.blocked : (t.success ?? DONE_GREEN)).items_center().justify_center().text_size(9).font_bold().text_color("#ffffff").child(String(n))));
      blocks.push(v_flex().gap(4).child(head).when(!shut, (el) => el.children(this.rows(t, list, all))));
    }
    return v_flex().gap(6).children(blocks);
  }

  tabStatus(t, status, auto = false) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child(W().needsYou);
    if (status === "done") return div().size(7).mx(3).flex_none().rounded_full().bg(auto ? t.done : (t.success ?? DONE_GREEN));
    return null;
  }

  tabRow(t, s, tab, color, byTab) {
    const agent = byTab[tab.id];
    const pic = agent ? icon(agent.program, 15, t.foreground) : null;
    const lead = pic ?? svg("mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.dim);
    const status = this.tabStatus(t, tab.status, isAuto(agent));
    const pinned = Boolean(agent?.pinned);
    const doing = agent ? shared("agent.now")?.[agent.address]?.now : null;
    return h_flex().id(`tab-${tab.id}`).h(doing ? 42 : 32).px(8).gap(9).items_center().rounded(8)
      .bg(tab.active ? t.background : color + "00")
      .when(tab.active, (el) => el.border(1).border_color(color + "55"))
      .hover((st) => st.bg(tab.active ? t.background : t.hover)).cursor_pointer()
      .tooltip(`${tab.name}${tab.status ? " · " + label(tab.status) : ""}${doing ? " · " + doing : ""} (${W().pinHint})`)
      .on_click(() => run("tab.select", { id: tab.id }))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.tabMenu(tab, agent); })
      .on_hover((on, cx) => { if (on) this.hoverTab = tab.id; else if (this.hoverTab === tab.id) this.hoverTab = null; cx.notify(); })
      .child(lead)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(4).items_center()
          .child(div().min_w(0).flex_shrink(1).truncate().text_size(13).text_color(tab.settled ? t.dim : t.foreground).child(tab.name))
          // The pencil shows on the hovered row only, so a list of rows doesn't read as a list of pencils.
          .when(this.hoverTab === tab.id, (el) => el.child(div().id(`rename-${tab.id}`).flex_none().size(18).rounded(4)
            .flex().items_center().justify_center().text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
            .tooltip(W().rename).accessibility_label(W().rename)
            .on_click((_e, cx) => { cx.stop_propagation(); run("tab.rename", { id: tab.id }); })
            .child(svg("mods/workspace-chrome/square-pen.svg").size(12)))))
        .when(Boolean(doing), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(doing))))
      .when(pinned, (el) => el.child(svg("mods/workspace-chrome/pin.svg").size(11).flex_none().text_color(color)))
      .when(Boolean(status), (el) => el.child(status))
      .child(this.rowAction(t, tab, agent));
  }

  tabMenu(tab, agent) {
    openTabMenu({ id: tab.id, settled: tab.settled, address: agent?.app === "claude-code" ? agent.address : null,
      resumable: Boolean(shared("agent.resumable")?.[tab.id]) });
  }

  // One button per row: a spinner while an op runs, otherwise ⋯ for the row menu (same as right-click).
  rowAction(t, tab, agent) {
    const busy = this.busy?.[tab.id];
    const box = div().id(`act-${tab.id}`).flex_none().size(20).rounded(5).flex().items_center().justify_center();
    if (busy) return box.tooltip(W().ops[busy]).accessibility_label(W().ops[busy])
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900));
    return box.text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip(W().more_).accessibility_label(W().more_)
      .on_click((_e, cx) => { cx.stop_propagation(); this.tabMenu(tab, agent); })
      .child(svg(GLYPH("ellipsis")).size(14));
  }

  fold(t, key, label, hint) {
    return h_flex().id(`fold-${key}`).h(26).px(8).gap(6).items_center().rounded(7).text_size(11.5).text_color(t.dim)
      .hover((st) => st.bg(t.hover)).cursor_pointer().tooltip(hint)
      .on_click((_e, cx) => { this.open[key] = !this.open[key]; cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${this.open[key] ? "down" : "right"}.svg`).size(11))
      .child(label);
  }

  // Agents waiting in other projects, so filtering never hides them.
  // A section title that folds its section; remembered with the machine folds in arc.folded.
  // `count`, when given, is drawn highlighted where it appears in `text`.
  sectionHead(t, key, text, count, tone) {
    const folded = shared("arc.folded") ?? [];
    const shut = folded.includes(key);
    return h_flex().id(`head-${key}`).h(20).px(2).gap(5).items_center().rounded(5).text_size(11).text_color(t.dim)
      .hover((st) => st.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .tooltip(shut ? W().unfold : W().fold).accessibility_label(`${text} ${shut ? W().unfold : W().fold}`)
      .on_click((_e, cx) => { setShared("arc.folded", shut ? folded.filter((k) => k !== key) : [...folded, key]); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${shut ? "right" : "down"}.svg`).size(10).flex_none())
      .child(this.withCount(text, count, tone));
  }

  withCount(text, count, tone) {
    const at = count == null ? -1 : text.indexOf(String(count));
    if (at < 0) return div().truncate().child(text);
    const n = String(count);
    return h_flex().min_w(0).items_center()
      .when(at > 0, (el) => el.child(div().flex_none().child(text.slice(0, at))))
      .child(div().flex_none().font_semibold().text_color(tone).child(n))
      .child(div().min_w(0).truncate().child(text.slice(at + n.length)));
  }

  folded(key) { return (shared("arc.folded") ?? []).includes(key); }

  waiting(t, active) {
    const rank = (a) => (a.status === "blocked" ? 0 : isAuto(a) ? 2 : 1);
    const list = agents().filter((a) => a.space !== active?.id && (a.status === "blocked" || a.status === "done"))
      .sort((a, b) => rank(a) - rank(b) || b.seq - a.seq);
    if (!list.length) return null;
    const byId = Object.fromEntries(spaces().map((s) => [s.id, s]));
    const head = this.sectionHead(t, "@waiting", W().waiting(list.length), list.length, t.blocked);
    if (this.folded("@waiting")) return head;
    const rows = list.slice(0, this.open.waitAll ? list.length : 4).map((a) => {
      const s = byId[a.space];
      // When it stopped to wait or finished: the tab's last status change.
      const at = s?.tabs?.find((tab) => tab.id === a.tab)?.changed_at ?? null;
      return h_flex().id(`wait-${a.address}`).h(28).px(6).gap(8).items_center().rounded(7)
        .hover((st) => st.bg(t.hover)).cursor_pointer()
        .tooltip(`${a.space_name} · ${a.tab_name} · ${label(a.status)}`)
        .on_click(() => run("agent.focus", { terminal: a.address }))
        .when(Boolean(s), (el) => el.child(this.avatar(t, s, 16, 4)))
        .child(h_flex().flex_1().min_w(0).gap(6).items_baseline()
          .child(div().flex_shrink(1).min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(a.tab_name))
          .child(div().flex_shrink(1).min_w(0).truncate().text_size(11).text_color(t.dim).child(a.space_name)))
        .when(Boolean(at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(W().ago(Date.now() - at))))
        .child(this.tabStatus(t, a.status, isAuto(a)));
    });
    const more = list.length - rows.length;
    return v_flex().gap(1).child(head).children(rows)
      .when(more > 0, (el) => el.child(div().id("wait-more").px(8).h(20).flex().items_center().rounded(5).text_size(11).text_color(t.dim)
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click((_e, cx) => { this.open.waitAll = true; cx.notify(); })
        .child(W().more(more))));
  }

  card(t, s) {
    const color = fill(t, s);
    const byTab = {};
    for (const a of agents()) if (a.space === s.id && !byTab[a.tab]) byTab[a.tab] = a;
    const now = Date.now();
    const quiet = (tab) => !tab.active && (tab.status === "idle" || !tab.status) && tab.changed_at && now - tab.changed_at > OLDER_MS;
    const live = s.tabs.filter((tab) => !tab.settled);
    const isPinned = (tab) => Boolean(byTab[tab.id]?.pinned);
    // Arc's Pinned above Today: pinned agents first, then the rest in their order.
    // Within each, tabs running a coding agent come before plain terminals.
    const agentFirst = (list) => [...list.filter((tab) => byTab[tab.id]), ...list.filter((tab) => !byTab[tab.id])];
    const open = [...agentFirst(live.filter(isPinned)), ...agentFirst(live.filter((tab) => !isPinned(tab) && !quiet(tab)))];
    const older = live.filter((tab) => !isPinned(tab) && quiet(tab));
    const settled = s.tabs.filter((tab) => tab.settled);
    const head = h_flex().h(30).px(4).gap(8).items_center()
      .child(this.avatar(t, s, 18, 5))
      .child(div().id("project-name").flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(color)
        .cursor_pointer().tooltip(W().renameHint).accessibility_label(`${s.name} · ${W().renameHint}`)
        .on_click((e, _cx) => { if (e?.click_count >= 2) run("space.rename", { id: s.id }); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openMenu(s); })
        .child(s.name))
      .when(multiDevice(spaces()), (el) => el.child(h_flex().id("device").gap(3).items_center().text_size(11).text_color(t.dim)
        .tooltip(deviceName(s.machine ?? null)).child(svg(deviceIcon(s.machine ?? null)).size(11))
        .child(div().max_w(70).truncate().child(deviceName(s.machine ?? null)))))
      .when(Boolean(s.branch), (el) => el.child(h_flex().gap(3).items_center().text_size(11).text_color(t.dim)
        .child(svg("mods/workspace-chrome/git-branch.svg").size(11)).child(div().max_w(70).truncate().child(s.branch))))
      .child(div().id("new-tab").size(22).flex_none().rounded(6).flex().items_center().justify_center()
        .text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(W().newSession)
        .on_click(() => run("tab.new", { space: s.id })).child(svg("mods/workspace-chrome/plus.svg").size(14)));
    const body = v_flex().gap(2).children(open.map((tab) => this.tabRow(t, s, tab, color, byTab)));
    const card = v_flex().p(6).gap(4).rounded(12).bg(color + "1c").border(1).border_color(color + "40").child(head).child(body);
    if (older.length) {
      card.child(this.fold(t, "older", W().older(older.length), W().olderHint));
      if (this.open.older) card.child(v_flex().gap(2).children(older.map((tab) => this.tabRow(t, s, tab, color, byTab))));
    }
    if (settled.length) {
      card.child(this.fold(t, "settled", W().settled(settled.length), W().settledHint));
      if (this.open.settled) card.child(v_flex().gap(2).children(settled.map((tab) => this.tabRow(t, s, tab, color, byTab))));
    }
    return card;
  }

  strip(t, others, all) {
    if (!others.length) return null;
    const dots = others.map((s) => {
      const dot = this.badge(t, s, 13);
      return div().id(`other-${s.id}`).relative().flex_none().rounded(7).p(2)
        .when(s.active, (el) => el.border(1.5).border_color(fill(t, s)))
        .tooltip(`${s.name}${s.status ? " · " + label(s.status) : ""} (${W().pinHint})`)
        .accessibility_label(`${W().project} ${s.name}`)
        .cursor_pointer().on_click(() => run("space.select", { id: s.id }))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openMenu(s); })
        .child(this.avatar(t, s, 22, 6))
        .when(Boolean(dot), (el) => el.child(div().absolute().top(-3).right(-3).child(dot)));
    });
    const head = this.sectionHead(t, "@others", W().others(others.length));
    if (this.folded("@others")) return head;
    return v_flex().gap(6).child(head).child(h_flex().flex_wrap().gap(4).children(dots));
  }

  render() {
    if (this.menu) return renderMenu();
    const t = theme();
    const all = spaces();
    this.rememberLogos(all);
    const pins = this.pinned(all);
    const byId = Object.fromEntries(all.map((s) => [s.id, s]));
    const pinnedSpaces = pins.map((id) => byId[id]).filter(Boolean);
    const others = all.filter((s) => !pins.includes(s.id))
      .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
    const active = all.find((s) => s.active);
    const root = v_flex().id("arc-root").size_full().bg(t.chrome).px(PAD_X).pt(4).pb(8).gap(10).overflow_y_scrollbar()
      .on_mouse_up("left", (_e, cx) => { if (this.pressed) { this.pressed = this.over = null; cx.notify(); } })
      .on_size_change((size, cx) => {
        const n = columnsFor(size.width / (settings().zoom || 1));
        if (n !== this.columns) { this.columns = n; cx.notify(); }
      })
      .child(this.grid(t, pinnedSpaces, all));
    // The open project sits under its tile; who else is waiting sits at the bottom, out of the way.
    if (active) root.child(this.card(t, active));
    const waiting = this.waiting(t, active);
    const strip = this.strip(t, others, all);
    if (waiting || strip) root.child(div().flex_1().min_h(8));
    if (waiting) root.child(waiting);
    if (strip) root.child(strip);
    return root;
  }
}
