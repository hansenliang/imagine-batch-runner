# Grok Batch Video Generator

Local batch image-to-video generator for Grok Imagine. Automate high-volume video generation using your Grok subscription.

## Features

- **Per-account batch generation**: Generate up to 100 videos from a single image permalink
- **Persistent sessions**: Set up multiple account profiles, reuse without re-login
- **Resilient automation**: Automatic retries, rate-limit detection, resume capability
- **No API credits**: Uses browser automation (Playwright) instead of API
- **Permalink-based**: No local image uploads needed

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
  --count 20
```

The tool will:
- Open the permalink in the authenticated browser
- Generate 20 video variations using the same image + prompt
- Automatically detect rate limits and stop gracefully
- Save progress to `~/GrokBatchRuns/<job-name>/`

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
# Start a new batch run
npm start run start \
  --account <alias> \
  --permalink <url> \
  --prompt "<text>" \
  --count <number> \
  [--job-name <name>]

# Resume a stopped run
npm start run resume <run-directory>

# Show run status
npm start run status <run-directory>

# List all runs
npm start run list
```

## Configuration

Edit `src/config.js` to customize:

- **Timeouts**: Video generation timeout (default: 60s)
- **Retries**: Max retries per video (default: 3)
- **Rate limits**: Videos per period (default: 100 per 4 hours)
- **Browser mode**: Headed vs headless (default: headed for debugging)

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
├── run.log               # Detailed logs
└── debug/                # Screenshots on errors
    ├── initial.png       # Initial state
    └── error_*.png       # Error screenshots
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

## Multi-Account Parallelism

To utilize multiple subscriptions, run multiple instances in parallel:

```bash
# Terminal 1
npm start run start --account account1 --permalink <url> --prompt "<text>" --count 100

# Terminal 2
npm start run start --account account2 --permalink <url> --prompt "<text>" --count 100
```

Each instance uses a separate browser profile and can run concurrently.

## Limitations

- **No downloads**: Videos are generated but not downloaded (you'll need to download manually from Grok UI)
- **Single prompt per run**: All videos use the same prompt (use multiple runs for variation)
- **macOS focused**: Tested on macOS, should work on Linux/Windows with minor adjustments

## License

MIT
