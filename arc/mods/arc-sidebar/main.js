// Arc-style sidebar: pinned projects (spaces) as a tile grid on top; the
// chosen project's sessions (tabs) in a card tinted with its color below;
// every other project as a strip of small tiles at the bottom. Right-click a
// tile to pin or unpin it. Space colors are the same as the Spaces list's.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Avatar, AvatarImage, AvatarFallback } from "gpui-base";
import { spaces, agents, run, theme, shared, setShared } from "herdr";

// Same table as the shipped `spaces` mod, so a project has one color everywhere.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const CYCLE = ["ansi4", "ansi3", "ansi6", "ansi5", "ansi2", "ansi1"];
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
// Optional project logos: put a PNG in mods/arc-sidebar/logos/ and list the
// space name here, e.g. { "my-app": "my-app" } for logos/my-app.png. Only listed
// names get an image: a missing file draws blank instead of the initial.
const LOGOS = {};
const COLUMNS = 4;
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
const LABEL = { blocked: "等你处理", done: "已完成", working: "进行中", idle: "空闲" };

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class ArcSidebar extends View {
  init() {
    this.open = { older: false, settled: false };
  }

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

  statusDot(t, status, size = 8) {
    if (status === "blocked" || status === "done") {
      return div().size(size).flex_none().rounded_full().bg(t[status]).border(1.5).border_color(t.chrome);
    }
    if (status === "working") {
      return svg("mods/workspace-chrome/spinner.svg").size(size + 2).flex_none().text_color(t.working).spin(900);
    }
    return null;
  }

  avatar(t, s, size, radius) {
    if (!LOGOS[s.name]) {
      return h_flex().size(size).flex_none().rounded(radius).bg(fill(t, s)).items_center().justify_center()
        .text_size(Math.round(size * 0.48)).font_bold().text_color("#ffffff").child(initial(s.name));
    }
    return Avatar.new().w(size).h(size).flex_none().rounded(radius).overflow_hidden()
      .image(AvatarImage.new(`mods/arc-sidebar/logos/${LOGOS[s.name]}.png`).size_full())
      .fallback(AvatarFallback.new().size_full().bg(fill(t, s)).items_center().justify_center()
        .text_size(Math.round(size * 0.48)).font_bold().text_color("#ffffff").child(initial(s.name)));
  }

  // How many of a project's agents want you: waiting first, else finished unseen.
  badge(t, s, size) {
    const mine = agents().filter((a) => a.space === s.id);
    const blocked = mine.filter((a) => a.status === "blocked").length;
    const done = mine.filter((a) => a.status === "done").length;
    const n = blocked || done;
    if (!n) return s.status === "working" ? this.statusDot(t, "working", size - 6) : null;
    const color = blocked ? t.blocked : t.done;
    return h_flex().h(size).min_w(size).px(n > 9 ? 3 : 0).flex_none().rounded_full().bg(color).border(1.5).border_color(t.chrome)
      .items_center().justify_center().text_size(size * 0.62).font_bold().text_color("#ffffff").child(String(n));
  }

  tile(t, s, all) {
    const color = fill(t, s);
    const dot = this.badge(t, s, 14);
    return v_flex().id(`tile-${s.id}`).flex_1().min_w(0).h(46).rounded(8).gap(3).items_center().justify_center().relative()
      .bg(s.active ? color + "2e" : t.raised).border(1).border_color(s.active ? color : t.border)
      .hover((st) => st.bg(s.active ? color + "3a" : t.hover)).cursor_pointer()
      .tooltip(`${s.name}${s.status ? " · " + LABEL[s.status] : ""}（右键取消置顶）`)
      .accessibility_label(`项目 ${s.name}`)
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.togglePin(s.id, all); })
      .child(this.avatar(t, s, 20, 6))
      .child(div().w_full().px(4).text_size(9.5).text_center().truncate().text_color(s.active ? t.foreground : t.muted).child(s.name))
      .when(Boolean(dot), (el) => el.child(div().absolute().top(2).right(2).child(dot)));
  }

  grid(t, pinnedSpaces, all) {
    const rows = [];
    const tiles = pinnedSpaces.map((s) => this.tile(t, s, all));
    for (let i = 0; i < tiles.length; i += COLUMNS) {
      const slice = tiles.slice(i, i + COLUMNS);
      const row = h_flex().gap(4).children(slice);
      for (let k = slice.length; k < COLUMNS; k++) row.child(div().flex_1());
      rows.push(row);
    }
    return v_flex().gap(4).children(rows);
  }

  tabStatus(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("等你");
    if (status === "done") return div().size(7).mx(3).flex_none().rounded_full().bg(t.done);
    return null;
  }

  tabRow(t, s, tab, color, byTab) {
    const agent = byTab[tab.id];
    const pic = agent ? icon(agent.program, 15, t.foreground) : null;
    const lead = pic ?? svg("mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.dim);
    const status = this.tabStatus(t, tab.status);
    const pinned = Boolean(agent?.pinned);
    return h_flex().id(`tab-${tab.id}`).h(32).px(8).gap(9).items_center().rounded(8)
      .bg(tab.active ? t.background : color + "00")
      .when(tab.active, (el) => el.border(1).border_color(color + "55"))
      .hover((st) => st.bg(tab.active ? t.background : t.hover)).cursor_pointer()
      .tooltip(`${tab.name}${tab.status ? " · " + LABEL[tab.status] : ""}`)
      .on_click(() => run("tab.select", { id: tab.id }))
      .child(lead)
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(tab.settled ? t.dim : t.foreground).child(tab.name))
      .when(pinned, (el) => el.child(svg("mods/workspace-chrome/pin.svg").size(11).flex_none().text_color(color)))
      .when(Boolean(status), (el) => el.child(status))
      .child(div().id(`settle-${tab.id}`).flex_none().size(20).rounded(5).flex().items_center().justify_center()
        .text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
        .tooltip(tab.settled ? "放回列表" : "收起（继续运行）")
        .on_click((_e, cx) => { cx.stop_propagation(); run(tab.settled ? "tab.unsettle" : "tab.settle", { id: tab.id }); })
        .child(svg(`mods/workspace-chrome/${tab.settled ? "chevron-left" : "archive"}.svg`).size(12)));
  }

  fold(t, key, label, hint) {
    return h_flex().id(`fold-${key}`).h(26).px(8).gap(6).items_center().rounded(7).text_size(11.5).text_color(t.dim)
      .hover((st) => st.bg(t.hover)).cursor_pointer().tooltip(hint)
      .on_click((_e, cx) => { this.open[key] = !this.open[key]; cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${this.open[key] ? "down" : "right"}.svg`).size(11))
      .child(label);
  }

  // Agents waiting in other projects, so filtering never hides them.
  waiting(t, active) {
    const rank = { blocked: 0, done: 1 };
    const list = agents().filter((a) => a.space !== active?.id && (a.status === "blocked" || a.status === "done"))
      .sort((a, b) => rank[a.status] - rank[b.status] || b.seq - a.seq);
    if (!list.length) return null;
    const byId = Object.fromEntries(spaces().map((s) => [s.id, s]));
    const rows = list.slice(0, 4).map((a) => {
      const s = byId[a.space];
      return h_flex().id(`wait-${a.address}`).h(28).px(6).gap(8).items_center().rounded(7)
        .hover((st) => st.bg(t.hover)).cursor_pointer()
        .tooltip(`${a.space_name} · ${a.tab_name} · ${LABEL[a.status]}`)
        .on_click(() => run("agent.focus", { terminal: a.address }))
        .when(Boolean(s), (el) => el.child(this.avatar(t, s, 16, 4)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(a.tab_name))
        .child(this.tabStatus(t, a.status));
    });
    const more = list.length - rows.length;
    return v_flex().gap(1)
      .child(div().px(2).pb(2).text_size(11).text_color(t.dim).child(`别的项目在等你 ${list.length}`))
      .children(rows)
      .when(more > 0, (el) => el.child(div().px(8).text_size(11).text_color(t.dim).child(`还有 ${more} 个`)));
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
    const open = [...live.filter(isPinned), ...live.filter((tab) => !isPinned(tab) && !quiet(tab))];
    const older = live.filter((tab) => !isPinned(tab) && quiet(tab));
    const settled = s.tabs.filter((tab) => tab.settled);
    const head = h_flex().h(30).px(4).gap(8).items_center()
      .child(this.avatar(t, s, 18, 5))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(color).child(s.name))
      .when(Boolean(s.branch), (el) => el.child(h_flex().gap(3).items_center().text_size(11).text_color(t.dim)
        .child(svg("mods/workspace-chrome/git-branch.svg").size(11)).child(div().max_w(70).truncate().child(s.branch))))
      .child(div().id("new-tab").size(22).flex_none().rounded(6).flex().items_center().justify_center()
        .text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("在这个项目里新开会话")
        .on_click(() => run("tab.new", { space: s.id })).child(svg("mods/workspace-chrome/plus.svg").size(14)));
    const body = v_flex().gap(2).children(open.map((tab) => this.tabRow(t, s, tab, color, byTab)));
    const card = v_flex().p(6).gap(4).rounded(12).bg(color + "1c").border(1).border_color(color + "40").child(head).child(body);
    if (older.length) {
      card.child(this.fold(t, "older", `较早 ${older.length}`, "超过 12 小时没动静的空闲会话，只是折叠显示，不会被收起"));
      if (this.open.older) card.child(v_flex().gap(2).children(older.map((tab) => this.tabRow(t, s, tab, color, byTab))));
    }
    if (settled.length) {
      card.child(this.fold(t, "settled", `已收起 ${settled.length}`, "收起的会话还在运行，点开可以放回列表"));
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
        .tooltip(`${s.name}${s.status ? " · " + LABEL[s.status] : ""}（右键置顶）`)
        .accessibility_label(`项目 ${s.name}`)
        .cursor_pointer().on_click(() => run("space.select", { id: s.id }))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.togglePin(s.id, all); })
        .child(this.avatar(t, s, 22, 6))
        .when(Boolean(dot), (el) => el.child(div().absolute().top(-3).right(-3).child(dot)));
    });
    return v_flex().gap(6)
      .child(div().px(2).text_size(11).text_color(t.dim).child(`其他项目 ${others.length}`))
      .child(h_flex().flex_wrap().gap(4).children(dots));
  }

  render() {
    const t = theme();
    const all = spaces();
    const pins = this.pinned(all);
    const byId = Object.fromEntries(all.map((s) => [s.id, s]));
    const pinnedSpaces = pins.map((id) => byId[id]).filter(Boolean);
    const others = all.filter((s) => !pins.includes(s.id))
      .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
    const active = all.find((s) => s.active);
    const root = v_flex().id("arc-root").size_full().bg(t.chrome).px(8).pt(4).pb(8).gap(10).overflow_y_scrollbar()
      .child(this.grid(t, pinnedSpaces, all));
    const waiting = this.waiting(t, active);
    if (waiting) root.child(waiting);
    if (active) root.child(this.card(t, active));
    const strip = this.strip(t, others, all);
    if (strip) root.child(div().flex_1().min_h(8)).child(strip);
    return root;
  }
}
