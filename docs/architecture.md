# Architecture

## Overview

The system automates Grok Imagine video generation using Playwright browser automation. It runs 1-100 parallel workers, each with its own isolated Chrome profile, coordinated through a file-locked manifest.

```
CLI (cli.js)
    └── ParallelRunner (parallel-runner.js)
            ├── Worker 0 (worker.js) → VideoGenerator (generator.js)
            ├── Worker 1 (worker.js) → VideoGenerator (generator.js)
            └── Worker N...
                    └── PostProcessor (post-processor.js)
```

## Core Components

### ParallelRunner (`src/core/parallel-runner.js`)
- Orchestrates worker lifecycle (init → run → cleanup)
- Creates job directories: `./logs/<job-name>/` for logs, `./cache/<job-name>/` for ephemeral data
- Coordinates rate-limit detection across workers
- Prints final summary and cleans up operational files

### ParallelWorker (`src/core/worker.js`)
- Maintains dedicated browser context with isolated Chrome profile copy
- Selects maximum available video duration on initialization (e.g., 10s over 6s)
- Claims work items atomically from manifest
- Runs generation loop: claim → generate → update manifest → repeat
- Signals `RATE_LIMIT_STOP` to coordinator when rate limit detected

### VideoGenerator (`src/core/generator.js`)
- UI automation state machine: find button → click → enter prompt → wait for completion
- Real-time failure detection: content moderation, network errors, generation errors
- Success verification: requires seeing generation progress (% indicator) before accepting video
- Returns `{ success, attempted, rateLimited, contentModerated }`

### ManifestManager (`src/core/manifest.js`)
- Thread-safe state persistence with file locking (`FileLock`)
- Atomic operations: `claimNextItem()`, `updateItemAtomic()`, `incrementCounterAtomic()`
- Tracks per-item status: PENDING → IN_PROGRESS → COMPLETED/FAILED/CONTENT_MODERATED/RATE_LIMITED

### PostProcessor (`src/core/post-processor.js`)
- Handles download, upscale (HD), and delete operations after successful generation
- Each operation has retry logic with configurable attempts

## Generation Flow

1. **Worker claims item**: `manifest.claimNextItem(workerId)` atomically assigns PENDING item
2. **Generate video**: Enter prompt → click button → wait for progress indicator (%) → wait for video
3. **Detect outcome**:
   - Success: video playable → mark COMPLETED
   - Content moderation: expected failure → mark CONTENT_MODERATED (WARN, not ERROR)
   - Rate limit: stop claiming new work → mark RATE_LIMITED
   - Technical failure: timeout/network → mark FAILED (ERROR)
4. **Post-process** (if enabled): download → upscale → delete
5. **Repeat** until no pending items or rate limited

## Error Handling

| Error Type | Behavior | Log Level |
|------------|----------|-----------|
| Rate limit | Stop new work, finish current video | WARN |
| Content moderation | Expected failure, continue | WARN |
| Timeout/Network | Mark failed, continue | ERROR |
| Auth required | Stop entire run | ERROR |

**Key rule:** Content moderation is common and expected — never log it as ERROR.

## Thread Safety

All manifest writes use `FileLock.withLock()`:
- Atomic file creation (`O_CREAT | O_EXCL` flag)
- 100ms polling, 30s timeout
- Auto-cleanup of stale locks (>60s)
- Reload-before-write pattern ensures consistency

## Configuration (`src/config.js`)

Key values:
- `VIDEO_GENERATION_TIMEOUT`: 60000ms (increase if videos take longer)
- `DEFAULT_PARALLELISM`: 10 workers
- `MODERATION_RETRY_MAX`: 100 retries for content moderation
- `HEADED_MODE`: true (set false for production)

UI selectors are centralized in `src/config.js` → update there when Grok UI changes.

## Directory Structure

```
./logs/<job-name>/
    └── run.log              # Detailed logs (persists)

./cache/<job-name>/          # Ephemeral (auto-cleaned after run)
    ├── manifest.json
    └── worker-profiles/

./downloads/<job-name>/      # Downloaded videos (if autoDownload enabled)
```
