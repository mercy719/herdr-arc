# Arc

An Arc / Dia style sidebar for Herdr, with an agent board. Projects sit in a
grid of tiles at the top; click one and the sidebar shows only that project's
sessions, each with a line saying what its agent is doing. A board beside the
terminals takes your todos to agents and back for review.

![Arc](preview.png)

This file is the brief: enough to build Arc from an empty folder. The files
next to it are one build of it.

The sidebar speaks English or Chinese. Mods can't see the system language,
so the layout picks it: `"props": { "lang": "zh" }` on the `arc-sidebar` and
`arc-chrome` blocks in `layouts/arc.json` (`"en"` is the default).
[中文界面截图](preview-zh.png) · [看板（演示数据）](preview-board-zh.png)

## What you see

The `main` layout with its left sidebar replaced, top to bottom:

1. **Header** (`mods/arc-chrome`, a copy of the shipped `workspace-chrome`
   header): Herdr mark, then **+ new project**, search, sidebar toggle.
2. **Project tiles**, 46px high, as many columns as fit (4 at 268px; 2 to 8
   as you drag the sidebar). Each project (space) is a colored initial, a logo
   you list, or an icon picked from its menu, with its name under it. The
   selected one is tinted and outlined in its color. A light in the corner
   says what its agents are doing:

   | light | means |
   | --- | --- |
   | red, blinking | an agent is waiting on you |
   | green, steady | an agent finished what you asked |
   | amber, blinking | still working |
   | blue, steady | a scheduled run (a `/loop` or cron wakeup) finished |

   The first that applies wins, in that order. Drag a tile onto another tile
   of the same machine to reorder. With projects on more than one machine,
   the tiles split into one foldable block per machine (this computer first).
   Rename machines with `"props": { "machines": { "local": "MacBook Air",
   "cn": "Mac mini" } }` on the `arc-sidebar` block.
3. **The project card**, tinted in the project's color: its name (double-click
   to rename), + new session, then one row per tab. Tabs running a coding
   agent come before plain terminals; pinned agents (`terminal.pin`) first of
   all. Under each agent's name a grey line says what it is doing now, from
   `agentnow.py`. Idle tabs untouched for 12 hours fold into **Older N**;
   settled tabs into **Settled N**. Hovering a row shows a pencil after its
   name (rename). Each row ends in **⋯**, the same menu as right-click: Rename,
   Restart agent, Close agent (keep terminal), Resume conversation (after a
   close), Settle / Put back, Delete terminal (`tab.close`, which asks first).
   A spinner stands in for ⋯ while one runs.
4. A spacer, then at the bottom:
   - **N conversations waiting on you** (N highlighted): blocked or done agents elsewhere, with
     their project's name and how long ago they stopped. Click to jump there.
     Foldable; "N more" opens the rest.
   - **Other projects**: unpinned projects as small marks. Foldable.
5. **Right-click** a tile, a mark or the card's name for a menu: Rename, Pin /
   Unpin, Change icon… (a file dialog; the image is padded to a 256px square),
   Default icon, Close project.

In the tab row, a two-cell pill switches the main area between the terminals
and the **board** (`mods/agent-board`). Picking a tab switches back.

## The board

Four columns: To do → In progress → To review → Accepted. Cards come from two
places:

- **Your todos.** Click the To do column (or "Add todo") and type; paste
  (`cmd+v`) or drop images in too. Enter adds it; clicking elsewhere saves it,
  or drops it when empty. Drag a card to In progress and pick a session: an
  idle one gets the text at once (`hc send`, images as paths on their own
  lines, copied over with `hc put` for another machine); a busy one queues it
  until it's free. When that session's next turn ends, the card moves to To
  review. **Pass** accepts it; **Fail** asks for a reason and sends it back.
  Only you can put a card in Accepted.
- **The agent's own task list** (Claude Code's TaskCreate/TaskUpdate, or the
  older TodoWrite), read from the transcript. Read-only, marked with a robot.

The board shows the current project; "All" shows every project, filterable by
project mark. Cards live in `shared("board.cards")`, accepted agent tasks in
`shared("board.accepted")`.

## How it behaves

- **What each agent is doing.** `mods/arc-sidebar/agentnow.py` runs every 20
  seconds (`python3 -I -S`). It lists Claude Code terminals with `hc ls`
  (other machines' too), finds each one's transcript, reads its tail, and asks
  a small model for a one-line summary when the activity changed (at most
  every 30 s per agent; cached in `~/.cache/herdr-agent-board/`). The result
  goes to `shared("agent.now")`, which the sidebar and the board read. A turn
  started by a scheduled wakeup (`turnOrigin: "scheduled"` in the transcript)
  marks the agent `auto`, which is what makes its light blue.
- **Clicks.** A tile or mark runs `space.select`; a waiting row runs
  `agent.focus`; a tab row selects its tab, and its ⋯ opens the row menu.
- **Close, resume, restart** (`agentctl.py`, Claude Code only). Close remembers
  the session id, cwd and the flags worth keeping (`--model`,
  `--dangerously-skip-permissions`, …) in `~/.cache/herdr-agent-board/resume.json`,
  then sends claude TERM (KILL after 8 s); the terminal falls back to its
  shell. Resume writes `cd <cwd> && claude <flags> --resume <id>` to
  `/tmp/herdr-resume-<terminal>.sh` and types `. /tmp/herdr-resume-<terminal>.sh`
  into the shell. Restart is both, with plain `claude`, so a freshly updated
  install takes over the conversation.
  The card's + runs `tab.new`; the header's + runs `space.new`.
- Pins in `shared("arc.pinned")` (until the first change every project is
  pinned, new ones included); tile order is the pin order. Folds in
  `shared("arc.folded")`, icons in `shared("arc.icons")`, and a listed logo is
  remembered by space id in `shared("arc.logoIds")`, so renaming keeps it.
- Hovers show the full name, status and what it's doing in a tooltip.

## Built from

- `layouts/arc.json`: the shipped `main` window. Sidebar column, 268px and
  draggable: `brand` (46px, `arc-chrome`), `projects` (`arc-sidebar`), footer
  (shipped `workspace-chrome` with `props.footer`). Work column: a `tabs-row`
  with the shipped `tabs` and a `board-toggle` block (`agent-board` with
  `props.role: "toggle"`); under it a `main-stack` stack holding the terminals
  (`main`) and the `board` block. Every arc block takes `props.lang`.
- `mods/arc-sidebar`: `main.js` (the sidebar), `menu.js` (the right-click
  popup, a copy of this mod opened with `openOverlay`, and the icon picker),
  `agentnow.py`, `agentctl.py` (close / resume / restart). Icons from the
  shipped `mods/workspace-chrome/*.svg`, plus `glyphs/` (lucide, ISC).
- `mods/agent-board`: `main.js` (the board), `board-logic.js` (card states,
  sends, queueing; no Herdr imports), `toggle.js` (the pill), `images.js`
  (clipboard and dropped images; adapted from claude-chat, MIT).
- `mods/arc-chrome`: the shipped `workspace-chrome` header plus a +.
- `tests/`: `node --test tests/board-logic.test.js` and
  `python3 -m unittest discover -s tests`.

## Watch out

- **What leaves the machine.** `agentnow.py` sends a short digest of each
  agent's recent activity (its last prompt, tool names and arguments, up to
  1,500 characters) to the model endpoint in your Claude Code settings
  (`ANTHROPIC_BASE_URL` in `~/.claude/settings.json` `env`, or the
  environment), model `MODEL` at the top of the file (`deepseek-v4.1-flash`,
  for a gateway that routes it). Change `MODEL` to one your endpoint serves,
  or the grey lines stay empty; nothing else breaks.
- It never reads `~/.claude/sessions/*.key`. Only the board and the row menu
  type into terminals, and only after you drag or click.
- `hc send` always wraps text in an `<hc from=…>` note, which claude reads as
  a message and a shell can't parse; that is why close is a signal and resume
  types keys. `hc keys` knows letters, digits, space and `. / -`, and types
  capitals as small letters, hence the lowercase `/tmp` path.
- Resume needs the conversation to have at least one message; an empty one
  was never saved. Closing a working agent cuts its turn short.
- Herdr loads images only from under `mods/` and not from hidden folders, so
  picked icons go to `mods/arc-sidebar/icons/` (written last: a new file in a
  mod's folder reloads it). A missing `AvatarImage` file draws nothing, not
  its fallback.
- A gateway may refuse a long digest; the script retries with a shorter one,
  then keeps the last line.
- Mods can't read the system language, hence `props.lang`.
- `done` only shows if the agent went working → done while unseen.
- Statuses and summaries lag up to ~20 s; a queued card goes out on the next
  refresh after its session frees up.
- `arc-chrome` is a copy: it won't pick up later changes to the shipped header.

## Done when

- Every project shows as a tile; widening the sidebar adds columns.
- A blocked agent elsewhere blinks red on its tile and appears at the bottom
  under "waiting on you", with its project and how long ago.
- Each agent row has a grey "doing now" line within a minute.
- Dragging a tile reorders it; right-click offers rename, pin and icon.
- A todo dragged to In progress reaches an idle session; when its turn ends
  the card is in To review; Fail sends the reason back.
- `"lang": "zh"` switches every word to Chinese.

## Logos

Right-click a project → Change icon… is the quick way. To ship logos with the
layout instead, put a PNG in
`mods/arc-sidebar/logos/` and list the space name in `LOGOS` at the top of
`mods/arc-sidebar/main.js`. Only listed names get an image: Herdr draws a
missing image as blank, not as the fallback.

## Install

Copy `layouts/arc.json` and `mods/` into `~/.config/herdr-app/`, run
`herdr-app check mods/arc-sidebar`, then `herdr-app do layout.switch
'{"name":"arc"}'` (or `ctrl-shift-l`). The last layout you used is the one
Herdr opens with.

## Why it looks like this

Arc puts global Favorites on top and switches Spaces at the bottom; Zen and
Floorp do much the same. Here the top grid *is* the project switcher, since
in Herdr a project is the thing you switch between. Things left out on
purpose: shared favorites across projects, profiles, and Arc's automatic
archiving of everything (only you settle a session here).
