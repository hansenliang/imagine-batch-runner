# Usage Examples

## Complete Workflow Example

### Step 1: Setup Your First Account

```bash
npm start accounts add primary-account
```

A Chrome window will open. Log in to Grok (x.com), navigate to Grok Imagine if needed, then close the browser.

### Step 2: Run Your First Batch

Generate 10 videos from a Grok image permalink:

```bash
npm start run start \
  --account primary-account \
  --permalink "https://grok.com/imagine/post/060ec750-c502-4fb2-9de0-562bdd2e599e" \
  --prompt "camera pans into a detail of the dandelions softly moving in the wind" \
  --count 10 \
  --job-name "dandelion-test"
```

Output:
```
🚀 Starting batch run...

Account: primary-account
Permalink: https://grok.com/imagine/post/060ec750-c502-4fb2-9de0-562bdd2e599e
Batch size: 10

[12:34:56] INFO: Initializing batch runner
[12:34:57] SUCCESS: Run initialized
[12:34:58] INFO: Navigating to permalink
[12:35:02] SUCCESS: Permalink loaded and validated
[12:35:05] INFO: [Video 1] Starting generation
[12:35:27] SUCCESS: [Video 1] Generation completed
[████████████████████] 1/10 (10%) Generating video 2...
...
```

### Step 3: Handle Rate Limiting

If the run stops due to rate limiting:

```
[12:45:30] WARN: Rate limit detected, stopping new work

📊 Run Summary:

  ✓ Completed: 8/10
  ✗ Failed: 0
  Status: STOPPED_RATE_LIMIT
  Stop reason: Rate limit detected - try again later
```

Wait for the rate limit to reset (typically 4 hours), then rerun with the same config or flags.

## Advanced Examples

### Large Batch (100 videos)

```bash
npm start run start \
  --account primary-account \
  --permalink "https://grok.com/imagine/post/YOUR_POST_ID" \
  --prompt "slow zoom on the subject with cinematic lighting" \
  --count 100 \
  --job-name "large-batch-001"
```

### Multiple Accounts in Parallel

**Terminal 1:**
```bash
npm start run start \
  --account account1 \
  --permalink "https://grok.com/imagine/post/POST_ID" \
  --prompt "dramatic camera movement" \
  --count 50
```

**Terminal 2:**
```bash
npm start run start \
  --account account2 \
  --permalink "https://grok.com/imagine/post/POST_ID" \
  --prompt "dramatic camera movement" \
  --count 50
```

This way you can generate 100 videos using two accounts' quotas.

### Different Prompts, Same Image

To generate variations with different prompts, run multiple jobs:

```bash
# Job 1: Zoom effect
npm start run start \
  --account primary-account \
  --permalink "https://grok.com/imagine/post/POST_ID" \
  --prompt "slow zoom in on the subject" \
  --count 20 \
  --job-name "zoom-variations"

# Job 2: Pan effect
npm start run start \
  --account primary-account \
  --permalink "https://grok.com/imagine/post/POST_ID" \
  --prompt "camera pans left to right" \
  --count 20 \
  --job-name "pan-variations"
```

## Viewing Your Generated Videos

Videos are generated in the Grok UI but not auto-downloaded. To view them:

1. Open the permalink in your browser
2. Click through the generated videos in the UI
3. Download manually by clicking the download button on each video

**Future Enhancement:** Auto-download will be added in a future version.

## Tips & Best Practices

### Finding Good Prompts

Effective video generation prompts:
- `"camera slowly zooms in on [subject]"`
- `"camera pans from left to right"`
- `"subtle movement in [element], rest stays still"`
- `"cinematic dolly zoom effect"`
- `"camera orbits around [subject]"`

### Optimal Batch Sizes

- **Testing**: Start with `--count 5` to verify the permalink works
- **Production**: Use `--count 50` or `--count 100` for full runs
- **Rate limit aware**: If you hit limits often, use smaller batches

### Managing Multiple Accounts

```bash
# Setup all accounts first
npm start accounts add work-account
npm start accounts add personal-account
npm start accounts add test-account

# List to verify
npm start accounts list
```

### Checking Runs

Each run writes a `run.log` under `./logs/<job-name>/` for progress and debugging.

## Troubleshooting Common Issues

### Issue: "Account not found"

**Solution:**
```bash
npm start accounts add your-account
```

### Issue: Videos timing out

**Edit `src/config.js`:**
```javascript
VIDEO_GENERATION_TIMEOUT: 120000  // Increase to 2 minutes
```

### Issue: Too many failures

Check the run log:
```bash
cat ./logs/your-job/run.log
```

Review error messages to see what went wrong.

### Issue: Session expired mid-run

**Re-authenticate:**
```bash
npm start accounts add your-account  # Re-login
npm start run start --config batch-config.json  # Rerun later
```
