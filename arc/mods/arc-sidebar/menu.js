// The right-click menu for a project (a popup copy of this mod, props.menuFor = space id), and the icon picker it asks
// the sidebar for. The picker runs in the sidebar's own copy: a popup closes when the file dialog takes focus.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, run, theme, shared, setShared, props, exec, appHome, openOverlay, closeOverlay } from "herdr";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// Herdr loads images only from under mods/ (and not from hidden folders), so icons sit inside this mod.
export const ICONS_DIR = "mods/arc-sidebar/icons";

const WORDS = {
  en: { restart: "Restart agent", stopAgent: "Close agent (keep terminal)", resume: "Resume conversation",
    settle: "Settle", putBack: "Put back in the list", deleteTab: "Delete terminal", rename: "Rename", pin: "Pin", unpin: "Unpin", icon: "Change icon…", resetIcon: "Default icon", close: "Close project", prompt: "Pick an image for this project" },
  zh: { restart: "重启 Agent", stopAgent: "关闭 Agent（保留终端）", resume: "恢复对话",
    settle: "收起", putBack: "放回列表", deleteTab: "删除终端", rename: "重命名", pin: "置顶", unpin: "取消置顶", icon: "换图标…", resetIcon: "恢复默认图标", close: "关闭项目", prompt: "选一张图片作为项目图标" },
};
const W = () => WORDS[props()?.lang] ?? WORDS.en;

export function openMenu(space) {
  openOverlay({ mod: "arc-sidebar", kind: "popup", width: 190, height: 220, props: { menuFor: space.id, lang: props()?.lang } });
}

// The right-click menu for a session row: tab = { id, settled, address (a running agent), resumable }.
export function openTabMenu(tab) {
  const rows = (tab.address ? 2 : 0) + (tab.resumable ? 1 : 0) + 3;
  openOverlay({ mod: "arc-sidebar", kind: "popup", width: 210, height: rows * 31 + 29, props: { tabMenu: tab, lang: props()?.lang } });
}

// Glyphs this mod ships (lucide, ISC).
export const GLYPH = (name) => `mods/arc-sidebar/glyphs/${name}.svg`;
const askOp = (op, tab) => setShared("arc.agentOp", { op, tab: tab.id, address: tab.address ?? null, at: Date.now() });

// arc.icons keeps a file name per space id; older saves kept "arc-icons/<path>", read as its flattened name.
const fileOf = (saved) => String(saved).replace(/^arc-icons\//, "").replace(/[^A-Za-z0-9_.-]/g, "_");
export const customIcon = (id) => {
  const saved = (shared("arc.icons") ?? {})[id];
  return typeof saved === "string" && saved ? `${ICONS_DIR}/${fileOf(saved)}` : null;
};

// Pinned ids as the sidebar keeps them: every project until the list is first changed.
const pinnedIds = () => {
  const all = spaces().map((s) => s.id);
  const kept = shared("arc.pinned");
  return Array.isArray(kept) ? kept.filter((id) => all.includes(id)) : all;
};

function menuList(t, items) {
  const done = () => closeOverlay(props().overlay);
  return v_flex().id("arc-menu").w_full().p(5).bg(t.popover).text_size(12.8).children(items.map(([label, icon, act, danger], i) =>
    v_flex().when(Boolean(danger), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
      .child(h_flex().id(`am-${i}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
        .text_color(danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover))
        .accessibility_label(label)
        .on_click(() => { done(); act(); })
        .child(svg(icon.includes("/") ? icon : ICON(icon)).size(14).flex_none().text_color(danger ? t.blocked : t.muted))
        .child(label))));
}

function renderTabMenu(t) {
  const tab = props().tabMenu;
  return menuList(t, [
    [W().rename, "square-pen", () => run("tab.rename", { id: tab.id })],
    ...(tab.address ? [[W().restart, GLYPH("rotate-cw"), () => askOp("restart", tab)],
      [W().stopAgent, GLYPH("power"), () => askOp("stop", tab)]] : []),
    ...(tab.resumable ? [[W().resume, GLYPH("history"), () => askOp("resume", tab)]] : []),
    [tab.settled ? W().putBack : W().settle, tab.settled ? "chevron-left" : "archive",
      () => run(tab.settled ? "tab.unsettle" : "tab.settle", { id: tab.id })],
    // Without `confirmed`, Herdr asks before it ends the terminal.
    [W().deleteTab, "x", () => run("tab.close", { id: tab.id }), true],
  ]);
}

export function renderMenu() {
  const t = theme();
  if (props().tabMenu) return renderTabMenu(t);
  const id = props().menuFor;
  const space = spaces().find((s) => s.id === id);
  if (!space) return div();
  const pinned = pinnedIds().includes(id);
  const items = [
    [W().rename, "square-pen", () => run("space.rename", { id })],
    [pinned ? W().unpin : W().pin, pinned ? "pin-off" : "pin", () => {
      const now = pinnedIds();
      setShared("arc.pinned", pinned ? now.filter((x) => x !== id) : [...now, id]);
    }],
    [W().icon, "folder", () => setShared("arc.iconPick", { id, at: Date.now() })],
    ...(customIcon(id) ? [[W().resetIcon, "minus", () => {
      const icons = { ...(shared("arc.icons") ?? {}) }; delete icons[id]; setShared("arc.icons", icons);
    }]] : []),
    [W().close, "x", () => run("space.close", { id }), true],
  ];
  return menuList(t, items);
}

// In the sidebar copy: when the menu asks, show a file dialog and keep a 256px PNG copy under the app's folder.
export function watchIconPicks(view, cx) {
  view.iconAsked = shared("arc.iconPick")?.at ?? 0;
  cx.timer.every(400, (cx) => {
    const ask = shared("arc.iconPick");
    if (!ask || ask.at <= view.iconAsked) return;
    view.iconAsked = ask.at;
    cx.spawn(async (cx) => {
      const script = `POSIX path of (choose file with prompt "${W().prompt}" of type {"public.image"})`;
      const r = await exec("osascript", ["-e", script]).catch(() => null);
      const src = r?.code === 0 ? r.stdout.trim() : "";
      if (!src) return; // cancelled
      // A remote space's id has a slash ("dl/sp…"); keep the file name flat.
      const name = `${ask.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}.png`;
      // Convert outside the mod: a new file in the mod's folder reloads it, so it moves in last.
      const tmp = `/tmp/arc-icon-${name}`;
      const dest = `${appHome()}/${ICONS_DIR}/${name}`;
      await exec("mkdir", ["-p", `${appHome()}/${ICONS_DIR}`]).catch(() => null);
      // Fit inside 256px, then pad to a square so the rounded tile doesn't stretch a wide logo.
      const out = await exec("sips", ["-s", "format", "png", "-Z", "256", src, "--out", tmp]).catch(() => null);
      if (out?.code !== 0) return;
      await exec("sips", ["-p", "256", "256", tmp]).catch(() => null);
      const old = customIcon(ask.id);
      setShared("arc.icons", { ...(shared("arc.icons") ?? {}), [ask.id]: name });
      if (old) await exec("rm", ["-f", `${appHome()}/${old}`]).catch(() => null);
      await exec("mv", ["-f", tmp, dest]).catch(() => null);
      cx.notify();
    });
  });
}

// In the sidebar copy: run what a row menu asked for through agentctl.py, one op per row at a time.
// view.busy[tab] = op while it runs; shared("agent.resumable") = { tab id: record } of closed agents.
export function watchAgentOps(view, cx) {
  const script = `${appHome()}/mods/arc-sidebar/agentctl.py`;
  view.busy = {};
  view.opAsked = shared("arc.agentOp")?.at ?? 0;
  view.refreshResumable = async () => {
    const r = await exec("python3", ["-I", "-S", script, "list"]).catch(() => null);
    try { if (r?.code === 0) setShared("agent.resumable", JSON.parse(r.stdout)); } catch { /* keep the last list */ }
  };
  view.runOp = (cx, op, tab, address) => {
    if (view.busy[tab]) return;
    view.busy[tab] = op;
    cx.notify();
    cx.spawn(async (cx) => {
      const args = op === "resume" ? [script, op, tab] : [script, op, address, tab];
      await exec("python3", ["-I", "-S", ...args]).catch(() => null);
      await view.refreshResumable();
      delete view.busy[tab];
      cx.notify();
    });
  };
  cx.timer.every(400, (cx) => {
    const ask = shared("arc.agentOp");
    if (!ask || ask.at <= view.opAsked) return;
    view.opAsked = ask.at;
    if (ask.op === "resume" || ask.address) view.runOp(cx, ask.op, ask.tab, ask.address);
  });
}
