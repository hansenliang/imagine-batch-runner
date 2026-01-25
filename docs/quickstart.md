# Quick Start Guide

## Prerequisites

**Node.js** (v18 or higher):
```bash
# macOS with Homebrew
brew install node

# Or download from https://nodejs.org/ (LTS version)
```

Verify installation:
```bash
node --version   # Should show v18.x or higher
npm --version    # Should show v9.x or higher
```

## Installation

```bash
cd "/Users/hansenliang/Projects/Imagine batch runner"
npm install
npx playwright install chromium
```

Verify setup:
```bash
npm test
```

Expected output:
```
✓ All imports successful
✓ Config loaded: {...}
✓ Selectors loaded: 10 selectors
✅ Code structure is valid!
```

## First Run

### 1. Add Your Grok Account

```bash
npm start accounts add my-account
```

A browser will open. Log in to Grok, then **close the browser** when done.

### 2. Generate Videos

```bash
npm start run start \
  --account my-account \
  --permalink "https://grok.com/imagine/post/YOUR_POST_ID" \
  --prompt "camera slowly zooms in on the subject" \
  --count 5
```

Or use a config file:
```bash
node src/cli.js run start --config batch-config.json
```

### 3. View Results

Videos appear in the Grok UI at your permalink. Open it in a browser to download them.

## Common Issues

| Problem | Solution |
|---------|----------|
| `npm not found` | Install Node.js (see Prerequisites) |
| `Account not found` | Run `npm start accounts add <name>` first |
| Videos timing out | Increase `VIDEO_GENERATION_TIMEOUT` in `src/config.js` |
| Rate limited | Wait ~3 hours, then rerun with same config |
| Session expired | Re-run `npm start accounts add <name>` to re-login |
