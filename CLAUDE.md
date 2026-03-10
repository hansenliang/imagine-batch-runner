# Grok Batch Video Generator

Automates Grok Imagine video generation via Playwright. Runs 1-100 parallel workers, each with isolated Chrome profile.

## Commands
- `npm start accounts add <alias>` — Add account (opens browser for login)
- `npm start accounts list` — List accounts
- `node src/cli.js run start --config batch-config.json` — Start batch run
- `node src/cli.js run max-extend --config max-extend-config.json` — Extend existing video to 30s
- `npm test` — Validate imports

## Auto-Extend
When `autoExtend: true` is set (in config or via `--auto-extend` flag), each generated video is automatically extended to the maximum 30s duration. Videos that don't reach 30s (e.g., due to rate limits) are downloaded/upscaled but not deleted — they can be extended further in a future run.

## Max-Extend Mode
Extends an existing short video (< 30s) to the maximum 30s duration. Multiple workers branch independently from the same source video, producing parallel extension chains for curation. Uses the same extend loop as auto-extend.

Example:
```bash
node src/cli.js run max-extend \
  --account my-account \
  --permalink "https://grok.com/imagine/post/abc123" \
  --prompt "pixel art style, looping aesthetic" \
  --count 5 \
  --parallel 3 \
  --auto-download \
  --auto-upscale \
  --auto-delete
```

- `--count` = number of independent extension chains (each aims for 30s)
- `--parallel` = number of workers running chains simultaneously
- `--auto-delete` deletes only extensions that reached 30s, never the original video
- Each chain: source video → extend → extend → ... → 30s → download/upscale/delete
- Content moderation retries automatically (up to 100 times per chain)
- Rate limit stops the affected worker (after downloading any partial extensions); other workers continue

## Extend From Frame
When `extendFromTime` is set (in config or via `--extend-from-time <seconds>`), the first extension in a chain seeks to the specified timestamp and uses "extend from frame" instead of the normal "Extend video" menu. This trims everything after the specified frame and extends from there. Subsequent extensions in the same chain use the normal extend path (extending from the end).

Example (max-extend from frame 22):
```bash
node src/cli.js run max-extend \
  --account my-account \
  --permalink "https://grok.com/imagine/post/abc123" \
  --prompt "pixel art style, looping aesthetic" \
  --extend-from-time 22 \
  --count 3 \
  --parallel 3
```

Config file equivalent: `"extendFromTime": 22`

- Works with both `run start --auto-extend` and `run max-extend`
- If extend-from-frame fails (button not found), falls back to normal "Extend video"
- The "extend from frame" button only appears when hovering over the video progress bar — the automation seeks the video, hovers the progress bar to reveal the button, then clicks it

## Key Files
- `src/cli.js` — CLI entry point
- `src/core/parallel-runner.js` — Worker orchestration
- `src/core/worker.js` — Browser context, generation loop
- `src/core/generator.js` — UI automation state machine
- `src/core/manifest.js` — Atomic state with file locking
- `src/config.js` — Timeouts, selectors, defaults

## Run Outputs
- Single run logs: `./logs/runs/<job-name>.log`
- Autorun logs: `./logs/autorun/<session-id>/`
  - `summary.log` — cycle-level tallies
  - `detailed/<job-name>.log` — per-job detailed trace
  - `run.log` — session-level events
- Downloads: `./downloads/<job-name>/` (if autoDownload enabled)
- Cache cleaned up after each run; only logs persist
- If `selectMaxDuration`/`selectMaxResolution` enabled in config, logs show selected settings (e.g., `10s, 720p`)

## Key Rules
- **Content moderation is expected** — log as WARN, never ERROR
- **Never print prompt text** to CLI or logs (privacy)
- **UI selectors** are in `src/config.js` — update there, not inline

## Grok UI Notes (updated March 2026)
- **Dual video elements**: Grok now renders `<video id="sd-video">` (visible, has `src`) and `<video id="hd-video">` (hidden, no `src` until HD ready). Always use `currentSrc` or `v.currentSrc || v.src` — never `getAttribute('src')`.
- **Progress indicator**: Progress is shown as a floating overlay pill with `<span class="tabular-nums">15%</span>`. Detected via `span.tabular-nums` selector + `getBoundingClientRect` visibility check. The old `offsetParent` approach fails on overlay-positioned elements.
- **Extend video**: The Settings button (`aria-label="Settings"`) shows "Extend video" as a menu item when a video is already generated. No need to use the "More options" (`...`) menu.
- **Permalink redirect**: Navigating to a post permalink auto-redirects to the latest video for that post. Both `_navigateToSourceVideo()` and `_navigateToCheckpoint()` handle this by matching the target UUID against thumbnail `img src` attributes and clicking the correct thumbnail (SPA navigation, no reload).
- **Rate limits are separate**: Generation and extension have independent rate limits. Extension rate limit breaks the extend loop, navigates to the checkpoint URL for post-processing (download partial video), then throws `RATE_LIMIT_STOP`.
- **Extend loop**: Extends until video reaches 30s (duration-based). Content moderation and errors retry up to 100 times. Auto-delete only runs if video reached 30s; partial extensions are preserved for future continuation. If the video is already at 30s (max duration), the extend loop detects this when "Extend video" is unavailable and treats it as a success (ready for post-processing).
- **Checkpoint recovery**: After the extend loop exits (rate limit, exhausted retries, etc.), the page may not be on the video. `_navigateToCheckpoint()` navigates to the checkpoint URL, detects Grok's redirect, and recovers the correct video via thumbnail navigation if needed.
- **Page recovery**: After a generation failure in normal mode (e.g., "Prompt input not found"), the page is reloaded to give the next attempt a clean slate. Content moderation doesn't trigger recovery (the page is fine). Max-extend mode navigates fresh each chain, so it self-recovers.
- **Delete safety**: In max-extend mode, post-processing only runs if at least one extension succeeded (or the video is already at max duration), so the original video is never deleted. In both modes, auto-delete is suppressed for videos under 30s. The worker must sync `autoDelete` to *both* `this.autoDelete` and `this.postProcessor.autoDelete` since the PostProcessor has its own copy of the flag.
- **Download filenames**: Format is `YYMMDD-HHmmss_UUID8_DURs.mp4` (e.g., `260309-152031_8e181808_30s.mp4`). HD upscales append `_hd` before the extension (e.g., `260309-152031_8e181808_30s_hd.mp4`). Duplicates are prefixed with `DUPLICATE_`. UUID is extracted from the page URL (`/imagine/post/UUID`), falling back to video src pattern.
- **Log labels**: `generator.generate()` accepts `options.logLabel` (default `"Attempt"`) to distinguish generation vs extension in logs. The extend loop passes `{ logLabel: 'Extend' }` so log lines read `[Extend N]` instead of `[Attempt N]`.
- **Extend from frame**: The "extend from frame" button only appears when the mouse hovers over the video playback progress bar (a `div` with `cursor-pointer`, `rounded-full`, `opacity-0` classes). `triggerExtendFromFrame()` in `generator.js` seeks the video to the target time, pauses, hovers the progress bar to reveal the button, and clicks it. Falls back to JS force-reveal if CSS hover doesn't work. Only used for the first extension in a chain; subsequent extensions use normal `triggerExtendMode()`.

## When to Read More
- Setup or install issues → `docs/quickstart.md`
- Modifying core logic or architecture → `docs/architecture.md`
- Usage patterns or examples → `docs/examples.md`

---

# Working Guidelines

## Before Making Changes
1. **Read first**: Always read CLAUDE.md and any relevant architecture/documentation files before making plans or changes
2. **Explore thoroughly**: When investigating issues, find at least 3 likely causes before concluding. Don't stop at the first plausible explanation—keep investigating until you have high confidence
3. **Understand context**: Search for existing patterns in the codebase before implementing new code. Follow established conventions
4. **Clarify ambiguity**: If requirements are unclear or there are multiple valid approaches, list pros/cons and ask for clarification
5. **Plan and align with the user**: Unless it's a trivial change, you should always outline your analysis of the request, any competing theories / options and which one you think is the best / most likely, and review the approach with the user for approval before making any code changes.
6. **Plan twice**: After the intial plan is done, always take a 2nd pass: can things be simpler? Are there actually simpler ways to achieve the same goals with fewer lines of code and less complexity? 

## While Making Changes
1. **Small increments**: Break complex tasks into small, testable steps. Implement and verify each step before moving on
2. **Validate constantly**: Run tests, type checks, or the actual command after making changes—don't assume code works
3. **One responsibility**: Each function/module should do one thing well. Avoid monolithic functions that handle multiple concerns
4. **Use existing code**: Reuse existing utilities and patterns rather than creating new abstractions unnecessarily
5. **Persist fixes properly**: When fixing issues, update all necessary files (scripts, configs, docs)—not just the immediate file. Fixes must work across fresh environments, not just the current session

## After Making Changes
1. **Clean up**: Look for and remove outdated code, unused imports, dead code paths, and stale comments
2. **Update documentation**: If code changes affect behavior, update relevant docs (this file, README, inline comments)
3. **Verify end-to-end**: Run the actual use case, not just unit tests. Confirm the change works as expected from the user's perspective

## Troubleshooting
1. **Don't trust first impressions**: The obvious cause is often wrong. Investigate systematically
2. **Check all related files**: Errors in one place often have root causes elsewhere (configs, dependencies, imports)
3. **Read error messages carefully**: Full stack traces contain valuable information. Don't skip over them
4. **Test your hypothesis**: Before declaring a fix, verify it actually resolves the issue

## What NOT to Do
- Don't make changes without understanding existing code first
- Don't assume AI-suggested code is correct—verify it
- Don't leave TODO comments without implementing them
- Don't introduce new patterns that conflict with existing codebase conventions
- Don't skip validation steps to save time
- Don't make sweeping refactors when a targeted fix will do
- Don't delete or modify code you don't understand
