# 🚀 Grok Batch Video Generator - START HERE

## What This Tool Does

Automates batch video generation in Grok Imagine:
- Generate up to **100 videos** from a single Grok image permalink
- Uses **browser automation** (no API credits needed)
- **Persistent login** - set up once, reuse forever
- **Automatic rate-limit detection** and graceful stopping

## Installation (One-Time Setup)

### Step 1: Install Node.js

**If you have Homebrew:**
```bash
brew install node
```

**Otherwise:** Download from https://nodejs.org/ (LTS version)

### Step 2: Install Project Dependencies

```bash
cd "/Users/hansenliang/Projects/Imagine batch runner"
npm install
npx playwright install chromium
```

### Step 3: Verify

```bash
npm test
```

Expected output:
```
✅ Code structure is valid!
```

## Quick Start (First Run)

### 1. Add Your Grok Account

```bash
npm run account:add my-account
```

→ Browser opens → Log in to Grok → Close browser

### 2. Generate Videos

```bash
npm run run -- \
  --account my-account \
  --permalink "https://grok.com/imagine/post/060ec750-c502-4fb2-9de0-562bdd2e599e" \
  --prompt "camera pans into a detail of the dandelions softly moving in the wind" \
  --count 10
```

### 3. Done!

Videos are now generated in the Grok UI. Open your permalink to see them!

## Where to Find Everything

| What You Need | Where to Look |
|--------------|---------------|
| **Installation help** | [SETUP.md](./SETUP.md) |
| **Quick start** | [QUICKSTART.md](./QUICKSTART.md) |
| **Full documentation** | [README.md](./README.md) |
| **Usage examples** | [EXAMPLES.md](./EXAMPLES.md) |
| **Technical details** | [PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md) |
| **Adjust settings** | [src/config.js](./src/config.js) |

## Common Commands

```bash
# Account management
npm run account:add <name>      # Add new account
npm run account:list            # List accounts

# Run videos
npm run run -- --account <name> --permalink <url> --prompt "<text>" --count <N>
```

## Typical Workflow

1. **Setup** (once): `npm run account:add my-account`
2. **Generate**: Use `npm run run` with your permalink
3. **Monitor**: Videos appear in Grok UI as they're generated
4. **If rate-limited**: Wait before starting another run
5. **Download**: Manually download from Grok UI (no auto-download yet)

## Important Notes

- ✅ **No downloads yet**: Videos are generated but not auto-downloaded (coming in v1.1)
- ✅ **Rate limits**: Grok allows ~100 videos per 4 hours per account
- ✅ **Multiple accounts**: Run multiple instances in parallel for higher throughput

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "npm not found" | Install Node.js ([SETUP.md](./SETUP.md)) |
| "Account not found" | Run `npm run account:add <name>` first |
| Videos timeout | Increase timeout in [src/config.js](./src/config.js) |
| Rate limited | Wait ~4 hours before starting another run |
| Session expired | Re-run `npm run account:add <name>` to re-login |

## Example: Generate 100 Videos

```bash
# Step 1: Add account (if not already done)
npm run account:add primary

# Step 2: Start large batch
npm run run -- \
  --account primary \
  --permalink "https://grok.com/imagine/post/YOUR_POST_ID" \
  --prompt "slow cinematic zoom on the subject" \
  --count 100 \
  --job-name "cinematic-batch-001"

```

## What Happens When You Run

1. Tool opens Chrome with your saved login
2. Navigates to your permalink
3. For each video:
   - Clicks "Make video" or "Redo"
   - Enters your prompt
   - Waits for video to complete (~15-30s)
   - Repeats
4. Stops gracefully on rate limit
5. Saves logs and a manifest for inspection

## Performance

- **Small batch (10 videos)**: ~5 minutes
- **Medium batch (50 videos)**: ~25 minutes
- **Large batch (100 videos)**: ~45 minutes (may hit rate limit)
- **Per video**: 15-30 seconds generation time

## Multi-Account Power User Setup

```bash
# Setup 3 accounts
npm run account:add account1
npm run account:add account2
npm run account:add account3

# Run 3 terminals in parallel (300 videos total!)
# Terminal 1:
npm run run -- --account account1 --permalink <url> --prompt "<text>" --count 100

# Terminal 2:
npm run run -- --account account2 --permalink <url> --prompt "<text>" --count 100

# Terminal 3:
npm run run -- --account account3 --permalink <url> --prompt "<text>" --count 100
```

## Need Help?

1. **Read [QUICKSTART.md](./QUICKSTART.md)** for step-by-step guide
2. **Read [EXAMPLES.md](./EXAMPLES.md)** for advanced examples
3. **Check [PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md)** for architecture details
4. **Adjust [src/config.js](./src/config.js)** for your specific needs

## Current Limitations (v1.0)

- ❌ No auto-download (manual download from Grok UI)
- ❌ Single prompt per run (start new run for different prompts)
- ❌ No concurrent runs per account (but multiple accounts OK)

## Coming in v1.1

- ✅ Auto-download videos
- ✅ Prompt CSV support (multiple prompts, one run)
- ✅ Dry-run mode (validate without generating)
- ✅ Goal mode ("generate until N successes")

---

**Ready to start?** Run `npm install` and then `npm run account:add <name>`!

Questions? Check [EXAMPLES.md](./EXAMPLES.md) for troubleshooting and tips.
