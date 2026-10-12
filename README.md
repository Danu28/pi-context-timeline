# Pi Context Timeline

Interactive **context timeline** extension for the [Pi coding agent](https://pi.dev) — helps you *see* how Pi builds the model context.

## What it shows

Every model call sends **context** = *system prompt + conversation + tool results*.
This extension logs each piece as a live timeline so you understand what the model actually sees.

| Kind | Meaning |
|------|---------|
| ⬢ system | `before_agent_start` — systemPromptOptions (sections, tools, guidelines, skills) |
| ▶ user | user messages appended to history |
| ◆ assistant | assistant generations (with token usage) |
| ◈ tool-call / ↳ result | tool invocations and their outputs (become context) |
| ⇄ context | extension transforms that edit context before the model sees it |
| ✂ compaction | when the window fills, old turns are summarized |
| ⬣ model | model switches |
| ─ turn / settled | turn boundaries |

Token estimates (~4 chars/token) and a **~128k est. progress bar** in header/status show window pressure (real limits vary 128k–200k by model).

## Install

```bash
# from git (recommended)
pi install git:github.com/Danu28/pi-context-timeline
# pinned
pi install git:github.com/Danu28/pi-context-timeline@v1.0.1

# update
pi update --extensions

# remove
pi remove git:github.com/Danu28/pi-context-timeline
```

Or try without installing:

```bash
pi --extension ./extensions/context-timeline.ts
pi -e git:github.com/Danu28/pi-context-timeline
```

No dependencies — pure TypeScript via `jiti`.

## Commands

| Command | Alias | What |
|---------|-------|------|
| `/context-timeline` | `/ctx`, `/ctx-timeline` | open interactive timeline overlay |
| `/ctx-clear` | | clear timeline |
| `/ctx-export [file]` | | export JSON (`./context-timeline-<ts>.json` — basename sanitized) |
| `/context-timeline-help` | | explain how Pi context works |

## Timeline UI keys

- `↑/↓` or `j/k` — navigate
- `Enter` / `Space` — expand detail
- `g` / `G` — top / bottom
- `PgUp` / `PgDn` — page
- `f` — cycle filter (system→user→assistant→tool→context→compaction→model→session→turn→info→all)
- `c` — clear
- `e` — export (async, consistent schema)
- `?` — toggle help (how context works)
- `q` / `Esc` — close (Esc clears filter first when filtered)

## Status bar

Compact indicator via `ctx.ui.setStatus("context-timeline", …)`:

`◷ 42 | 💬12 | 🔧8 | ███░░░░░░░ ~32% (18.2k/6.1k) ✂1`

events | messages | tools | ~token bar | in/out | compactions

## How Pi context works (summary)

1. **System prompt** built each turn from `systemPromptOptions` (instructions + tool defs + skills + project files).
2. **Conversation** — ordered user/assistant/tool-result messages.
3. **Tool results** are appended; next turn includes them.
4. **Context event** — extensions may rewrite the message list.
5. **Compaction** — when `shouldCompact` triggers, `session_before_compact` summarizes old messages, `session_compact` keeps summary + recent window.
6. Use `/ctx` to watch this live.

## Files

- `extensions/context-timeline.ts` — canonical extension entry (Pi package discovery)
- `index.ts` — shim re-export for `pi --extension ./` backwards compat
- `package.json` — Pi package manifest (`pi.extensions`)
- `LICENSE` — MIT

## Dev

```bash
npx tsc --noEmit --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions extensions/context-timeline.ts
```

Test load:
```bash
pi --extension ./extensions/context-timeline.ts -c "/ctx"
```

## License

MIT
