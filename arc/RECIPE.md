# Arc

An Arc / Dia style sidebar for Herdr. Projects sit in a grid of tiles at the
top; click one and the sidebar shows only that project's sessions, so it's
less to read.

![Arc](preview.png)

This file is the brief: enough to build Arc from an empty folder. The files
next to it are one build of it. The sidebar's own words are in Chinese
(等你 = needs you, 别的项目在等你 = other projects waiting on you, 较早 =
older, 已收起 = settled); swap the strings in `mods/arc-sidebar/main.js`
for your language.

## What you see

The `main` layout with its left sidebar replaced, top to bottom:

1. **Header** (`mods/arc-chrome`, a copy of the shipped `workspace-chrome`
   header): Herdr mark, then **+ new project**, search, sidebar toggle.
2. **Project tiles**, 4 columns, 46px high: each project (space) is a
   colored initial (or a logo you add) with its name under it. The selected
   one is tinted and outlined in its color. The corner badge counts that
   project's agents that need you (blocked first, else done and unseen); a
   spinner when one is only working. Every project is pinned until you
   change it: right-click a tile to unpin, right-click a project in the
   bottom strip to pin it back. No limit.
3. **Other projects waiting on you**: up to four blocked or done agents from
   other projects, each with its project's mark. Click to jump there.
   Filtering to one project never hides work that needs you.
4. **The project card**, tinted in the project's color: its name and branch,
   + new session, then one row per tab with the agent's icon, its name and
   status (spinner, 等你 badge, or done dot) and a settle button.
   - Pinned agents (`terminal.pin`) come first, like Arc's Pinned over Today.
   - Idle tabs untouched for 12 hours fold into **较早 N** (only folded,
     never closed).
   - Settled tabs fold into **已收起 N**. Nothing is settled automatically:
     working or waiting agents stay in the list.
5. **Other projects**: unpinned projects as small marks along the bottom,
   ones that need you first. Empty while everything is pinned.

Project colors are the same table as the shipped Spaces list, and
`shared("space.colors")` wins, so a project has one color everywhere.

## Logos

To show a project's own logo instead of its initial, put a PNG in
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
