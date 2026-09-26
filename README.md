# Click Counter (siyuan-click-counter)

Double-click the number in a block to count up — made for small counters in daily notes and checklists such as
`water: 1 time` or `1/7`. A single click still behaves as normal editing.

## Install

- SiYuan → <kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Plugins</kbd>, search "Click Counter", or
- download `package.zip` from the latest GitHub Release and install it from
  <kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Downloaded</kbd>.

## What counts

A block counts when its first line matches one of the rules, or when it carries the `custom-click-counter` attribute.
The default rules cover:

| Example | After a double-click |
| --- | --- |
| `water: 1 time`, `coffee: 2 cups`, `push-ups: 30 reps` | `water: 2 times`, `coffee: 3 cups`, `push-ups: 31 reps` |
| `water ×3`, `water ✕3` | `water ×4` |
| `1/7`, `water: 1/7`, `study 3/10` | `2/7`, `water: 2/7`, `study 4/10` — only the number before the slash changes, and it stops at the denominator |

## Usage

| Action | Result |
| --- | --- |
| Double-click the block | ± step; the block flashes and a toast shows the new value |
| Single click | Normal editing / caret, no counting |
| `Alt` (or Ctrl/Shift) + double-click | No counting — use this to select a word inside a countable block |
| Block icon menu | "Count +1" / "Count -1" |
| Command palette | open settings, ±1 on the block at the cursor, diagnose, check UI-only blocks |

Rapid double-clicks are queued and summed up, so none are lost. The value never goes below 0, and `N/M` stops at `M`.

## Block attribute `custom-click-counter`

| Value | Meaning |
| --- | --- |
| `off` / `no` / `false` / `0` | This block is not counted |
| `+1` / `-1` / `2` | Per-block step (a negative value means a double-click decreases) |
| anything else (e.g. `on`) | Force enable; if no rule matches, fall back to "change the last number in the line", e.g. `push-ups 30` |

## Not counted

- Code blocks, math blocks, HTML blocks, images, block refs, attribute views and the block-icon menu.
- Read-only previews and static renderings inside dialogs.
- Blocks that exist only in the UI and not in the kernel — typically the message bubbles and the input box of the
  AI agent panel. The plugin verifies that the block exists in the database before touching it, so it never issues a
  failing request and never shows a `block not found` error.

## Settings

<kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Downloaded</kbd> → Click Counter (gear), or search
"Click Counter" in the command palette.

- enable switch, step per double-click
- matching rules: one regex per line, with 3 capture groups (name / number / unit); `/regex/flags` is accepted and
  lines starting with `#` are comments
- flash animation, toast with the new value, debug log (console only)

## How it works

1. A capture-phase `mousedown` listener acts only when `event.detail === 2` (the second press of a double-click).
   Once the rules match it calls `preventDefault()` to suppress word selection, then runs
   `SQL existence check → getBlockKramdown → updateBlock`.
2. Only the characters captured by group 2 are replaced, everything else is preserved — `1/7` becomes `2/7`.
3. If the unit carries a denominator (`/7`), the new value is capped by `min(denominator, current + step)`; at the
   boundary it only shows a toast and writes nothing.
4. Writes go through markdown, so inline formatting (bold, refs, …) is preserved; `id` / `updated` are not written
   back and other custom attributes are kept.
5. Only single-line blocks are processed; multi-line blocks (with children) are skipped to avoid losing content.
6. Only `paragraph / heading / blockquote / table cell` inside a `.protyle` editor, outside read-only areas.

## Changelog

- **v1.2.2** — `N/M` counters stop at the denominator.
- **v1.2.1** — default rules cover the `current/target` form (`1/7`).
- **v1.2.0** — trigger changed from single click to double-click.
- **v1.1.0** — removed all debugging scaffolding. The `block not found` reports of v1.0.x were traced to UI-only
  blocks rendered by the AI agent panel and fixed by checking block existence before counting.

## Development & release

**The repository root is the plugin itself** — SiYuan loads `index.js` directly
(CommonJS, `require("siyuan")`), so there is no build step. See `CHANGELOG.md` for the full history.

```bash
python3 scripts/pack.py          # validate and build package.zip
python3 scripts/pack.py --check  # validate only
```

To publish a new version:

1. bump `version` in `plugin.json` and add an entry to `CHANGELOG.md`;
2. commit, then push a tag matching that version:

   ```bash
   git tag v1.2.3 && git push origin v1.2.3
   ```

3. GitHub Actions verifies the tag matches the manifest version, builds `package.zip`
   and publishes the release.

The bazaar index picks up new releases within 1–3 hours — **no PR needed**.
If the bazaar stops updating, check for a `stage-fail` issue in your repo: it is almost
always a `version` that was not bumped, or a tag that does not match it (the workflow
blocks that case outright).

