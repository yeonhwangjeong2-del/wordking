# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WordKing is a personal PWA vocabulary notebook for a Korean student, built mainly for iPad Safari (added to the home screen). The student photographs a word list, AI pulls out the English word and Korean meaning pairs, and the app splits them into "Day" pages and runs a review schedule. All UI text is Korean.

It has no build step, no dependencies, no package.json and no tests. The whole app is `index.html` (markup and all CSS), `app.js` (all logic), `sw.js` and `manifest.json`.

## Running

- Dev server: the `wordking` config in `../.claude/launch.json` (a one-line Node static server on port 5173, serving this folder). Start it with the preview tool, not Bash.
- Self-checks are `console.assert` lines inline in `app.js` (for example `chunk` and `addDays`). Check the browser console after loading the page. Put new pure helpers' asserts next to them in the same way.
- **Deploying:** bump `VERSION` in `sw.js` on every deploy, or the installed iPad app keeps old files. The service worker fetches network-first and falls back to cache, and it only handles same-origin requests (AI API calls pass through untouched).

## Architecture (app.js)

- **State:** one global `db` object, saved as a single JSON string in `localStorage['wordking']` through `save()`. Call `save()` after every change. The data shape is documented in `DEFAULT_DB`:
  - pages: `{ id, folderId, day, rounds: {r1,r2,r3}, words: [{ en, ko, mark, wrong, syn, ant, ex }] }`
  - `log`: one entry per finished test, used by the calendar
  - `folders[].lastBig`: date of the last 오답 총복습

  Transient UI state lives in `ui` and is never saved.
- **Rendering:** `render()` dispatches on `ui.view` (`home`, `review`, `page`, `settings`, `test`, `calendar`). Each view function rewrites `#app.innerHTML` from a template string and then rebinds handlers. Escape all user or AI text with `esc()`. `[data-go]` buttons switch views through `bindGo()`.
- **Dates:** local `YYYY-MM-DD` strings that compare as strings (`today()`, `addDays()`). Don't use `Date` objects or UTC ISO strings for schedule logic.
- **Review schedule:**
  - `nextRound(p)`: r1 (1차 시험, all words) on the study day → r2 (복습1, all words) the next day → r3 (복습2, only words ever marked wrong) the day after.
  - `bigDue(fid)`: a folder-wide 오답 총복습 every 5 days, counted from the first r1 or from the last 총복습.
  - A test taken before it is due counts as `practice` and records nothing.
- **Test items:** `{ pid, wi }` points to a word. `{ pid, wi, s: 'syn'|'ant', k }` points to that word's synonym or antonym, which is tested as a word too. Always resolve an item through `wordOf(it)`.
- **Marks:** `mark` is `o` / `tri` / `x`. Anything other than `o` sets `wrong = true` for good. `wrong` feeds both r3 and the 총복습.
- **Grading:** `grade()` marks blanks as `x` and exact matches (after whitespace and case normalization) as `o` locally. All remaining answers go to the AI in one batched call.
- **AI layer:** `ai(system, content, schema)` sends to `gemini()` or `claude()` depending on whether `settings.model` starts with `gemini`. Callers always pass Claude-style content (a string, or `[{type:'image',source}, {type:'text'}]`), and `gemini()` converts it. Every call asks for structured JSON through a JSON schema (`*_SCHEMA` constants next to their `*_SYSTEM` prompts). Errors are thrown as Korean, user-facing messages and shown with `alert()`. Calls run straight from the browser with keys the user enters in settings: Gemini (free tier, the default) or Claude (`anthropic-dangerous-direct-browser-access`).
- **Backups:** `exportBackup()` removes both API keys from the export. On restore, the current keys are kept.
- **Photos:** photos are shrunk to JPEG with a 1568 px long edge before upload (`toJpegBase64`).

## Conventions

- Plain browser JS (`'use strict'`, no modules, no framework). Keep it that way unless asked.
- Use `$` for `document.querySelector`, `uid()` for ids, and `busy(msg)` / `busy()` for the loading overlay.
- Known limits are marked with `// shortcut: ...` comments (for example, all data lives in localStorage with its roughly 5 MB cap).
