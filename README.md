# Code Coach

A Chrome side-panel extension that audits code for bugs, errors and style
problems, and teaches instead of just correcting: every finding has a **hint**
(a nudge) and a separate **Show the answer** (explanation plus a before/after
diff).

## Install (developer mode)

1. Unzip this folder.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and pick the `code-coach` folder.
4. Pin the extension, then click its icon to open the side panel.

Requires Chrome 116 or newer.

## The three tabs

**This page** reads the code from the tab you're looking at.
Supported: Monaco (github.dev, vscode.dev, Codespaces), CodeMirror 5 and 6,
Ace, plain text boxes, and files viewed on github.com.
- *Watch while I code* re-checks on a timer (default 30 s, configurable) and
  only re-audits when the code changed.
- *Scan now* works with the toggle off, for the "I finished, now check it" case.

**Paste code** is for desktop IDEs such as Eclipse. A browser extension can't
see inside a desktop app, so copy your code here. With the watch toggle on, it
re-checks 1 second after you stop typing. Click a line number to jump to it, or
"Apply this fix" in an answer to patch your pasted code.

**GitHub** audits the most recent commits of a repo (public, or private with a
token). Only added/changed lines are reported. You can also ask to be notified
when a watched repo gets a new commit (checked every 5 minutes).

## What it checks

Style: line length (default 80), indentation (tabs vs spaces, mixed, wrong
depth, size), brace placement, `else` placement, spacing around keywords,
operators and commas, trailing whitespace, blank lines, naming conventions,
missing braces, TODO markers, debug leftovers, EOF newline.

Bugs and errors: unbalanced brackets, `=` inside conditions, stray `;` after
`if`/`for`/`while`, missing semicolons, Java `==` on Strings, `== NaN`, loose
`==` in JS, off-by-one loops, division by zero, unreachable code, empty catch,
unused variables and imports, Python indentation errors, missing colons,
mutable default arguments, bare `except`, unsafe C functions, and more.

Languages: Java, JavaScript/TypeScript, Python, C/C++/C#. Other languages get
the generic checks.

## Settings (gear icon)

Max line length, indent style and size, brace style (or auto-detect from the
file), watch interval, and an optional GitHub token. The token is stored
locally and only sent to api.github.com.

## Honest limits

- It is a rule-based linter, not a compiler. It will miss some bugs and will
  occasionally flag something that is fine. Treat it as a coach, not a judge.
- Some editors (notably VS Code for the Web) only expose the lines currently on
  screen. Code Coach tells you when that happens.
- The unauthenticated GitHub API allows 60 requests per hour; add a token in
  Settings for 5,000.
- The side panel must be open for live watching to run.

## Files

- `manifest.json`: MV3 manifest
- `analyzer.js`: the rule engine (no dependencies, testable in Node)
- `sidepanel.html/.css/.js`: the UI
- `background.js`: side-panel behavior and the new-commit watcher
