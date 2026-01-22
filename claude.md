# Grok Batch Video Generator - AI Agent Context

## Project Overview

Automates video generation from Grok Imagine image permalinks using Playwright browser automation. Supports parallel execution (1-100 workers), each with isolated Chrome profiles. Node.js CLI tool with file-locked state management.

## Commands

```bash
# Account management
npm start -- accounts add <alias>
npm start -- accounts list

# Start run with config (recommended)
npm start -- run start --config batch-config.json

# Start run with flags
npm start -- run start --account <alias> --permalink <url> --prompt "<text>" --count <n> --parallel <n>

# Testing
npm test  # Import validation
```

**Note**: `--` separator required for npm scripts when passing flags.

## Architecture

Entry: `src/cli.js` → parse commands, validate
Orchestration: `src/core/parallel-runner.js` → spawn workers, aggregate results
Worker: `src/core/worker.js` → isolated Chrome context per worker
Generator: `src/core/generator.js` → UI automation state machine
State: `src/core/manifest.js` → file-locked atomic updates
Config: `src/config.js` → defaults and UI selectors

**For detailed architecture**: @docs/ARCHITECTURE.md

## Critical Rules

**IMPORTANT: Before making ANY changes**:
1. Fully understand the problem by reading relevant code
2. Review @docs/ARCHITECTURE.md for system design
3. Create a thoughtful plan explaining your approach
4. Present plan to user for review BEFORE implementing
5. Avoid surface-level fixes that add complexity
6. Do not stop at the first likely cause for an issue -- continue investigating to come up with 3 or more theories, then think critically about which is the most likely. 

**Code Behavior**:
- Never log prompt text (privacy) - logs show "prompt provided" instead
- Workers initialize in parallel with no startup delay
- Each worker uses isolated Chrome profile copy (prevents conflicts)
- Manifest updates are atomic via file locking
- Rate limits stop new work gracefully (no resume, rerun with same config)
- Parallel default: 10 workers (configurable 1-100)

**Development Workflow**:
- Read existing code before proposing changes
- Understand data flow and state management
- Simple solutions over complex abstractions
- Test with `npm test` before committing

## Common Patterns

**Run Directory Structure**:
```
./logs/<job-name>/
  ├── manifest.json       # Shared state (file-locked)
  ├── manifest.lock       # Lock file (auto-managed)
  ├── run.log            # Combined logs
  └── worker-profiles/   # Temp profiles (auto-cleaned)
```

**Manifest States**:
- Run: PENDING → IN_PROGRESS → COMPLETED | STOPPED_RATE_LIMIT | FAILED
- Item: PENDING → IN_PROGRESS → COMPLETED | FAILED | RATE_LIMITED

**Error Handling**:
- RATE_LIMIT: Stop new work, finish in-flight, exit gracefully
- AUTH_REQUIRED: Stop all workers immediately
- CONTENT_MODERATED, NETWORK_ERROR, TIMEOUT: Mark failed, continue

## Examples Reference

For config file examples and advanced usage: @EXAMPLES.md

## Testing

```bash
npm test                                            # Import validation
node src/cli.js run start --config test-config.json # Manual test
```

## Notes

- No resume command: Rerun with same config creates fresh batch
- Videos not auto-downloaded (manual from Grok UI)
- UI selectors in `src/config.js` (update if Grok UI changes)
- High parallelism increases rate limit risk
