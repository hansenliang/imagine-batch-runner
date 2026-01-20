# Grok Batch Video Generator

Local batch image-to-video generator for Grok Imagine. Automate high-volume video generation using your Grok subscription.

## Features

- **Parallel video generation**: Generate up to 100 videos simultaneously using multiple browser contexts
- **Per-account batch generation**: Generate up to 100 videos from a single image permalink
- **Persistent sessions**: Set up multiple account profiles, reuse without re-login
- **Resilient automation**: Automatic retries, rate-limit detection, resume capability
- **Config file support**: Save your settings in JSON for easy reuse
- **No API credits**: Uses browser automation (Playwright) instead of API
- **Permalink-based**: No local image uploads needed
- **True parallel execution**: Each worker maintains its own browser session without page reloads

## Installation

```bash
npm install
npx playwright install chromium
```

## Quick Start

### 1. Add an Account

First, set up a Grok account profile. A browser will open for you to log in:

```bash
npm start accounts add my-account
```

Follow the browser prompts to log in to Grok, then close the browser when done.

### 2. Start a Batch Run

Generate videos from a Grok image permalink:

```bash
npm start run start \
  --account my-account \
  --permalink "https://grok.com/imagine/post/060ec750-c502-4fb2-9de0-562bdd2e599e" \
  --prompt "camera pans into a detail of the dandelions softly moving in the wind" \
  --count 20 \
  --parallel 10
```

The tool will:
- Launch 10 parallel browser contexts (workers) - each in its own Chrome window
- Open the permalink in each authenticated browser session
- Generate 20 video variations using the same image + prompt
- Automatically detect rate limits and stop gracefully
- Save progress to `~/GrokBatchRuns/<job-name>/`

**Note**: Each worker runs in a separate Chrome window for isolation. This is normal behavior.

**Tip**: Start with `--parallel 10` (default). You can go up to `--parallel 100` for maximum speed, but you'll likely hit rate limits quickly.

### 3. Resume a Stopped Run

If a run was stopped (rate limit, failure, etc.), resume it:

```bash
npm start run resume ~/GrokBatchRuns/job_1234567890
```

## Commands

### Account Management

```bash
# Add a new account (opens browser for login)
npm start accounts add <alias>

# List all configured accounts
npm start accounts list
```

### Run Management

```bash
# Start a new batch run with config file (recommended)
npm start run start --config batch-config.json

# Or start with command-line options
npm start run start \
  --account <alias> \
  --permalink <url> \
  --prompt "<text>" \
  --count <number> \
  --parallel <workers> \
  [--job-name <name>]

# Resume a stopped run
npm start run resume <run-directory>

# Resume with different parallelism
npm start run resume <run-directory> --parallel 20

# Show run status
npm start run status <run-directory>

# List all runs
npm start run list
```

### Using Config Files

Create a `batch-config.json` file (see `batch-config.example.json`):

```json
{
  "account": "my-account",
  "permalink": "https://grok.com/imagine/post/YOUR_IMAGE_ID",
  "prompt": "cinematic slow pan over landscape",
  "count": 20,
  "jobName": "landscape_videos",
  "parallel": 10
}
```

Then run:

```bash
# Option 1: Use the npm script (easiest)
npm run run:config batch-config.json

# Option 2: Direct node execution
node src/cli.js run start --config batch-config.json

# Option 3: With npm start (requires -- separator)
npm start -- run start --config batch-config.json
```

**Benefits**: Easier to reuse settings, track what you ran, and share configs.

## Configuration

Edit `src/config.js` to customize:

- **Timeouts**: Video generation timeout (default: 60s)
- **Retries**: Max retries per video (default: 3)
- **Rate limits**: Videos per period (default: 100 per 4 hours)
- **Browser mode**: Headed vs headless (default: headed for debugging)
- **Chrome profile**: Optional system profile via env vars

### Use your real Chrome profile (recommended if captcha loops)

Set these env vars before running commands:

```bash
# macOS example
export CHROME_USER_DATA_DIR="/Users/<you>/Library/Application Support/Google/Chrome"
export CHROME_PROFILE_NAME="Default"   # or "Profile 1", "Profile 2", etc.
```

This will copy your profile into the tool's own user-data directory
(Playwright can't launch Chrome with the default profile directly).

Then run account setup again:

```bash
npm start accounts add <alias>
```

Make sure all Chrome windows are closed before launching.

## Rate Limiting

The tool automatically detects Grok's rate limits by:
- Monitoring UI messages/toasts
- Checking for disabled buttons
- Detecting error states

When rate-limited:
- Run stops gracefully
- Progress is saved
- Resume when ready with `run resume`

## Output Structure

Each run creates a directory at `~/GrokBatchRuns/<job-name>/`:

```
~/GrokBatchRuns/job_1234567890/
├── manifest.json          # Run metadata and progress
├── manifest.lock         # Lock file for parallel coordination
├── run.log               # Detailed logs (from all workers)
├── debug/                # Screenshots on errors
│   ├── initial.png       # Initial state
│   └── worker-*_error_*.png  # Worker-specific error screenshots
└── worker-profiles/      # Temporary worker profile copies (auto-cleaned)
    ├── worker-0/
    ├── worker-1/
    └── ...
```

## Troubleshooting

### "AUTH_REQUIRED" Error

Your session expired. Re-run account setup:

```bash
npm start accounts add <alias>
```

### Generation Timeout

If videos take longer than 60s, increase timeout in `src/config.js`:

```javascript
VIDEO_GENERATION_TIMEOUT: 120000  // 2 minutes
```

### Rate Limit Too Aggressive

Adjust expected rate limit in `src/config.js`:

```javascript
DEFAULT_RATE_LIMIT: 50  // 50 videos instead of 100
DEFAULT_RATE_PERIOD: 2 * 60 * 60 * 1000  // 2 hours instead of 4
```

## Parallel Execution Strategies

### Single-Account Parallelism (Recommended)

Generate multiple videos simultaneously with one account:

```bash
npm start run start \
  --account my-account \
  --permalink <url> \
  --prompt "<text>" \
  --count 100 \
  --parallel 10
```

- **2 workers**: Conservative, minimal rate limit risk
- **10 workers** (default): Good balance of speed and rate limit safety
- **50 workers**: 5x faster, higher rate limit risk
- **100 workers**: Maximum speed (100 videos in ~30s), will likely hit rate limits

**How it works**: Each worker runs in its own isolated browser context (separate Chrome window). Workers process videos from a shared queue, automatically claiming the next available task. No page reloads means uninterrupted video generation.

### Multi-Account Parallelism

To utilize multiple subscriptions, run multiple instances in parallel:

```bash
# Terminal 1
npm start run start --account account1 --permalink <url> --prompt "<text>" --count 100 --parallel 10

# Terminal 2
npm start run start --account account2 --permalink <url> --prompt "<text>" --count 100 --parallel 10
```

Each instance uses a separate browser profile and can run concurrently.

### Performance Estimates

- **Sequential** (no --parallel): 100 videos in 25-50 minutes
- **10 workers**: 100 videos in 2.5-5 minutes (10x faster)
- **100 workers**: 100 videos in 15-30 seconds (100x faster, high rate limit risk)

## Limitations

- **No downloads**: Videos are generated but not downloaded (you'll need to download manually from Grok UI)
- **Single prompt per run**: All videos use the same prompt (use multiple runs for variation)
- **macOS focused**: Tested on macOS, should work on Linux/Windows with minor adjustments

## License

MIT
