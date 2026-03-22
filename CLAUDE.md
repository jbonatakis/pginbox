# pginbox

## Database

Connect to local Postgres via `psql`:

```
psql postgresql://pginbox:pginbox@localhost:5499/pginbox
```

Or use `make pgcli` for an interactive session (pgcli is interactive-only, no `-c` flag).

## Python
Use pytest for all testing

## Frontend CSS

### Shell grid stretch (recurring bug)
The `.shell` in `App.svelte` uses `grid-template-rows: auto 1fr auto`, which gives `.content` a fixed viewport-filling height. This cascades through nested `display: grid` containers via the default `align-content: stretch`, distributing extra height among auto-sized rows. Any flex container that becomes taller than its content will then stretch its children (flex default `align-items: stretch`), visually distorting buttons, tabs, etc. Most visible on short pages / empty states.

**Fix:** Always add `align-content: start` to page-level grid containers. Add `align-items: center` to flex row containers (tab bars, button rows).