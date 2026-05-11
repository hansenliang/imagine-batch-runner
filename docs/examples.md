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

### Video Quality Settings

By default, videos use Grok's default duration and resolution. To automatically select maximum values:

```json
{
  "account": "primary-account",
  "permalink": "https://grok.com/imagine/post/YOUR_POST_ID",
  "prompt": "cinematic slow pan over landscape",
  "count": 20,
  "selectMaxDuration": true,
  "selectMaxResolution": true
}
```

- `selectMaxDuration: true` — Selects longest available duration (e.g., 10s over 6s)
- `selectMaxResolution: true` — Selects highest available resolution (e.g., 720p over 480p)

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

## Download Max-Duration Only

When `downloadMaxDurationOnly` is enabled, only videos that reached the maximum duration (30s) are downloaded, upscaled, and deleted. Videos under 30s are left untouched on the server — no download, no upscale, no delete.

This is useful when running auto-extend or max-extend and you only want to collect the fully-extended results, leaving partial extensions on the server for future continuation.

Config file:
```json
{
  "account": "primary-account",
  "permalink": "https://grok.com/imagine/post/YOUR_POST_ID",
  "prompt": "cinematic slow pan over landscape",
  "count": 20,
  "parallel": 3,
  "autoExtend": true,
  "autoDownload": true,
  "autoUpscale": true,
  "autoDelete": true,
  "downloadMaxDurationOnly": true
}
```

CLI usage:
```bash
node src/cli.js run start --config batch-config.json --download-max-duration-only
```

Works in all modes:
```bash
# Normal run with auto-extend
node src/cli.js run start --config config.json --download-max-duration-only

# Max-extend mode
node src/cli.js run max-extend --config max-extend-config.json --download-max-duration-only
```

Also works in autorun configs — just add `"downloadMaxDurationOnly": true` to any config file in the autorun-configs directory.

## Cleanup Remaining Videos

Sometimes videos remain on the server due to failed downloads or deletes. The `downloadAndDeleteRemainingVideos` option runs a cleanup at the end of each batch to ensure all videos are downloaded and deleted:

```json
{
  "account": "primary-account",
  "permalink": "https://grok.com/imagine/post/YOUR_POST_ID",
  "prompt": "cinematic slow pan over landscape",
  "count": 20,
  "autoUpscale": true,
  "downloadAndDeleteRemainingVideos": true
}
```

When enabled:
- `autoDownload` and `autoDelete` are automatically forced to `true`
- After generation completes, any remaining videos on the server are downloaded and deleted
- For non-HD videos: downloads original, upscales (if autoUpscale enabled), downloads HD, then deletes
- For already-HD videos: downloads HD version, then deletes
- Downloaded files are named `YYMMDD-HHmmss_<full-UUID>_<DUR>s.mp4` (HD upscales append `_hd` before the extension). The full UUID means the Grok permalink (`grok.com/imagine/post/<UUID>`) is recoverable directly from the filename
- Re-downloads are prevented by a persistent per-job UUID registry at `./logs/uuid-registry/<job>.txt`. If a UUID is already in the registry the download is skipped entirely (no file written). Pair with `run prune` to clean up server-side leftovers

CLI usage:
```bash
npm start run start --config batch-config.json --download-and-delete-remaining
```

## Max-Extend an Existing Video

Extend an existing short video to the maximum 30s by running multiple parallel chains. Each chain branches independently from the same source video, useful for curating the best 30s result.

```bash
node src/cli.js run max-extend \
  --account my-account \
  --permalink "https://grok.com/imagine/post/abc123" \
  --prompt "pixel art style, looping aesthetic" \
  --count 5 \
  --parallel 3 \
  --auto-download \
  --auto-upscale \
  --auto-delete
```

- `--count` = number of independent extension chains (each aims for 30s)
- `--parallel` = number of workers running chains simultaneously
- `--auto-delete` deletes only extensions that reached 30s, never the original video
- If the permalink is a static image post (no video), each chain generates a new video first, then extends it

See `max-extend-config.example.json` for the config-file form.

## Extend From a Specific Frame

The first extension in a chain can extend from a specific timestamp instead of the end. This trims everything after the chosen frame, then extends from there. Subsequent extensions in the same chain use the normal extend path.

CLI:
```bash
node src/cli.js run max-extend \
  --account my-account \
  --permalink "https://grok.com/imagine/post/abc123" \
  --prompt "..." \
  --extend-from-time 22 \
  --count 3 \
  --parallel 3
```

Config equivalent: `"extendFromTime": 22`. Works in both `run start --auto-extend` and `run max-extend`. See `max-extend-from-frame.example.json`.

## Prune Unwanted Variations

Delete every variation under a permalink except the source (always kept) and a whitelist of UUIDs.

Dry-run first to preview what will be deleted:
```bash
node src/cli.js run prune \
  --account my-account \
  --permalink "https://grok.com/imagine/post/YOUR_POST_ID" \
  --keep uuid1,uuid2 \
  --dry-run
```

Then drop `--dry-run` to actually delete. UUIDs can be full or 8-char prefixes. Alternatively load from a file with `--keep-file <path>` (one UUID per line, `#` comments allowed).

## Viewing Generated Videos

Videos are generated in the Grok UI but not auto-downloaded by default. To view:
1. Open your permalink in a browser
2. Click through generated videos
3. Download manually, or enable `--auto-download`
