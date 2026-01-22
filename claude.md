# Grok Batch Video Generator

## Project Overview
Grok Batch Video Generator automates Grok Imagine video generation via Playwright.
Primary workflow is `run start` with optional JSON config, running 1-100 workers.
Each worker uses its own Chrome profile copy and writes logs to a run directory.

## Primary Commands
- Add account: `npm start accounts add <alias>`
- List accounts: `npm start accounts list`
- Start run (config): `node src/cli.js run start --config batch-config.json`
- Start run (flags): `npm start run start --account <alias> --permalink <url> --prompt "<text>" --count <n> --parallel <n>`

## Key Files
- `src/cli.js`: CLI parsing and run start command
- `src/core/parallel-runner.js`: Orchestration, worker lifecycle, final summary
- `src/core/worker.js`: Worker initialization and generation loop
- `src/core/generator.js`: UI automation for generation steps
- `src/core/manifest.js`: Run state + atomic updates
- `src/utils/logger.js`: Log formatting + run.log writes
- `src/config.js`: Defaults and selectors

## Testing & Validation
- Import check: `npm test`
- Manual run: `node src/cli.js run start --config batch-config-es.json`
- Always verify changes work by running the relevant command

## Run Outputs
- CLI runs: `./logs/<job-name>/`
- Autorun sessions: `./logs/autorun/`
- Autorun summary logs: `./logs/autorun-<timestamp>.log`
- Manifests track attempts and rate-limit stops; there is no resume command
- Operational files (manifest.json, worker-profiles) are cleaned up after each run; only run.log persists

## Expected Behavior
- `--config` should work without extra required flags
- Workers initialize in parallel (no startup stagger)
- CLI and run logs must not print the prompt text
- Rate limits stop new work; rerun later with the same config if needed

## Generation Outcome Classification
Each generation attempt returns `{ success, attempted, rateLimited }`. The outcome determines logging:

- **Success** (`attempted: true`, `success: true`): Video generated. Log: SUCCESS
- **Content Moderation** (`attempted: true`, `success: false`): Expected failure, not an error. Log: WARN only
- **Other Failures** (`attempted: true`, `success: false`): Technical failures (timeout, network). Log: ERROR
- **Rate Limited** (`attempted: false`, `rateLimited: true`): Never started. Log: WARN only

Content moderation is common and expected — do NOT log it as ERROR.

---

# Working Guidelines

## Before Making Changes
1. **Read first**: Always read CLAUDE.md and any relevant architecture/documentation files before making plans or changes
2. **Explore thoroughly**: When investigating issues, find at least 3 likely causes before concluding. Don't stop at the first plausible explanation—keep investigating until you have high confidence
3. **Understand context**: Search for existing patterns in the codebase before implementing new code. Follow established conventions
4. **Clarify ambiguity**: If requirements are unclear or there are multiple valid approaches, list pros/cons and ask for clarification
5. **Plan and align with the user**: Unless it's a trivial change, you should always outline your analysis of the request, any competing theories / options and which one you think is the best / most likely, and review the approach with the user for approval before making any code changes.

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
