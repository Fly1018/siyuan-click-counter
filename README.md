# Click Counter (siyuan-click-counter)

**Double-click the number in a block and it counts up** — built for small counters in daily notes and checklists such as `water: 1 time` or `1/7`. A single click still behaves as normal editing.

SiYuan v3.0.0+ · package `siyuan-click-counter` · [repository](https://github.com/Fly1018/siyuan-click-counter)

## What it does

- **Double-click to count**: only the matched number is replaced; inline formatting (bold, refs, …) and other custom attributes are preserved
- **Stops at the target**: for `1/7`-style counters only the number before the slash changes, and it stops at `7/7` with a toast instead of writing anything
- **Single click is untouched**: a single click still places the caret and edits as usual; `Alt` (or `Ctrl`/`Shift`) + double-click also skips counting, so you can select a word inside a countable block
- **Data-first, not DOM-faking**: the block is verified against the database before anything happens, then read and written back as markdown
- **Rapid clicks are queued**: consecutive double-clicks on the same block are summed up, none are lost
- **Three extra entry points**: block-icon menu, command palette, and the `custom-click-counter` block attribute (per-block step)

## When to use it

- Habit tracking in a daily note: `water: 1 time`, `coffee: 2 cups`, `push-ups: 30 reps`
- Progress against a goal: `1/7` (seven times a week), `study 3/10` (ten pages)
- Counting inside table cells (table cells are supported too)
- Giving one specific block its own step, e.g. +2 per double-click

## Install and enable

**Option 1 — from the marketplace (recommended)**

1. SiYuan → <kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Plugins</kbd>, search "Click Counter"
2. Click install
3. Go to <kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Downloaded</kbd> and turn "Click Counter" on

**Option 2 — manual install**

1. Download `package.zip` from the [latest release](https://github.com/Fly1018/siyuan-click-counter/releases/latest)
2. <kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Downloaded</kbd> → install from `package.zip`
3. Enable it in the same list

No configuration is needed: the default rules already cover the three common forms, so a double-click works right after enabling.

## Requirements

| Item | Requirement |
| --- | --- |
| SiYuan version | **v3.0.0 or later** (manifest `minAppVersion: 3.0.0`) |
| Backends / frontends | The manifest declares all of them (`backends: all`, `frontends: all`) |
| Dependencies | None. The plugin is a single `index.js` loaded directly by SiYuan — no Node/Python runtime |
| Network | No network access; it only calls the local kernel API |

> The plugin listens for mouse double-clicks (`mousedown` with `detail === 2`), so **the desktop app is the primary target**. On touch devices it depends on whether the client emits the matching mouse events; this is not specifically adapted.

## Quick start

1. Create a document and type a line:

   ```
   water: 1 time
   ```

2. **Double-click the line** → it becomes `water: 2 times`; the block flashes blue and a toast shows the new value

3. Type `1/7` and double-click → `2/7`. Keep double-clicking until `7/7` — further double-clicks only toast `7/7 (target reached)` and change nothing

4. Single-click the same line → the caret is placed and you can edit normally; nothing is counted

The three forms the default rules cover:

| Form | Examples | After a double-click |
| --- | --- | --- |
| name + number (+ unit) | `water: 1 time`, `coffee: 2 cups`, `push-ups: 30 reps` | `water: 2 times`, `coffee: 3 cups`, `push-ups: 31 reps` |
| name × number | `water ×3`, `water ✕3` | `water ×4` |
| current / target | `1/7`, `water: 1/7`, `study 3/10` | `2/7`, `water: 2/7`, `study 4/10` — only the number before the slash changes, capped at the denominator |

## Settings

<kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Downloaded</kbd> → Click Counter (gear icon), or search
"Click Counter: open settings" in the command palette.

| Setting | Meaning | Default |
| --- | --- | --- |
| **Enable double-click counting** | Master switch. When off, double-clicking does not count | **on** |
| **Step per double-click** | How much to add per double-click. A **negative** value makes a double-click decrease; decimals such as `0.5` work too. `0` or a non-number falls back to `1` | **1** |
| **Matching rules** | One regex per line, with **3 capture groups**: name / number / unit (unit may be empty) | the three rules below |
| **Flash animation** | Flash the block when counted (blue for increase, red for decrease) | **on** |
| **Show the new value** | Show a toast with the new value | **on** |
| **Debug log** | Print matching and update details to the console | **off** |

### Default matching rules

```
^(\S.{0,38}?)\s*[:：]\s*(\d+)\s*(次|杯|个|遍|组|下|页|口|瓶|颗|片|场|分钟|小时|公里|km)?$
^(.{1,40}?)\s*[×✕]\s*(\d+)\s*$
^(?:(\S.{0,38}?)\s*[:：]?\s*|[ \t]*)(\d{1,3})(\s*[\/／]\s*\d+.*)$
```

They cover `name: number[ unit]`, `name ×number` and `current/target` respectively.

Rule syntax notes:

- one rule per line; blank lines are ignored; a line starting with `#` is a comment
- both `/regex/flags` and a bare regex are accepted
- **a bare regex gets the `i` flag** (case-insensitive); `g` and `y` are stripped from the `/regex/flags` form
- a line with a regex syntax error is **silently ignored** and does not affect the other rules
- capture group 2 must be **digits only** (`\d+`), otherwise the rule does not match
- changes take effect immediately, no plugin reload needed

## Advanced usage

### Block attribute `custom-click-counter`

Put it on a block to control that block alone:

| Value | Meaning |
| --- | --- |
| `off` / `no` / `false` / `0` | This block is not counted (case-insensitive) |
| An integer, e.g. `+1` / `-1` / `2` | Per-block step: integers only, must not be `0`, a negative value means a double-click decreases. **Takes priority over the global step** |
| Anything else, e.g. `on` | Force enable: even if no rule matches, fall back to "change the last number in the line", e.g. `push-ups 30` |

### Block icon menu

Click the block icon (left of the block) → the menu has **"Count +1" / "Count -1"**. With several blocks selected it applies to each of them. This path is independent of double-clicking.

### Command palette

**None of these have a default hotkey** — bind your own in <kbd>Settings</kbd> → <kbd>Keymap</kbd>:

| Command | Effect |
| --- | --- |
| Click Counter: open settings | Open the plugin settings |
| Click Counter: +1 on the block at cursor | Add one step (the block's own attribute step, or the global step) without moving the caret |
| Click Counter: -1 on the block at cursor | Same, subtract one step |
| Click Counter: diagnose why the block is not countable | Print the full decision trail for that block (below) |
| Click Counter: check for blocks that exist only in the UI (diagnostic) | Scan the UI for blocks missing from the kernel |

The **diagnose** command opens a dialog listing: context, block ID, block type, block text, whether it exists in the kernel, the `custom-click-counter` value, the first line, the enabled state, the current step, the number of rules, and the **match result** (showing the parsed name / number / unit and the cap when it matches). Run it first whenever counting behaves unexpectedly.

### Custom rule examples

```
# one per line, comments look like this
^完成\s*(\d+)\s*(次)$
^reading\s+(\d+)\s*(pages)$
```

## Known limits

- **Only single-line blocks** are processed. Multi-line blocks (with children) are skipped so a write-back cannot lose content
- Only these block types count: **paragraph, heading, blockquote, table cell** (container blocks are handled through their inner paragraphs)
- Only blocks inside a `.protyle` editor; read-only previews and static renderings inside dialogs are ignored
- Code blocks, math blocks, HTML blocks, images, block refs, attribute views and the block-icon menu are not counted
- A value is only guaranteed **not to go below 0**; only counters with a denominator (such as `/7`) are capped
- A block ID must look like `14-digit timestamp-7 random chars`; anything else is skipped (real document blocks always match)

## Troubleshooting

**Double-clicking does nothing**

1. Check that the plugin is enabled: <kbd>Settings</kbd> → <kbd>Marketplace</kbd> → <kbd>Downloaded</kbd> → Click Counter
2. Run **"Click Counter: diagnose why the block is not countable"** and read the last line, **Match result**:
   - "未命中（不计数）" / no match → the rules do not cover this form; add a rule in the settings
   - "内核中存在：否" / does not exist in the kernel → it is a UI-only block, see below
3. Check whether the block carries `custom-click-counter` with a value of `off` / `no` / `false` / `0`
4. Confirm the block type is paragraph / heading / blockquote / table cell and that it is not a multi-line block

**Nothing happens once the target is reached**

That is by design: an `N/M` counter stops at the denominator `M` and only toasts "(target reached)" without writing. Raise the denominator to keep going.

**"This block exists only in the UI and not in the kernel"**

Such blocks are rendered on the frontend only (most often the message bubbles and input box of the AI agent panel) and are never stored in the database. The plugin checks existence in the database first, so it **silently skips** them: no request is issued that could fail, and no `block not found` error is shown. Use the "check for blocks that exist only in the UI" command to see them all.

**Double-clicking selects a word instead**

When a count triggers, the plugin suppresses word selection. To select a word, hold `Alt` (or `Ctrl`/`Shift`) while double-clicking.

**Does inline formatting get lost?**

No. Only the matched number is replaced; bold, refs and other custom attributes are preserved. `id` and `updated` are maintained by the kernel and are not written back. Use SiYuan's own undo (`Ctrl+Z`) to revert a mistake.

**Do rapid clicks get lost?**

No. Consecutive double-clicks on the same block are queued and applied in order after the previous write completes.

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
