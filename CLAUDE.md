# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WordKing is a personal PWA vocabulary notebook for a Korean student, built mainly for iPad Safari (added to the home screen). The student photographs a word list (or types words), AI pulls out the English word and Korean meaning pairs into the folder's word pool, and the app cuts the pool into "Day" pages and runs a review schedule. All UI text is Korean.

It has no build step, no dependencies, no package.json and no tests. The whole app is `index.html` (markup and all CSS), `app.js` (all logic), `sw.js` and `manifest.json`.

## Running

- Dev server: the `wordking` config in `../.claude/launch.json` (a one-line Node static server on port 5173, serving this folder). Start it with the preview tool, not Bash.
- Self-checks are `console.assert` lines inline in `app.js` (for example `chunk` and `planDays`). Check the browser console after loading the page. Put new pure helpers' asserts next to them in the same way.
- **Deploying:** bump `VERSION` in `sw.js` on every deploy, or the installed iPad app keeps old files. The service worker fetches network-first and falls back to cache, and it only handles same-origin requests (AI API calls pass through untouched).

## Architecture (app.js)

- **State:** one global `db` object, saved as a single JSON string in `localStorage['wordking']` through `save()`. Call `save()` after every change. The data shape is documented in `DEFAULT_DB`:
  - `v: 2`. Data without it (the old page-per-photo format) is wiped on load, keeping only the settings.
  - `folders[].words`: the word pool in the order added, `[{ id, en, ko, ex, syn, ant, mark, wrong }]`. Saving from the review screen only appends here.
  - `folders[].days[n-1]`: `{ ids, done: { test, r1, r2, big } }`, with dates. `ids` is written when Day n's 1차 시험 is done and fixes that Day's words.
  - `log`: `{ date, fid, n, kind }`, one per finished test, used by the calendar.

  Transient UI state lives in `ui` and is never saved.
- **Rendering:** `render()` dispatches on `ui.view` (`home`, `review`, `day`, `settings`, `test`, `calendar`). Each view function rewrites `#app.innerHTML` from a template string and then rebinds handlers. Escape all user or AI text with `esc()`. `[data-go]` buttons switch views through `bindGo()`.
- **Days (`planDays(f)`):** Days already tested keep their `ids`. The rest of the pool is re-cut by `settings.perDay` on every call, so a half-full Day keeps filling until its 1차 시험. Two review-only Days always follow the last word Day.
- **Day tasks (`dayTasks`):** Day n holds its own `test` (1차 시험), `r1` (Day n-1 복습1, all words), `r2` (Day n-2 복습2, ever-wrong only) and, on every 5th Day, `big` (오답 총복습: ever-wrong words from all tested Days). Tasks are not tied to dates.
- **Locks (`isOpen`):** Day n opens when Day n-1's 1차 시험 is done. For a review-only Day n-1, all of its tasks must be done. A task with no items is completed with one tap. Re-taking a done task, and retries from the result screen, are `practice` and record nothing.
- **누적 완료 단어:** `finishedWords(f)` counts a Day's words once Day n+2's `r2` is done.
- **Dates:** local `YYYY-MM-DD` strings that compare as strings (`today()`). They are used only for "done on" labels and the calendar.
- **Test items:** `{ fid, id }` points to a word. `{ fid, id, s: 'syn'|'ant', k }` points to that word's synonym or antonym, which is tested as a word too. Always resolve an item through `wordOf(it)`, and build item lists with `itemsFor(f, ids, onlyWrong)`.
- **Marks:** `mark` is `o` / `tri` / `x`. Anything other than `o` sets `wrong = true` for good. `wrong` feeds both `r2` and `big`.
- **Grading:** `grade()` marks blanks as `x` and exact matches (after whitespace and case normalization) as `o` locally. All remaining answers go to the AI in one batched call.
- **AI layer:** `ai(system, content, schema)` sends to `gemini()` or `claude()` depending on whether `settings.model` starts with `gemini`. Callers always pass Claude-style content (a string, or `[{type:'image',source}, {type:'text'}]`), and `gemini()` converts it. Every call asks for structured JSON through a JSON schema (`*_SCHEMA` constants next to their `*_SYSTEM` prompts). Errors are thrown as Korean, user-facing messages and shown with `alert()`. Calls run straight from the browser with keys the user enters in settings: Gemini (free tier, the default) or Claude (`anthropic-dangerous-direct-browser-access`).
- **Backups:** `exportBackup()` removes both API keys from the export. On restore, the current keys are kept.
- **Photos:** photos are shrunk to JPEG with a 1568 px long edge before upload (`toJpegBase64`). An example sentence printed next to a word becomes that word's `ex`.
- **Notebook layout:** `.grid2` is a compact two-column grid, so 30 or more words fit on one iPad screen. It collapses to one column below 560 px.

## Conventions

- Plain browser JS (`'use strict'`, no modules, no framework). Keep it that way unless asked.
- Use `$` for `document.querySelector`, `uid()` for ids, and `busy(msg)` / `busy()` for the loading overlay.
- Known limits are marked with `// shortcut: ...` comments (for example, all data lives in localStorage with its roughly 5 MB cap).
