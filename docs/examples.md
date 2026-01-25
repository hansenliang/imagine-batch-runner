# Usage Examples

## Basic Workflow

### 1. Setup Account
```bash
npm start accounts add primary-account
```

### 2. Run Batch
```bash
npm start run start \
  --account primary-account \
  --permalink "https://grok.com/imagine/post/YOUR_POST_ID" \
  --prompt "camera pans into a detail of the dandelions" \
  --count 10 \
  --parallel 10
```

### 3. Handle Rate Limit
If the run stops with `STOPPED_RATE_LIMIT`, wait ~3 hours and rerun with the same config.

## Config File Usage

Create `batch-config.json`:
```json
{
  "account": "primary-account",
  "permalink": "https://grok.com/imagine/post/YOUR_POST_ID",
  "prompt": "cinematic slow pan over landscape",
  "count": 20,
  "parallel": 10,
  "autoDownload": true,
  "autoUpscale": true,
  "autoDelete": false
}
```

Run:
```bash
node src/cli.js run start --config batch-config.json
```

## Parallel Execution

| Workers | 100 Videos Time | Rate Limit Risk |
|---------|----------------|-----------------|
| 1 | 25-50 min | Low |
| 10 (default) | 2.5-5 min | Medium |
| 50 | 30-60 sec | High |
| 100 | 15-30 sec | Very High |

```bash
# Conservative
npm start run start --parallel 5 ...

# Maximum speed (will hit rate limits quickly)
npm start run start --parallel 100 ...
```

## Multiple Accounts

Run in separate terminals for higher throughput:

**Terminal 1:**
```bash
npm start run start --account account1 --permalink <url> --prompt "<text>" --count 100
```

**Terminal 2:**
```bash
npm start run start --account account2 --permalink <url> --prompt "<text>" --count 100
```

## Auto-Run Mode

Continuous scheduled runs from a config directory:

```bash
# Run every 3 hours (default)
npm start autorun start --interval 3h --config-dir ./autorun-configs

# Run once and exit
npm start autorun start --run-once --config-dir ./autorun-configs

# Dry run (validate configs without executing)
npm start autorun start --dry-run --config-dir ./autorun-configs
```

Place config files in `./autorun-configs/`:
```
autorun-configs/
├── job1.json
├── job2.json
└── job3.json
```

## Viewing Generated Videos

Videos are generated in the Grok UI but not auto-downloaded by default. To view:
1. Open your permalink in a browser
2. Click through generated videos
3. Download manually, or enable `--auto-download`
