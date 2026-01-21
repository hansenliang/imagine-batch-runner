# Quick Start Guide

## Installation (5 minutes)

### 1. Install Node.js

**macOS (using Homebrew):**
```bash
brew install node
```

**Or download from:** https://nodejs.org/ (LTS version)

### 2. Install Dependencies

```bash
cd "/Users/hansenliang/Projects/Imagine batch runner"
npm install
npx playwright install chromium
```

### 3. Verify Installation

```bash
npm test
```

You should see:
```
✓ All imports successful
✓ Config loaded: { ... }
✓ Selectors loaded: 10 selectors

✅ Code structure is valid!
```

## First Run (2 minutes)

### Step 1: Add Your Grok Account

```bash
npm run account:add my-grok
```

A browser will open. Log in to Grok, then **close the browser window**.

### Step 2: Generate Your First Videos

Replace `YOUR_PERMALINK` with your actual Grok image permalink:

```bash
npm run run -- \
  --account my-grok \
  --permalink "https://grok.com/imagine/post/YOUR_POST_ID" \
  --prompt "camera slowly zooms in on the subject" \
  --count 5
```

**Example with real permalink:**
```bash
npm run run -- \
  --account my-grok \
  --permalink "https://grok.com/imagine/post/060ec750-c502-4fb2-9de0-562bdd2e599e" \
  --prompt "camera pans into a detail of the dandelions softly moving in the wind" \
  --count 5
```

### Step 3: Watch It Work

You'll see:
```
🚀 Starting batch run...

Account: my-grok
Permalink: https://grok.com/imagine/post/...
Batch size: 5

[INFO] Initializing batch runner
[SUCCESS] Run initialized
[INFO] Navigating to permalink
[SUCCESS] Permalink loaded and validated
[INFO] [Video 1] Starting generation
[SUCCESS] [Video 1] Generation completed
[████░░░░░░░░░░░░░░░░] 1/5 (20%) Generating video 2...
```

### Step 4: View Results

The videos are now visible in the Grok UI at your permalink! Open it in a browser to see them.

## Common Commands

```bash
# List your accounts
npm run account:list
```

## Next Steps

- **Read [README.md](./README.md)** for full documentation
- **Read [EXAMPLES.md](./EXAMPLES.md)** for advanced usage
- **Adjust [src/config.js](./src/config.js)** to tune timeouts and limits

## Troubleshooting

### "command not found: npm"
→ Install Node.js (see Step 1 above)

### "Account not found"
→ Run `npm run account:add <name>` first

### Videos timing out
→ Edit `src/config.js`, increase `VIDEO_GENERATION_TIMEOUT` to `120000`

### Need help?
→ Check [EXAMPLES.md](./EXAMPLES.md) for more examples and troubleshooting tips

---

**You're ready to go!** Start with `--count 5` to test, then scale up to `--count 100` for production runs.
