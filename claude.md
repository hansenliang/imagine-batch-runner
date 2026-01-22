## Project Overview

Grok Batch Video Generator automates Grok Imagine video generation via Playwright.
Primary workflow is `run start` with optional JSON config, running 1-100 workers.
Each worker uses its own Chrome profile copy and writes logs to a run directory.

## Primary Commands

- Add account: `npm start accounts add <alias>`
- List accounts: `npm start accounts list`
- Start run (config): `node src/cli.js run start --config batch-config.json`
- Start run (flags): `npm start run start --account <alias> --permalink <url> --prompt "<text>" --count <n> --parallel <n>`

## Expected Behavior

- `--config` should work without extra required flags.
- Workers initialize in parallel (no startup stagger).
- CLI and run logs must not print the prompt text.
- Rate limits stop new work; rerun later with the same config if needed.

## Key Files

- `src/cli.js`: CLI parsing and run start command.
- `src/core/parallel-runner.js`: Orchestration, worker lifecycle, final summary.
- `src/core/worker.js`: Worker initialization and generation loop.
- `src/core/generator.js`: UI automation for generation steps.
- `src/core/manifest.js`: Run state + atomic updates.
- `src/utils/logger.js`: Log formatting + run.log writes.
- `src/config.js`: Defaults and selectors.

## Testing

- Import check: `npm test`
- Manual run: `node src/cli.js run start --config batch-config-es.json`

## Notes

- Run outputs: `./logs/<job-name>/` (CLI runs) and `./logs/autorun/` (autorun sessions)
- Autorun summary logs: `./logs/autorun-<timestamp>.log`
- Manifests track attempts and rate-limit stops; there is no resume command.
- Operational files (manifest.json, worker-profiles) are cleaned up after each run; only run.log persists.
