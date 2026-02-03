# Grok Batch Video Generator

Automates Grok Imagine video generation via Playwright. Runs 1-100 parallel workers, each with isolated Chrome profile.

## Commands
- `npm start accounts add <alias>` — Add account (opens browser for login)
- `npm start accounts list` — List accounts
- `node src/cli.js run start --config batch-config.json` — Start batch run
- `npm test` — Validate imports

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
- Summaries include duration setting: `max (10s)` or `default` if detection failed

## Key Rules
- **Content moderation is expected** — log as WARN, never ERROR
- **Never print prompt text** to CLI or logs (privacy)
- **UI selectors** are in `src/config.js` — update there, not inline

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
