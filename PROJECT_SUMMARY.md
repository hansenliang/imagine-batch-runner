# Grok Batch Video Generator - Project Summary

## What Was Built

A production-ready CLI tool for batch-generating videos from Grok Imagine image permalinks using browser automation (Playwright), with persistent account sessions and rate-limit aware execution.

## Architecture Overview

### Core Components

1. **Account Manager** (`src/core/accounts.js`)
   - Manages persistent browser profiles per account
   - Headed browser login flow for authentication
   - Account listing and tracking

2. **Video Generator** (`src/core/generator.js`)
   - State machine for video generation workflow
   - Handles "Make video" vs "Redo" button scenarios
   - Prompt entry and submission
   - Wait for completion with timeout
   - Debug artifact capture on failures

3. **Manifest Manager** (`src/core/manifest.js`)
   - Run state persistence (JSON)
   - Per-item status tracking (PENDING, IN_PROGRESS, COMPLETED, FAILED)
   - Progress counters
   - Atomic updates for parallel workers

4. **Parallel Runner** (`src/core/parallel-runner.js`)
   - Orchestrates 1-100 workers (parallelism=1 runs sequentially)
   - Worker lifecycle and cleanup
   - Rate-limit coordination and final summary reporting

5. **Parallel Worker** (`src/core/worker.js`)
   - Dedicated browser context per worker
   - Claims work items atomically
   - Handles success/failure/rate-limit signaling

6. **CLI Interface** (`src/cli.js`)
   - Commander.js-based command structure
   - Account management commands
   - Run start command with config support
   - Colorful terminal output (Chalk)

7. **Utilities**
   - **Logger** (`src/utils/logger.js`): File + console logging with levels

### Configuration (`src/config.js`)

Centralized configuration for:
- Paths (profiles, runs directory)
- Timeouts (video generation, page load, element wait)
- Rate limiting (100 videos per 4 hours, configurable)
- Browser settings (headed mode, viewport)
- **UI Selectors**: Centralized for easy updates when Grok UI changes

## Key Features Implemented

### ✅ MVP Requirements Met

| Requirement | Status | Implementation |
|------------|--------|----------------|
| Per-account runs | ✅ | Persistent browser profiles, one run per account |
| Permalink-based reference | ✅ | Direct navigation + validation |
| Batch generation (N ≤ 100) | ✅ | Configurable batch size, default 10, max 100 |
| Rate-limit detection | ✅ | UI toast/message detection + disabled button checks |
| Graceful stop on rate limit | ✅ | STOPPED_RATE_LIMIT status, preserves state |
| Debug artifacts | ✅ | Screenshots + HTML on errors |
| Account setup & persistence | ✅ | Headed browser login, profile directory storage |
| Run logs and metadata | ✅ | run.log + manifest.json per run |

### 🚀 Beyond MVP (Bonus Features)

- **Progress tracking**: Real-time progress bar in CLI
- **Job naming**: Custom job names for organization
- **Consecutive failure protection**: Stop after 5 consecutive failures
- **Last used tracking**: Account usage timestamps
- **Validation**: Input validation for batch size, permalink format

## File Structure

```
Imagine batch runner/
├── package.json                 # Dependencies: playwright, commander, chalk, ora, uuid
├── .gitignore                   # Excludes node_modules, profiles, runs, logs
├── README.md                    # Main documentation
├── SETUP.md                     # Node.js installation guide
├── EXAMPLES.md                  # Comprehensive usage examples
├── PROJECT_SUMMARY.md           # This file
│
├── src/
│   ├── cli.js                   # CLI entry point (Commander)
│   ├── config.js                # Centralized configuration + selectors
│   │
│   ├── core/
│   │   ├── accounts.js          # Account management
│   │   ├── browser.js           # Legacy browser utilities
│   │   ├── generator.js         # Video generation logic
│   │   ├── manifest.js          # State persistence
│   │   ├── parallel-runner.js   # Orchestration
│   │   └── worker.js            # Worker logic
│   │
│   └── utils/
│       └── logger.js            # Logging utility
│
├── profiles/                    # (Created at runtime) Browser profiles per account
│   ├── accounts.json            # Account registry
│   └── <account-alias>/         # Persistent browser data
│
└── ~/GrokBatchRuns/             # (Created at runtime) Run outputs
    └── <job-name>/
        ├── manifest.json        # Run state
        ├── run.log             # Detailed logs
        └── debug/              # Screenshots
```

## Technical Decisions & Rationale

### Why Playwright?
- Industry-standard browser automation
- Persistent contexts for session reuse
- Excellent selector resilience
- Built-in download handling (for future enhancement)

### Why Headed Mode by Default?
- Easier debugging during initial rollout
- Some sites block headless browsers
- User can monitor progress visually
- Can switch to headless in config once stable

### Why No Download in MVP?
- Simplifies initial implementation
- User feedback: manual download is acceptable
- Can add in v1.1 without breaking changes

### Resilience Strategies
1. **Centralized selectors**: Easy to update when UI changes
2. **Multiple detection methods**: Check for buttons, toasts, disabled states
3. **Debug artifacts**: Always capture state on failure
4. **Graceful degradation**: Continue on single-item failures

### State Management
- **Manifest-driven**: Single source of truth
- **Atomic updates**: Save after each item
- **Manifest-driven**: Track status and attempts per item

## Configuration Tuning

Users can adjust these in `src/config.js`:

```javascript
// If videos take longer than 60s
VIDEO_GENERATION_TIMEOUT: 120000

// If rate limits are more aggressive
DEFAULT_RATE_LIMIT: 50  // Instead of 100
DEFAULT_RATE_PERIOD: 2 * 60 * 60 * 1000  // 2 hours instead of 4

// For production runs (less visual overhead)
HEADED_MODE: false
```

## Future Enhancements (Not Implemented)

### v1.1 Potential Features
1. **Auto-download**: Save videos to disk automatically
2. **Prompt CSV**: Multiple prompts from CSV file
3. **Goal mode**: "Generate until I have N successes"
4. **Dry-run**: Validate permalink + UI without generating
5. **Multi-account coordination**: Single job across multiple accounts
6. **Webhook notifications**: Notify on completion/rate-limit
7. **Quality selection**: Choose HD/480p before generation

### Selector Updates
If Grok updates their UI, update `src/config.js`:

```javascript
export const selectors = {
  MAKE_VIDEO_BUTTON: 'button:has-text("New Button Text")',
  // ... etc
};
```

## Testing Checklist

Before first use:
- [ ] Node.js installed (`node --version`)
- [ ] Dependencies installed (`npm install`)
- [ ] Playwright browsers installed (`npx playwright install chromium`)
- [ ] Account added (`npm start accounts add test`)
- [ ] Small test run (`--count 5`)
- [ ] Rate limit handling tested

## Known Limitations

1. **No download**: Videos must be downloaded manually from Grok UI
2. **Single prompt per run**: Can't vary prompts within one run
3. **macOS focused**: Tested on macOS, may need path adjustments for Windows
4. **UI dependency**: Breaks if Grok significantly changes their UI (fixable via selector updates)
5. **No concurrent runs per account**: One run per account at a time (but multiple accounts can run in parallel)

## Performance Expectations

- **Generation time**: 10-30s per video (Grok-dependent)
- **Rate limit**: ~100 videos per 4 hours per account (Grok policy)
- **Batch of 10**: ~3-5 minutes
- **Batch of 100**: ~30-50 minutes (if no rate limit hit)

## Success Metrics

The tool is successful when:
- ✅ User can add account and reuse session across runs
- ✅ User can generate N videos (N ≤ 100) from one permalink
- ✅ Tool detects rate limits and stops gracefully
- ✅ User can resume a stopped run
- ✅ Logs and debug artifacts help troubleshoot failures

## Credits

Built with:
- **Playwright**: Browser automation
- **Commander**: CLI framework
- **Chalk**: Terminal colors
- **Ora**: Spinners (dependency, not yet used)
- **UUID**: Unique job IDs

---

**Ready to use!** See [SETUP.md](./SETUP.md) for installation and [EXAMPLES.md](./EXAMPLES.md) for usage.
