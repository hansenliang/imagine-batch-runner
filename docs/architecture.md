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
- Consults a persistent per-job UUID registry (`./logs/uuid-registry/<job>.txt`) before downloading — already-known UUIDs are skipped entirely (no bytes, no file). Registry survives across runs and concurrent workers append atomically

### Extend loop & max-extend mode
- `worker.js` extends a generated (or existing) video until it reaches the 30s max duration. A real extension requires the post-extend duration to grow vs the pre-extend duration — otherwise it's a "ghost extend" and the worker throws `GHOST_EXTEND_STOP`, which the runner fans out as a stop signal across siblings
- `run max-extend` reuses the same loop, starting from an existing permalink. If the permalink is a static image post, the worker generates a new video first, then extends it
- `extendFromTime` triggers an "extend from frame" on the first extension only (subsequent extensions extend from the end). See `generator.js` → `triggerExtendFromFrame()`

### Prune mode (`run prune`)
- One-shot worker that lists every video under a permalink and deletes everything not on the keep-list. The source UUID is always kept. Supports `--keep <uuids>`, `--keep-file <path>`, and `--dry-run`. No manifest, no generation — just navigation + delete

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
| Rate limit | Stop new work, finish current video, manifest → `STOPPED_RATE_LIMIT` | WARN |
| Ghost extend | Grok pointed the extend at an unrelated video. Worker preserves prior real extends, manifest → `STOPPED_GHOST_EXTEND` (with ghost URL in stop reason) | WARN |
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
- `VIDEO_GENERATION_TIMEOUT`: 120000ms (increased for higher resolutions/durations)
- `DEFAULT_PARALLELISM`: 10 workers
- `MODERATION_RETRY_MAX`: 100 retries for content moderation
- `HEADED_MODE`: true (set false for production)

UI selectors are centralized in `src/config.js` → update there when Grok UI changes.

## Directory Structure

```
./logs/runs/<job-name>.log              # Single-run logs (persists)
./logs/autorun/<session-id>/            # Autorun logs (persists)
    ├── run.log                         # Session-level events
    ├── summary.log                     # Per-cycle tallies
    └── detailed/<job-name>.log         # Per-job detailed trace
./logs/uuid-registry/<job-name>.txt     # Persistent UUID dedup registry

./cache/<job-name>/                     # Ephemeral (auto-cleaned after run)
    ├── manifest.json
    └── worker-profiles/

./downloads/<job-name>/                 # Downloaded videos (if autoDownload enabled)
                                        # Filenames: YYMMDD-HHmmss_<full-UUID>_<DUR>s.mp4
                                        # HD upscales append _hd before .mp4
```
