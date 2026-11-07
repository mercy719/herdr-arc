# herdr-arc

An Arc / Dia style sidebar layout for [Herdr](https://herdr.dev): projects as
a tile grid on top, click one to see only its sessions.

![Arc](arc/preview.png)

| Layout | |
| --- | --- |
| [Arc](arc/) | project tiles on top, the chosen project's sessions in a tinted card, agents that need you never hidden |

Install: copy `arc/layouts/arc.json` and `arc/mods/` into
`~/.config/herdr-app/`, then `herdr-app do layout.switch '{"name":"arc"}'`.
English and Chinese: set `"lang": "zh"` in the layout for Chinese ([screenshot](arc/preview-zh.png)).
See [arc/RECIPE.md](arc/RECIPE.md) for what it does and how to rebuild it.

`mods/arc-chrome` is adapted from Herdr's `workspace-chrome` mod
(Apache-2.0). Everything here is Apache-2.0.
