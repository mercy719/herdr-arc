// The board's switch in the tab row: shows the board in place of the terminals,
// and hands the space back to the terminals as soon as you pick a tab.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, props, run, setShared, shared, theme } from "herdr";
import { deriveCards } from "./board-logic.js";

const STACK = "main-stack";

export function showBoard(on) {
  run("layout.select", { stack: STACK, child: on ? "board" : "main" });
  setShared("board.shown", on);
}

export function initToggle(view, cx) {
  view.lastTab = focused()?.tab ?? null;
  cx.timer.every(700, (cx) => {
    const tab = focused()?.tab ?? null;
    if (tab === view.lastTab) return;
    view.lastTab = tab;
    if (shared("board.shown")) { showBoard(false); cx.notify(); }
  });
}

// A two-cell pill like a segmented control: terminals | board, with the review count on the board cell.
export function renderToggle() {
  const t = theme();
  const zh = props()?.lang === "zh";
  const on = Boolean(shared("board.shown"));
  const cards = deriveCards({
    cards: Array.isArray(shared("board.cards")) ? shared("board.cards") : [],
    agents: shared("agent.now") ?? {},
    accepted: Array.isArray(shared("board.accepted")) ? shared("board.accepted") : [],
  });
  const review = cards.filter((c) => c.state === "review").length;
  // Mouse down, not on_click: a press's mouse down arrives where its click sometimes doesn't.
  const cell = (board, icon, label) => h_flex().id(`board-${board ? "on" : "off"}`).w(30).h(24).flex_none()
    .items_center().justify_center().rounded(12).relative().cursor_pointer()
    .tooltip(label).accessibility_label(label)
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (board !== on) showBoard(board); cx.notify(); })
    .child(svg(icon).size(14).text_color(board === on ? t.background : t.muted))
    .when(board && review > 0, (el) => el.child(div().absolute().top(-5).right(-5).h(14).min_w(14).px(3).rounded_full()
      .bg(t.done).border(1.5).border_color(t.chrome).flex().items_center().justify_center()
      .text_size(9).font_bold().text_color("#ffffff").child(String(review))));
  const pill = h_flex().p(2).h(30).flex_none().items_center().rounded(15).relative().bg(t.surface).border(1).border_color(t.border)
    .child(div().absolute().top(2).h(24).w(30).rounded(12).bg(t.solid ?? t.foreground)
      .left(on ? 32 : 2).spring("left", { response: 240, damping: 0.86 }))
    .child(cell(false, "mods/agent-board/terminal.svg", zh ? "终端" : "Terminals"))
    .child(cell(true, "mods/agent-board/board.svg", zh ? `看板 · 待验收 ${review}` : `Board · ${review} to review`));
  return h_flex().size_full().min_w(0).pr(10).items_center().justify_end().child(pill);
}
