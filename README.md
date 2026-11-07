# herdr-arc

An Arc / Dia style sidebar layout for [Herdr](https://herdr.dev): projects as
a tile grid on top with status lights, click one to see only its sessions and
what each agent is doing, plus a board that hands your todos to agents.

![Arc](arc/preview.png)

| Layout | |
| --- | --- |
| [Arc](arc/) | project tiles with status lights, the chosen project's sessions with a "doing now" line, a todo → review board |

Install: copy `arc/layouts/arc.json` and `arc/mods/` into
`~/.config/herdr-app/`, then `herdr-app do layout.switch '{"name":"arc"}'`.
English and Chinese: set `"lang": "zh"` in the layout for Chinese ([screenshot](arc/preview-zh.png)).
See [arc/RECIPE.md](arc/RECIPE.md) for what it does and how to rebuild it.

`mods/arc-chrome` is adapted from Herdr's `workspace-chrome` mod
(Apache-2.0); `mods/agent-board/images.js` from claude-chat (MIT).
Everything else here is Apache-2.0.

`agentnow.py` sends a short digest of each agent's activity to the model
endpoint in your Claude Code settings; see [Watch out](arc/RECIPE.md#watch-out).
