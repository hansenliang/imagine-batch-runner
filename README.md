# Grok Batch Video Generator

Local batch image-to-video generator for Grok Imagine.

AI generation is inherently random, so to get the best results, you often need to run jobs in batches. This tool automates that process using browser automation (Playwright).

## Features

- **Parallel generation**: Up to 100 simultaneous workers
- **Persistent sessions**: Set up accounts once, reuse without re-login
- **Rate-limit aware**: Automatic detection and graceful stopping
- **Auto-download**: Optionally download and upscale videos
- **Config files**: Save settings in JSON for easy reuse

## Installation

```bash
npm install
npx playwright install chromium
```

## Quick Start

### 1. Add an Account

```bash
npm start accounts add my-account
```

A browser opens. Log in to Grok, then close it.

### 2. Run a Batch

```bash
npm start run start \
  --account my-account \
  --permalink "https://grok.com/imagine/post/YOUR_POST_ID" \
  --prompt "camera pans slowly over the landscape" \
  --count 20 \
  --parallel 10
```

Or use a config file:

```bash
node src/cli.js run start --config batch-config.json
```

### 3. View Results

Videos appear in Grok UI at your permalink. Downloads go to `./downloads/<job-name>/` if enabled.

## Documentation

For detailed guides:

- **[Quick Start Guide](docs/quickstart.md)** — Installation and first run
- **[Architecture](docs/architecture.md)** — Technical deep-dive for contributors
- **[Usage Examples](docs/examples.md)** — Config files, parallel execution, auto-run

## Commands

```bash
# Account management
npm start accounts add <alias>      # Add account
npm start accounts list             # List accounts

# Batch runs
npm start run start --config <file> # Start from config
npm start run start --account <alias> --permalink <url> --prompt "<text>" --count <n>

# Auto-run (scheduled)
npm start autorun start --interval 4h --config-dir ./autorun-configs
```

## Configuration

See `batch-config.example.json` for config file format.

Edit `src/config.js` for timeouts, rate limits, and browser settings.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `AUTH_REQUIRED` | Re-run `npm start accounts add <alias>` |
| Videos timing out | Increase `VIDEO_GENERATION_TIMEOUT` in `src/config.js` |
| Rate limited | Wait ~4 hours, then rerun |

## License

MIT
