# Claude Code Sessions (Raycast)

[![Raycast](https://img.shields.io/badge/Raycast-extension-FF6363?logo=raycast&logoColor=white)](https://raycast.com)
[![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/github/license/SomaTomita/raycast-claude-sessions)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/SomaTomita/raycast-claude-sessions)](https://github.com/SomaTomita/raycast-claude-sessions/commits/main)

One Raycast command that answers two questions: **what is every Claude Code session doing right now**, and
**what did I work on before**.

## Where the data comes from

Everything is read-only, straight off disk. No API, no credentials, no hooks, no changes to `settings.json`.

| Source | Used for |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | Live registry written by Claude Code itself: `status` (`busy` / `idle` / `shell`), pid, cwd, session name, CLI version. Entries whose process is dead are dropped. |
| `~/.claude/projects/<project>/<sessionId>.jsonl` | Transcript history: AI-generated title, first prompt, git branch, model, message count, last activity. |
| `~/.claude/history.jsonl` | Most recent prompt per session (tail-read). |
| `claude agents --all --json` | The CLI's own view: `waiting` status with its reason (e.g. "permission prompt"), plus **background agents**, which have no process and are invisible on disk. Costs ~1s, so it is cached for 45s and refreshed on ⌘R. |

`CLAUDE_CONFIG_DIR` is honoured when set. The `claude` binary is resolved from the usual install
paths and a login-shell lookup, because Raycast processes inherit a minimal PATH.

## Status

- **Working** — registry status is `busy` (or `shell`): the CLI is doing something.
- **Idle · awaiting input** — registry status is `idle`: the process is alive and sitting at the prompt.
- **Running · window gone** — the process is alive but no editor window shows its directory any more, so its
  terminal tab is gone and nothing can reach it. Resuming such a session offers to quit the stale process first,
  so one transcript never has two writers.
- **Background agents** — started with `claude --bg`, `state` is `blocked` or `done`. No pid, so they
  cannot be jumped to; the row carries a ready-made `claude attach <id>`.
- **History** — no live process owns the session; only the transcript remains.

One row per *process*, not per session: the same session opened in two terminals shows up twice, each with its
own pid and session name.

## Refresh

- Registry poll every 3s (a handful of tiny files, ~1ms).
- Full transcript rescan every 30s, memoised per file mtime — a warm rescan costs ~10ms instead of ~500ms.
- `⌘R` forces both.

## Jumping to a session

`Go to Session` (default action) resolves the host application by walking the Claude process's parent chain,
then does the most precise thing available:

| Host | Behaviour |
| --- | --- |
| iTerm2 | Selects the exact tab whose `tty` matches the Claude process. Verified against a running session. |
| Terminal.app | Same approach via Terminal's `tty` property on tabs. |
| Zed / VS Code / Cursor | Raises the window already showing that directory (matched by folder name through the accessibility API). It never opens, launches, or replaces anything. Terminal tabs inside an editor cannot be targeted: no scripting API. |
| Anything else (Warp, Ghostty, …) | Activates the exact hosting process. Any app bundle in the parent chain counts, so an unlisted terminal still works. |
| Nothing (history, or window gone) | Resumes in the terminal application: one iTerm2 window with a tab per session. |

Activation goes through `NSRunningApplication` (JXA), not `tell application "X" to activate`: it targets
the host **pid**, so it never launches an app that has exited, tells two instances of one bundle apart, and
switches Spaces including fullscreen.

Listing an editor's windows uses `System Events`, so macOS asks once for **Accessibility permission for
Raycast**. Without it no window is ever matched, and sessions hosted in an editor fall back to activating the app.

### Never disturb an open workspace

A path is never handed to a running editor. `zed <dir>` can swap the project of the focused window, which closes
that window's terminal tabs and takes the Claude sessions inside them with it. So the editor is only ever raised
(`Go to Session`), and a new window is opened only by the explicit `Move to <Editor>` action when no window
matches, and then with `--new` / `--new-window`.

Window titles carry no path, so two projects sharing a folder name (`~/work/api` and `~/oss/api`)
cannot be told apart; the first match wins.

### Why resuming never touches the editor

Starting a session inside an editor would mean synthetic keystrokes, and those go through the active keyboard
layout: on a layout where `option-shift-T` is a dead key, Zed's task shortcut arrives as a caron and the command
that follows lands in whatever has focus. Zed exposes no scripting API, so the target cannot be verified either.

Terminals are scriptable, so resuming uses them directly: iTerm2 gets `create tab with default profile` plus
`write text` per session, Terminal.app gets one `do script` window per session. No keystrokes, no layout
dependency, and several sessions can come back at once.

## Layout

Raycast fixes the list/detail split at roughly one third: `List` exposes `isShowingDetail` as a boolean and
nothing for width (`columns` is Grid-only). So the layout is tuned within that constraint:

- The detail pane shows the **last 10 turns** of the conversation, read from the transcript tail (~5ms even on a
  14 MB file), instead of leaving the area blank below a one-line prompt.
- With the pane open, the row subtitle shrinks to the project directory name; with it closed (`⌘D`) rows widen
  and show the full path plus message count, branch, status, and last activity.
- `⌘↩` pushes a **full-width transcript view** with 40 turns at full length, for actually reading a session.

## Actions

↩ is `Go to Session` on a reachable session and `Resume in <Terminal>` otherwise.

| Action | Shortcut | Notes |
| --- | --- | --- |
| Go to Session / Resume | ↩ | Moves to the live session, or resumes it in the terminal app. |
| Resume All N in `<project>` | ⌘⇧↩ | Shown on a *window gone* row when the same directory has several: brings them all back as tabs. |
| Move to `<Editor>` | ⌘E | Raises the project window; opens a new one only when none matches. |
| Open Transcript | ⌘↩ | Full-width conversation view. |
| Quit Stale Process | ⌃X | On a *window gone* row: SIGTERM, transcript untouched. |
| Copy Attach Command | | On a background agent row: `claude attach <id>`. |
| Copy Session ID / Resume Command | ⌘. / ⌘⇧C | Plus last prompt and directory path. |
| Open Project Folder, Show Transcript in Finder | | |
| Toggle detail pane, Refresh | ⌘D, ⌘R | |

## Preferences

| Preference | Default | Notes |
| --- | --- | --- |
| Terminal | `Terminal` | Where sessions are resumed. `iTerm2` groups them as tabs in one window; `Terminal` opens one window each. For any other terminal use *Copy Resume Command*. |
| Editor | `Zed` | `Zed`, `Visual Studio Code`, or `Cursor`, used by *Move to Editor* and for matching windows. |
| Claude CLI | `claude` | Command used for `--resume`. |
| History Limit | `80` | Transcripts scanned per full refresh, newest first (max 500). |

Transcripts larger than 6 MB are sampled at head + tail, so their message count is shown as a lower bound (`180+`).

## Prior art

`focus-terminal` in [claude-code-launcher](https://github.com/raycast/extensions/tree/main/extensions/claude-code-launcher)
(MIT) solves the same jump problem, and three ideas came from reading it: `claude agents --all --json` as a
status source, pid-based activation through `NSRunningApplication`, and deriving the host application from the
`.app` bundle path instead of a hardcoded list.

## Development

```sh
npm install
npm run dev    # registers the extension with Raycast
npm run build  # typecheck + bundle
```
