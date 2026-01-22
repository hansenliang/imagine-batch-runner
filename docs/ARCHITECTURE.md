# Architecture Documentation

## System Overview

Grok Batch Video Generator is a Playwright-based automation tool that generates multiple videos from a single Grok Imagine image permalink. The system supports parallel execution with 1-100 workers, each using isolated Chrome browser profiles to avoid conflicts.

## Core Architecture

### High-Level Flow

```
User Command (CLI)
    ↓
ParallelRunner (Orchestration)
    ↓
Worker Pool (1-100 Workers)
    ↓
[Worker 0]  [Worker 1]  ...  [Worker N]
    ↓           ↓              ↓
[Browser]   [Browser]      [Browser]
    ↓           ↓              ↓
VideoGenerator instances
    ↓
Shared Manifest (File-Locked State)
```

### Component Relationships

```
┌─────────────────────────────────────────────────┐
│              CLI Interface (cli.js)              │
│  - Parses commands and flags                     │
│  - Validates inputs                              │
│  - Delegates to ParallelRunner                   │
└─────────────────┬───────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────┐
│      ParallelRunner (parallel-runner.js)        │
│  - Creates N workers                             │
│  - Initializes workers in parallel (no stagger)  │
│  - Monitors completion and rate limits           │
│  - Produces final summary                        │
└────┬──────────┬──────────┬───────────────────┬──┘
     ↓          ↓          ↓                   ↓
┌─────────┐ ┌─────────┐ ┌─────────┐       ┌─────────┐
│Worker 0 │ │Worker 1 │ │Worker 2 │  ...  │Worker N │
│(worker) │ │(worker) │ │(worker) │       │(worker) │
└────┬────┘ └────┬────┘ └────┬────┘       └────┬────┘
     ↓           ↓           ↓                  ↓
     └───────────┴───────────┴──────────────────┘
                         ↓
          ┌──────────────────────────────┐
          │ Shared Manifest (manifest.js)│
          │  - File-locked for atomicity │
          │  - Work queue (claim items)  │
          │  - Progress tracking          │
          └──────────────────────────────┘
```

## Component Deep Dive

### 1. CLI Interface (`src/cli.js`)

**Purpose**: Entry point for all user commands

**Commands**:
- `accounts add <alias>` - Add new Grok account with persistent session
- `accounts list` - Show configured accounts
- `run start` - Start video generation batch

**Key Validation**:
- Batch size: 1-100
- Parallelism: 1-100
- Account exists
- Permalink format

**Config File Support**:
- Reads JSON config with `--config` flag
- CLI flags override config values
- Priority: CLI flags > config file > defaults

### 2. Parallel Runner (`src/core/parallel-runner.js`)

**Purpose**: Orchestrates multiple workers for concurrent execution

**Lifecycle**:
1. **Init Phase**:
   - Create run directory: `~/GrokBatchRuns/<job-name>/`
   - Initialize manifest with batch items
   - Create worker profile directory structure
   - Initialize logger

2. **Execution Phase**:
   - Spawn N workers in parallel (no startup delay)
   - Each worker runs independently
   - Monitor for global signals (rate limit, stop)
   - Wait for all workers to complete

3. **Cleanup Phase**:
   - Close all browser contexts
   - Delete worker profiles (if configured)
   - Print color-coded summary
   - Save final manifest state

**Rate Limit Coordination**:
- Any worker detecting rate limit sets global flag
- All workers finish current video, then stop claiming new work
- Run status → `STOPPED_RATE_LIMIT`

### 3. Worker (`src/core/worker.js`)

**Purpose**: Independent video generation in isolated browser context

**Initialization**:
1. Create worker-specific profile directory
2. Copy account profile to worker directory
3. Launch Chromium persistent context with profile
4. Navigate to permalink (once)
5. Verify authentication
6. Create VideoGenerator instance

**Work Loop**:
```javascript
while (!shouldStop) {
  // Atomically claim next pending item from manifest
  item = await manifest.claimNextItem(workerId)

  if (!item) break  // No more work

  // Generate video
  result = await generator.generate(item.index, prompt)

  // Update manifest atomically
  if (result.success) {
    await manifest.updateItemAtomic(item.index, { status: 'COMPLETED' })
  } else if (result.rateLimited) {
    signalGlobalRateLimit()
    break
  } else {
    await manifest.updateItemAtomic(item.index, { status: 'FAILED', error })
  }
}
```

**Profile Isolation**:
- Each worker gets independent Chrome profile copy
- Prevents "Chrome is already in use" errors
- Profiles stored in `{runDir}/worker-profiles/worker-{id}/`
- Auto-cleaned after run completion

### 4. Video Generator (`src/core/generator.js`)

**Purpose**: Handles UI automation for single video generation

**State Machine**:
```
START
  ↓
[1] Click Generation Button
  ↓
Check: Rate limit? → YES → Return { rateLimited: true }
  ↓ NO
[2] Enter Prompt (if needed)
  ↓
[3] Wait for Completion
  ↓
Poll every 2s:
  - Check for errors (content moderation, network, generation)
  - Check for success (video element + playability)
  - Check for timeout
  ↓
Success? → Return { success: true }
Error?   → Return { success: false, error }
```

**Button Detection**:
- "Make video" button (first video)
- "Redo" button (subsequent videos)
- Fallback: Find button near prompt input

**Completion Detection**:
1. **Error checks** (checked first, every 2s):
   - Content moderation message
   - Network error message
   - Generation error message
   - Rate limit message

2. **Success checks**:
   - Video element exists
   - Video has valid `src` attribute
   - Video `duration > 0` (playable)
   - No error messages present

3. **Timeout**: Default 60s (configurable)

**Debug Artifacts**:
- Screenshots on error: `debug/worker-{id}_error_{timestamp}.png`
- HTML snapshots: `debug/worker-{id}_error_{timestamp}.html`

### 5. Manifest Manager (`src/core/manifest.js`)

**Purpose**: Thread-safe state persistence for parallel workers

**Data Structure**:
```javascript
{
  id: "uuid",
  jobName: "job_12345",
  accountAlias: "my-account",
  permalink: "https://...",
  prompt: "camera pan...",
  batchSize: 100,
  status: "IN_PROGRESS",  // PENDING, IN_PROGRESS, COMPLETED, STOPPED_RATE_LIMIT, FAILED
  createdAt: "2026-01-21T...",
  updatedAt: "2026-01-21T...",
  nextIndex: 45,
  completedCount: 42,
  failedCount: 3,
  rateLimitedCount: 0,
  items: [
    {
      index: 0,
      status: "COMPLETED",  // PENDING, IN_PROGRESS, COMPLETED, FAILED, RATE_LIMITED
      attempts: 1,
      workerId: "worker-0",
      createdAt: "2026-01-21T...",
      completedAt: "2026-01-21T...",
      error: null
    },
    // ... more items
  ],
  lastError: null,
  stopReason: null
}
```

**Atomic Operations** (with file locking):

1. **`claimNextItem(workerId)`**:
   ```javascript
   await lock.withLock(async () => {
     reload manifest from disk
     find first item with status === 'PENDING'
     set item.status = 'IN_PROGRESS'
     set item.workerId = workerId
     increment item.attempts
     save manifest to disk
     return item
   })
   ```

2. **`updateItemAtomic(index, updates, workerId)`**:
   ```javascript
   await lock.withLock(async () => {
     reload manifest from disk
     validate workerId matches item.workerId
     apply updates to item
     update counters (completedCount, failedCount)
     save manifest to disk
   })
   ```

3. **`updateStatusAtomic(newStatus)`**:
   ```javascript
   await lock.withLock(async () => {
     reload manifest from disk
     set manifest.status = newStatus
     save manifest to disk
   })
   ```

**File Locking** (`src/utils/lock.js`):
- Uses atomic file creation (`O_CREAT | O_EXCL`)
- Retries every 100ms if lock held
- 30s timeout with error
- Auto-cleanup of stale locks (>60s old)
- Stores lock holder PID for debugging

### 6. Logger (`src/utils/logger.js`)

**Purpose**: Dual-output logging (console + file)

**Log Levels**:
- `info` - General information
- `success` - Successful operations (green)
- `warn` - Warnings (yellow)
- `error` - Errors (red)
- `debug` - Verbose debugging

**Privacy Protection**:
- **Never logs prompt text** to console or file
- Logs "prompt provided" instead
- Prevents accidental prompt exposure in CLI output

**Output**:
- Console: Formatted with chalk colors
- File: `run.log` with timestamps

## Data Flow

### Startup Flow

```
1. User runs: npm start -- run start --config batch-config.json

2. CLI validates config and creates ParallelRunner

3. ParallelRunner.init():
   - Create ~/GrokBatchRuns/<job-name>/
   - Initialize manifest.json
   - Initialize run.log

4. ParallelRunner.start():
   - Create N workers
   - Initialize all workers in parallel
     [Worker 0 init] | [Worker 1 init] | ... | [Worker N init]
   - Each worker:
     - Copies account profile
     - Launches browser
     - Navigates to permalink
     - Verifies auth

5. Workers enter work loop (parallel execution)
```

### Video Generation Flow (Single Worker)

```
Worker claims item from manifest (atomic)
  ↓
Navigate to permalink (already there)
  ↓
VideoGenerator.generate():
  1. Click "Make video" or "Redo"
  2. Check for rate limit → if yes, signal & stop
  3. Enter prompt (if needed)
  4. Wait for completion (poll every 2s)
     - Check errors first
     - Check success
     - Check timeout
  5. Return result
  ↓
Update manifest (atomic):
  - If success: status=COMPLETED, completedCount++
  - If rate limit: status=RATE_LIMITED, signal global stop
  - If error: status=FAILED, failedCount++, save error
  ↓
Claim next item (loop)
```

### Rate Limit Handling

```
Worker detects rate limit (any worker)
  ↓
Set global flag: rateLimitDetected = true
  ↓
Update manifest status: STOPPED_RATE_LIMIT (atomic)
  ↓
All workers:
  - Finish current video (in-flight)
  - Stop claiming new work
  - Graceful shutdown
  ↓
ParallelRunner prints summary:
  "⚠ Run stopped: Rate limit detected"
  "Rerun later with same config"
```

### Shutdown Flow

```
All workers complete (or rate limited)
  ↓
ParallelRunner.cleanup():
  1. Close all browser contexts
  2. Delete worker profiles (if configured)
  3. Calculate final stats
  4. Print color-coded summary:
     - Green: X videos completed
     - Yellow: Y videos failed
     - Red: Rate limit detected (if applicable)
  5. Save final manifest
  ↓
Process exits
```

## Configuration

### Key Settings (`src/config.js`)

```javascript
// Paths
PROFILES_DIR: '~/Library/Application Support/Grok Batch Profiles'
RUNS_DIR: '~/GrokBatchRuns'

// Defaults
DEFAULT_BATCH_SIZE: 10
DEFAULT_PARALLELISM: 10
MAX_PARALLELISM: 100

// Timeouts
VIDEO_GENERATION_TIMEOUT: 60000    // 60s per video
PAGE_LOAD_TIMEOUT: 30000           // 30s for navigation
ELEMENT_WAIT_TIMEOUT: 10000        // 10s for UI elements

// Worker Settings
WORKER_SHUTDOWN_TIMEOUT: 60000     // Grace period
CLAIM_RETRY_INTERVAL: 2000         // Retry delay if no work
WORKER_PROFILE_CLEANUP: true       // Auto-delete profiles

// Browser
HEADED_MODE: true                  // Show browser windows
CHROME_PROFILE_NAME: 'Default'     // Chrome profile to use
```

### UI Selectors (`src/config.js`)

All Grok UI selectors centralized for easy updates:
```javascript
MAKE_VIDEO_BUTTON: 'button:has-text("Make video")'
REDO_BUTTON: 'button:has-text("Redo")'
PROMPT_INPUT: 'textarea[placeholder*="Describe"]'
VIDEO_ELEMENT: 'video[src]'
RATE_LIMIT_MESSAGE: 'text=/rate limit|too many requests/i'
// ... more selectors
```

## Error Handling

### Error Categories

1. **RATE_LIMIT**:
   - Detection: Button disabled + rate limit message
   - Behavior: Stop new work, finish in-flight, exit gracefully
   - Recovery: Wait for cooldown, rerun with same config

2. **AUTH_REQUIRED**:
   - Detection: Login prompt visible
   - Behavior: Stop all workers immediately
   - Recovery: Re-run `accounts add <alias>`

3. **CONTENT_MODERATED**:
   - Detection: "Try a different idea" message
   - Behavior: Mark as failed, continue to next
   - Note: Not retried (permanent failure for that prompt)

4. **NETWORK_ERROR**:
   - Detection: Network error messages
   - Behavior: Mark as failed, continue to next
   - Note: Could be transient, user can rerun

5. **TIMEOUT**:
   - Detection: Generation exceeds 60s timeout
   - Behavior: Mark as failed, continue to next
   - Tuning: Increase `VIDEO_GENERATION_TIMEOUT` if needed

6. **GENERATION_ERROR**:
   - Detection: Generic error messages
   - Behavior: Mark as failed, continue to next

### Error Propagation

```
VideoGenerator.generate()
  → throws error or returns { success: false, error }
    ↓
Worker catches error
  → Updates manifest with error details
  → Continues to next item (unless rate limit/auth)
    ↓
ParallelRunner monitors
  → Aggregates failures
  → Shows summary at end
```

## Performance Characteristics

### Parallelism Scaling

| Workers | 100 Videos Time | Bottleneck |
|---------|----------------|------------|
| 1       | 50-100 min     | Sequential |
| 10      | 5-10 min       | Balanced   |
| 50      | 1-2 min        | Rate limit |
| 100     | 30-60 sec      | Rate limit |

**Recommendation**: Default 10 workers balances speed and rate limit risk.

### Resource Usage

- **CPU**: Low (Playwright overhead)
- **Memory**: ~500MB per worker (Chrome instances)
- **Disk**: ~500MB per worker profile (temp)
- **Network**: Minimal (only UI interactions)

**Example**:
- 10 workers = ~5GB RAM, ~5GB disk (temp)
- 100 workers = ~50GB RAM, ~50GB disk (temp)

### Bottlenecks

1. **Grok Rate Limits**: ~100 videos per 4 hours per account
2. **Video Generation Time**: 15-30s per video (Grok-dependent)
3. **Disk I/O**: Manifest file locking (minimal overhead)

## Testing Strategy

### Import Validation
```bash
npm test
# Validates: All modules load, config valid, selectors present
```

### Manual Testing Checklist

1. **Small parallel run** (10 videos, 10 workers):
   - Verify workers initialize without conflicts
   - Check manifest updates are consistent
   - Confirm no profile errors

2. **Rate limit test**:
   - Run with high parallelism (50 workers)
   - Confirm graceful stop on rate limit
   - Verify manifest status = STOPPED_RATE_LIMIT

3. **Sequential compatibility**:
   - Run with `--parallel 1`
   - Verify single-worker mode works correctly

4. **Failure scenarios**:
   - Use prompts that trigger content moderation
   - Verify failed items marked correctly
   - Confirm workers continue after failures

## Known Limitations

1. **No video download**: Videos generated but not auto-downloaded
2. **Single prompt**: All videos use same prompt per run
3. **No resume**: Rerun creates fresh batch (doesn't skip completed)
4. **Disk space**: High parallelism requires significant temp storage
5. **UI-dependent**: Breaks if Grok significantly changes UI (fixable via selector updates)

## Future Enhancement Opportunities

- Auto-download generated videos
- Multi-prompt support (CSV file input)
- Resume capability (skip completed items)
- Dynamic worker scaling based on rate limit detection
- Distributed execution (workers across machines)
- WebSocket coordination (instead of file locking)
- Prompt variation for content moderation retries
