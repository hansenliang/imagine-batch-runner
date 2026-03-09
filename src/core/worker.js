import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import config, { selectors } from '../config.js';
import { VideoGenerator } from './generator.js';

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Worker - handles video generation in a dedicated browser context
 * Each worker runs independently with its own profile copy
 */
export class ParallelWorker {
  constructor(workerId, accountAlias, permalink, prompt, manifest, logger, cacheDir, options = {}) {
    this.workerId = workerId;
    this.accountAlias = accountAlias;
    this.permalink = permalink;
    this.prompt = prompt;
    this.manifest = manifest;
    this.logger = logger;
    this.cacheDir = cacheDir;

    // Download/delete/upscale options
    this.autoDownload = options.autoDownload || false;
    this.autoUpscale = options.autoUpscale || false;
    this.autoDelete = options.autoDelete || false;
    this.downloadDir = options.downloadDir || null;
    this.jobName = options.jobName || null;
    this.downloadAndDeleteRemainingVideos = options.downloadAndDeleteRemainingVideos || false;

    // Video settings selection (opt-in)
    this.selectMaxDuration = options.selectMaxDuration || false;
    this.selectMaxResolution = options.selectMaxResolution || false;

    // Extend settings
    this.maxExtendMode = options.maxExtendMode || false;
    // maxExtendMode implies autoExtend
    this.autoExtend = this.maxExtendMode ? true : (options.autoExtend || false);

    // Browser resources
    this.context = null;
    this.page = null;
    this.generator = null;
    this.postProcessor = null;

    // Worker-specific paths (in cacheDir for ephemeral data)
    this.workerProfileDir = path.join(cacheDir, 'worker-profiles', `worker-${workerId}`);

    // State
    this.isRunning = false;
    this.shouldStop = false;
    this.selectedDuration = null; // Track selected video duration for logging
    this.selectedResolution = null; // Track selected video resolution for logging
  }

  /**
   * Initialize worker: create profile copy and launch browser context
   */
  async initialize() {
    try {
      // Create worker profile directory
      await fs.mkdir(this.workerProfileDir, { recursive: true });

      // Copy account profile to worker-specific directory
      const sourceProfileDir = path.join(config.PROFILES_DIR, `${this.accountAlias}-chrome`);

      try {
        await fs.access(sourceProfileDir);
        await fs.cp(sourceProfileDir, this.workerProfileDir, {
          recursive: true,
          force: true
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          // Profile will be created by Playwright
        } else {
          throw error;
        }
      }

      // Launch persistent context with worker-specific profile
      const chromeProfileName = config.CHROME_PROFILE_NAME || 'Default';
      const launchArgs = [
        '--disable-blink-features=AutomationControlled',
        `--profile-directory=${chromeProfileName}`,
      ];

      this.context = await chromium.launchPersistentContext(this.workerProfileDir, {
        channel: 'chrome',
        headless: !config.HEADED_MODE,
        viewport: config.VIEWPORT,
        args: launchArgs,
      });

      // Get or create page
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.page.setDefaultTimeout(config.ELEMENT_WAIT_TIMEOUT);
      this.page.setDefaultNavigationTimeout(config.PAGE_LOAD_TIMEOUT);

      // Navigate to permalink once
      await this.page.goto(this.permalink, {
        waitUntil: 'domcontentloaded',
        timeout: config.PAGE_LOAD_TIMEOUT,
      });
      await sleep(3000);
      await this._waitForReadyUI();

      // Check authentication
      const authenticated = await this._isAuthenticated();
      if (!authenticated) {
        throw new Error('AUTH_REQUIRED: Not authenticated. Worker cannot proceed.');
      }

      // Switch to video mode if on an image page (Settings → Make Video)
      await this._selectVideoMode();

      // Select maximum video duration and resolution (once per worker session, if enabled)
      if (this.selectMaxDuration) {
        await this._selectMaxDuration();
      }
      if (this.selectMaxResolution) {
        await this._selectMaxResolution();
      }

      // Create video generator
      this.generator = new VideoGenerator(this.page, this.logger);

      // Create post-processor if download/upscale/delete enabled, or if cleanup is enabled
      if (this.autoDownload || this.downloadAndDeleteRemainingVideos) {
        const { PostProcessor } = await import('./post-processor.js');
        this.postProcessor = new PostProcessor(this.page, this.logger, {
          autoDownload: this.autoDownload || this.downloadAndDeleteRemainingVideos,
          autoUpscale: this.autoUpscale,
          autoDelete: this.autoDelete || this.downloadAndDeleteRemainingVideos,
          downloadDir: this.downloadDir,
          jobName: this.jobName,
        });
      }

      this.logger.success(`[Worker ${this.workerId}] Ready`);
    } catch (error) {
      this.logger.error(`[Worker ${this.workerId}] Initialization failed`, error);
      await this.shutdown();
      throw error;
    }
  }

  /**
   * Check if user is authenticated
   * @private
   */
  async _isAuthenticated() {
    try {
      // Look for login button - if present, not authenticated
      const loginButton = await this.page.$('button:has-text("Log in"), button:has-text("Sign in")');
      return !loginButton;
    } catch {
      return false;
    }
  }

  /**
   * Wait for page UI to be ready for generation.
   * @private
   */
  async _waitForReadyUI() {
    try {
      const timeout = Math.max(5000, config.ELEMENT_WAIT_TIMEOUT);
      await Promise.race([
        this.page.waitForSelector(selectors.PROMPT_INPUT, { timeout }),
        this.page.waitForSelector(selectors.MAKE_VIDEO_BUTTON, { timeout }),
        this.page.waitForSelector(selectors.REDO_BUTTON, { timeout }),
      ]);
      await sleep(500);
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] UI readiness check timed out: ${error.message}`);
    }
  }

  /**
   * Wait for a video element with a src to be loaded on the page.
   * Used after navigating back to a checkpoint permalink during extend retries —
   * the "Extend video" menu option only appears when a video is present.
   * @private
   */
  async _waitForVideoLoaded() {
    try {
      const timeout = Math.max(10000, config.ELEMENT_WAIT_TIMEOUT);
      await this.page.waitForFunction(
        (sel) => {
          const videos = document.querySelectorAll(sel);
          return [...videos].some(v => !!(v.currentSrc || v.src));
        },
        selectors.VIDEO_CONTAINER,
        { timeout }
      );
      this.logger.debug(`[Worker ${this.workerId}] Video loaded on checkpoint page`);
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] Video load wait timed out: ${error.message}`);
    }
  }

  /**
   * Switch from image mode to video mode if a Settings button is present.
   * On Grok Imagine image pages, a "Settings" gear button opens a menu
   * with a "Make Video" option to switch to video generation mode.
   * If the Settings button is not found (already in video mode), this is a no-op.
   * @private
   */
  async _selectVideoMode() {
    try {
      // If any video element already has a src (e.g. from a previous run), we're already
      // in video mode. Skip the Settings interaction to avoid triggering SPA navigation.
      // Handles dual sd-video/hd-video elements (see claude.md "Dual video elements").
      const hasExistingVideo = await this.page.$$eval(selectors.VIDEO_CONTAINER,
        videos => videos.some(v => !!(v.currentSrc || v.src))
      ).catch(() => false);
      if (hasExistingVideo) {
        this.logger.debug(`[Worker ${this.workerId}] Video already present, skipping mode selection`);
        return;
      }

      const settingsButton = await this.page.$(selectors.SETTINGS_BUTTON);
      if (!settingsButton) {
        this.logger.debug(`[Worker ${this.workerId}] No Settings button found, assuming video mode`);
        return;
      }

      const isVisible = await settingsButton.isVisible().catch(() => false);
      if (!isVisible) {
        this.logger.debug(`[Worker ${this.workerId}] Settings button not visible, assuming video mode`);
        return;
      }

      // Click Settings to open the mode menu
      await settingsButton.click();
      await sleep(config.UI_ACTION_DELAY);

      // Look for "Make Video" menu item
      let makeVideoItem = await this.page.$(selectors.MAKE_VIDEO_MODE_ITEM);

      // Fallback: scan menu items for "Make Video" text
      if (!makeVideoItem) {
        const menuItems = await this.page.$$('[role="menuitem"]');
        for (const item of menuItems) {
          const itemVisible = await item.isVisible().catch(() => false);
          if (!itemVisible) continue;
          const text = await item.innerText().catch(() => '');
          if (/make\s+video/i.test(text)) {
            makeVideoItem = item;
            break;
          }
        }
      }

      if (!makeVideoItem) {
        this.logger.debug(`[Worker ${this.workerId}] "Make Video" menu item not found, closing menu`);
        await this.page.keyboard.press('Escape');
        return;
      }

      const itemVisible = await makeVideoItem.isVisible().catch(() => false);
      if (!itemVisible) {
        this.logger.debug(`[Worker ${this.workerId}] "Make Video" menu item not visible, closing menu`);
        await this.page.keyboard.press('Escape');
        return;
      }

      await makeVideoItem.click();
      await sleep(config.UI_ACTION_DELAY);

      this.logger.info(`[Worker ${this.workerId}] Switched to video mode via Settings → Make Video`);
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] Video mode selection failed: ${error.message}`);
      try { await this.page.keyboard.press('Escape'); } catch { /* ignore */ }
    }
  }

  /**
   * Select the maximum available video duration.
   * New UI: duration pills appear inline below the prompt when it's focused.
   * Accepts an optional regex pattern to match different duration formats:
   *   - Regular mode: /^\d+s$/ matches "6s", "10s"
   *   - Extend mode: /^\+?\d+s$/ matches "+6s", "+10s", "6s", "10s"
   * @param {RegExp} [pattern] - Optional regex for duration label matching
   * @private
   */
  async _selectMaxDuration(pattern = null) {
    const durationPattern = pattern || /^\d+s$/;
    try {
      // Focus prompt input to reveal inline duration/resolution pills (new UI)
      const promptInput = await this.page.$(selectors.PROMPT_INPUT);
      if (promptInput) {
        await promptInput.click();
        await sleep(config.UI_ACTION_DELAY);
      }

      // Find all visible buttons matching the duration pattern
      const buttons = await this.page.$$('button');
      const durationButtons = [];

      for (const button of buttons) {
        const isVisible = await button.isVisible().catch(() => false);
        if (!isVisible) continue;

        const ariaLabel = await button.getAttribute('aria-label').catch(() => '');
        const text = await button.innerText().catch(() => '');
        const label = (ariaLabel || text).trim();

        if (durationPattern.test(label)) {
          // Extract numeric part (e.g., "10" from "10s" or "+10s")
          const numericPart = parseInt(label.replace(/[^\d]/g, ''), 10);
          durationButtons.push({
            button,
            duration: numericPart,
            label,
          });
        }
      }

      if (durationButtons.length === 0) {
        this.logger.warn(`[Worker ${this.workerId}] No duration buttons found (pattern: ${durationPattern}), using default`);
        return;
      }

      // Find and click the maximum duration
      const maxDuration = durationButtons.reduce((max, curr) =>
        curr.duration > max.duration ? curr : max
      );

      await maxDuration.button.click();
      await sleep(config.UI_ACTION_DELAY);

      this.selectedDuration = maxDuration.label;
      this.logger.info(`[Worker ${this.workerId}] Selected video duration: ${this.selectedDuration}`);
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] Duration selection failed: ${error.message}, using default`);
      this.selectedDuration = null;
    }
  }

  /**
   * Select the maximum available video resolution.
   * New UI: resolution pills appear inline below the prompt when it's focused.
   * @private
   */
  async _selectMaxResolution() {
    try {
      // Focus prompt input to reveal inline duration/resolution pills (new UI)
      const promptInput = await this.page.$(selectors.PROMPT_INPUT);
      if (promptInput) {
        await promptInput.click();
        await sleep(config.UI_ACTION_DELAY);
      }

      // Find all visible buttons matching resolution pattern (e.g., "480p", "720p")
      const buttons = await this.page.$$('button');
      const resolutionButtons = [];

      for (const button of buttons) {
        const isVisible = await button.isVisible().catch(() => false);
        if (!isVisible) continue;

        const ariaLabel = await button.getAttribute('aria-label').catch(() => '');
        const text = await button.innerText().catch(() => '');
        const label = (ariaLabel || text).trim();

        const match = label.match(/^(\d+)p$/);
        if (match) {
          resolutionButtons.push({
            button,
            resolution: parseInt(match[1], 10),
            label,
          });
        }
      }

      if (resolutionButtons.length === 0) {
        this.logger.warn(`[Worker ${this.workerId}] No resolution buttons found, using default resolution`);
        return;
      }

      // Find and click the maximum resolution
      const maxResolution = resolutionButtons.reduce((max, curr) =>
        curr.resolution > max.resolution ? curr : max
      );

      await maxResolution.button.click();
      await sleep(config.UI_ACTION_DELAY);

      this.selectedResolution = `${maxResolution.resolution}p`;
      this.logger.info(`[Worker ${this.workerId}] Selected video resolution: ${this.selectedResolution}`);
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] Resolution selection failed: ${error.message}, using default`);
      this.selectedResolution = null;
    }
  }

  /**
   * Run worker loop: claim work, generate/extend videos, repeat until no work.
   *
   * Two modes controlled by this.maxExtendMode:
   *   - false (default): Generate a new video, then optionally extend to 30s
   *   - true: Navigate to existing permalink, extend to 30s (no generation)
   *
   * When autoExtend is enabled, videos are extended to max duration (30s).
   * Auto-delete only runs if the video reached 30s; partial extensions are
   * preserved on the server for future continuation.
   */
  async run() {
    this.isRunning = true;
    let stoppedEarly = false;

    try {
      while (!this.shouldStop) {
        // Claim next item atomically
        const item = await this.manifest.claimNextItem(this.workerId);

        if (!item) {
          this.logger.info(`[Worker ${this.workerId}] No more work available, exiting`);
          break;
        }

        const index = item.index;

        // Check if we should stop BEFORE starting new work
        if (this.shouldStop) {
          this.logger.info(`[Worker ${this.workerId}] Stop signal received, releasing unclaimed item ${index + 1}`);
          await this.manifest.updateItemAtomic(
            index,
            { status: 'PENDING' },
            this.workerId
          );
          stoppedEarly = true;
          break;
        }

        // ── Step 1: Get a video to work with ──────────────────────────
        let generationOk = false;

        if (this.maxExtendMode) {
          // Max-extend: navigate to existing permalink, verify video
          this.logger.info(`[Worker ${this.workerId}] Chain ${index + 1}: navigating to source video`);
          await this.page.goto(this.permalink, {
            waitUntil: 'domcontentloaded',
            timeout: config.PAGE_LOAD_TIMEOUT,
          });
          await sleep(3000);
          await this._waitForReadyUI();
          await this._waitForVideoLoaded();

          const initialDuration = await this._getVideoDuration();
          if (initialDuration <= 0) {
            this.logger.error(`[Worker ${this.workerId}] Chain ${index + 1}: No video found at permalink`);
            await this.manifest.updateItemAtomic(
              index,
              { status: 'FAILED', error: 'No video found at permalink', attempts: 0 },
              this.workerId
            );
            await sleep(2000);
            continue;
          }

          if (initialDuration >= config.MAX_VIDEO_DURATION) {
            this.logger.warn(
              `[Worker ${this.workerId}] Chain ${index + 1}: Video already at max duration (${initialDuration.toFixed(1)}s), skipping`
            );
            await this.manifest.updateItemAtomic(
              index,
              { status: 'COMPLETED', error: 'Already at max duration', attempts: 0 },
              this.workerId
            );
            await sleep(2000);
            continue;
          }

          this.logger.info(
            `[Worker ${this.workerId}] Chain ${index + 1}: Source video is ${initialDuration.toFixed(1)}s, extending to ${config.MAX_VIDEO_DURATION}s`
          );
          generationOk = true;

        } else {
          // Normal mode: generate a new video
          this.logger.info(`[Worker ${this.workerId}] Attempting generation ${index + 1}`);
          await this._ensureOnPermalink();

          const result = await this.generator.generate(index, this.prompt);
          const duration = Math.round((result.durationMs || 0) / 1000);

          if (result.rateLimited) {
            this.logger.warn(`[Worker ${this.workerId}] Rate limit detected during attempt ${index + 1}`);
            await this.manifest.updateItemAtomic(
              index,
              { status: 'RATE_LIMITED', error: result.error, attempts: 0 },
              this.workerId
            );
            throw new Error('RATE_LIMIT_STOP');
          }

          if (result.success) {
            await this.manifest.updateItemAtomic(
              index,
              { status: 'COMPLETED', attempts: result.attempted ? 1 : 0 },
              this.workerId
            );
            if (result.abTestDetected) {
              await this.manifest.incrementCounterAtomic('abTestCount');
            }
            const effectiveResolution = result.actualResolution || this.selectedResolution;
            const settingsInfo = [this.selectedDuration, effectiveResolution].filter(Boolean).join(', ');
            const settingsSuffix = settingsInfo ? ` (${settingsInfo})` : '';
            this.logger.success(
              `[Worker ${this.workerId}] Attempt ${index + 1}: Success in ${duration}s${settingsSuffix} - ${this.page.url()}`
            );
            generationOk = true;
          } else if (result.contentModerated) {
            await this.manifest.updateItemAtomic(
              index,
              { status: 'CONTENT_MODERATED', error: result.error, attempts: 1 },
              this.workerId
            );
          } else {
            await this.manifest.updateItemAtomic(
              index,
              { status: 'FAILED', error: result.error, attempts: result.attempted ? 1 : 0 },
              this.workerId
            );
            this.logger.error(
              `[Worker ${this.workerId}] Attempt ${index + 1}: Failed - ${result.error || 'Unknown error'}`
            );
          }
        }

        // ── Step 2: Extend to max duration (if enabled and we have a video) ──
        if (generationOk && this.autoExtend) {
          const extResult = await this._runExtendLoop(this.page.url(), index);

          if (extResult.rateLimited) {
            // In max-extend mode, rate limit on extend is fatal (nothing else to do)
            if (this.maxExtendMode && extResult.successfulExtends === 0) {
              this.logger.warn(`[Worker ${this.workerId}] Rate limit during extend chain ${index + 1}`);
              await this.manifest.updateItemAtomic(
                index,
                { status: 'RATE_LIMITED', error: 'Rate limited during extension', attempts: 0 },
                this.workerId
              );
              throw new Error('RATE_LIMIT_STOP');
            }
          }

          // In max-extend mode with zero successful extends, skip post-processing
          // to protect the original video
          if (this.maxExtendMode && extResult.successfulExtends === 0) {
            this.logger.warn(
              `[Worker ${this.workerId}] Chain ${index + 1}: No extensions succeeded, original video untouched`
            );
            await this.manifest.updateItemAtomic(
              index,
              { status: 'FAILED', error: 'All extension attempts failed', attempts: 0 },
              this.workerId
            );
            generationOk = false; // Skip post-processing
          }
        }

        // ── Step 3: Post-processing (download / upscale / delete) ──────
        if (generationOk) {
          // Only auto-delete if video reached max duration; partial extensions
          // are preserved on server for future continuation
          const savedAutoDelete = this.autoDelete;
          if (this.autoExtend && this.autoDelete) {
            const finalDuration = await this._getVideoDuration();
            if (finalDuration < config.MAX_VIDEO_DURATION) {
              this.autoDelete = false;
              this.logger.info(
                `[Worker ${this.workerId}] Skipping delete — video is ${finalDuration.toFixed(1)}s (< ${config.MAX_VIDEO_DURATION}s), can be extended further`
              );
            }
          }
          await this._runPostProcessing(index);
          this.autoDelete = savedAutoDelete;
        }

        // Check if we should stop AFTER completing work
        if (this.shouldStop) {
          this.logger.info(`[Worker ${this.workerId}] Stop signal received, exiting after attempt ${index + 1}`);
          stoppedEarly = true;
          break;
        }

        // Small delay between items
        await sleep(2000);
      }

      if (!stoppedEarly) {
        this.logger.info(`[Worker ${this.workerId}] Work loop completed`);
      }
    } catch (error) {
      if (error.message === 'RATE_LIMIT_STOP') {
        throw error; // Propagate to coordinator
      }
      this.logger.error(`[Worker ${this.workerId}] Fatal error in work loop`, error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get the duration (in seconds) of the currently visible video on the page.
   * Checks both SD and HD video elements, returning the first with a valid duration.
   * @private
   * @returns {Promise<number>} Duration in seconds, or 0 if not available
   */
  async _getVideoDuration() {
    try {
      return await this.page.evaluate((sel) => {
        const videos = document.querySelectorAll(sel);
        for (const v of videos) {
          if ((v.currentSrc || v.src) && v.duration > 0) return v.duration;
        }
        return 0;
      }, selectors.VIDEO_CONTAINER);
    } catch {
      return 0;
    }
  }

  /**
   * Extend loop: extends the video at checkpointUrl until it reaches max duration (30s).
   * Retries on content moderation/failures (up to 100 consecutive).
   * Used by both normal generation (autoExtend) and max-extend mode.
   *
   * @param {string} startCheckpointUrl - URL of the video to start extending from
   * @param {number} index - Manifest item index for logging/counters
   * @returns {Promise<{successfulExtends: number, rateLimited: boolean, checkpointUrl: string}>}
   * @private
   */
  async _runExtendLoop(startCheckpointUrl, index) {
    let successfulExtends = 0;
    let failedAttempts = 0;
    const maxFailedAttempts = 100;
    let checkpointUrl = startCheckpointUrl;
    let rateLimitedOnExtend = false;
    const targetDuration = config.MAX_VIDEO_DURATION;

    while (failedAttempts < maxFailedAttempts && !rateLimitedOnExtend) {
      this.logger.info(
        `[Worker ${this.workerId}] Extend ${successfulExtends + 1} (failures: ${failedAttempts})`
      );

      // Navigate back to checkpoint if we're not on the checkpoint page.
      // After a failed extension we may be on the extension's /post/ URL (no video)
      // or redirected to /imagine. Either way, go back to the checkpoint which has
      // the completed video needed for "Extend video" to appear in the Settings menu.
      const currentUrl = this.page.url();
      if (currentUrl !== checkpointUrl) {
        this.logger.info(`[Worker ${this.workerId}] Navigating to checkpoint ${checkpointUrl}`);
        await this.page.goto(checkpointUrl, {
          waitUntil: 'domcontentloaded',
          timeout: config.PAGE_LOAD_TIMEOUT,
        });
        await sleep(3000);
        await this._waitForReadyUI();
        await this._waitForVideoLoaded();
        // Grok may redirect stale/image permalinks to the latest video's permalink.
        // Accept whatever /post/ URL we land on as the new checkpoint.
        const landedUrl = this.page.url();
        if (landedUrl.includes('/imagine/post/') && landedUrl !== checkpointUrl) {
          this.logger.info(`[Worker ${this.workerId}] Checkpoint redirected to ${landedUrl}`);
          checkpointUrl = landedUrl;
        }
      }

      // Step 1: Trigger extend mode via Settings menu → "Extend video"
      const triggered = await this.generator.triggerExtendMode(index);
      if (!triggered) {
        this.logger.warn(`[Worker ${this.workerId}] Could not trigger extend mode, stopping extends`);
        break;
      }

      // Step 2: Select max extend duration (+10s pills)
      await this._selectMaxDuration(/^\+?\d+s$/);

      // Step 3: Inner retry loop — generate the extension, retrying on content
      // moderation (just hit generate again, like normal moderation retries).
      // Break back to outer loop on success, rate limit, or unrecoverable error.
      while (failedAttempts < maxFailedAttempts) {
        const extResult = await this.generator.generate(index, this.prompt);
        const extDuration = Math.round((extResult.durationMs || 0) / 1000);

        if (extResult.success) {
          successfulExtends++;
          failedAttempts = 0; // Reset on success
          checkpointUrl = this.page.url(); // Advance checkpoint
          await this.manifest.incrementCounterAtomic('extendedCount');

          const videoDur = await this._getVideoDuration();
          this.logger.success(
            `[Worker ${this.workerId}] Extend ${successfulExtends} succeeded in ${extDuration}s — video now ${videoDur.toFixed(1)}s / ${targetDuration}s`
          );
          if (videoDur >= targetDuration) {
            this.logger.success(
              `[Worker ${this.workerId}] Reached target duration ${videoDur.toFixed(1)}s`
            );
            break; // → exit outer loop
          }
          break; // → outer loop continues for next extension
        } else if (extResult.rateLimited) {
          await this.manifest.incrementCounterAtomic('extendAttemptCount');
          this.logger.warn(`[Worker ${this.workerId}] Rate limit during extend, moving on`);
          rateLimitedOnExtend = true;
          break; // → outer loop exits via flag
        } else if (extResult.contentModerated) {
          failedAttempts++;
          await this.manifest.incrementCounterAtomic('extendAttemptCount');
          this.logger.warn(
            `[Worker ${this.workerId}] Extend content moderated (${failedAttempts}/${maxFailedAttempts}), retrying...`
          );

          // Cooldown before retry to let stale moderation messages clear
          await sleep(config.MODERATION_RETRY_COOLDOWN);

          // If page drifted away from /post/, break to outer loop which will
          // navigate back to checkpoint and re-trigger extend mode.
          if (!this.page.url().includes('/imagine/post/')) {
            this.logger.warn(
              `[Worker ${this.workerId}] Page drifted to ${this.page.url()} after moderation, will re-navigate to checkpoint`
            );
            break; // → outer loop handles recovery
          }
          // Still on a /post/ page — retry generate directly (UI still in extend mode)
          continue;
        } else {
          failedAttempts++;
          await this.manifest.incrementCounterAtomic('extendAttemptCount');
          this.logger.warn(
            `[Worker ${this.workerId}] Extend failed (${failedAttempts}/${maxFailedAttempts}): ${extResult.error}, retrying...`
          );
          // Break to outer loop for recovery (navigate to checkpoint, re-trigger extend)
          break;
        }
      }

      // Re-check duration after inner loop (break from inner goes here)
      const dur = await this._getVideoDuration();
      if (dur >= targetDuration) break;
    }

    if (successfulExtends > 0) {
      this.logger.info(
        `[Worker ${this.workerId}] Extend complete: ${successfulExtends} successful extensions`
      );
    } else if (failedAttempts >= maxFailedAttempts) {
      this.logger.warn(
        `[Worker ${this.workerId}] Extend exhausted ${maxFailedAttempts} retries with no success`
      );
    }

    return { successfulExtends, rateLimited: rateLimitedOnExtend, checkpointUrl };
  }

  /**
   * Post-processing: download, upscale, and/or delete the current video.
   * @param {number} index - Manifest item index
   * @private
   */
  async _runPostProcessing(index) {
    if (!this.postProcessor) return;

    const postResult = await this.postProcessor.process(index);

    // Update manifest with download results
    if (postResult.downloaded) {
      await this.manifest.incrementCounterAtomic('downloadedCount');
      await this.manifest.updateItemAtomic(index, {
        downloaded: true,
        downloadPath: postResult.downloadPath,
      }, this.workerId);
      this.logger.success(
        `[Worker ${this.workerId}] Attempt ${index + 1}: Downloaded to ${postResult.downloadPath} (${postResult.fileSize})`
      );
    } else if (this.autoDownload) {
      await this.manifest.incrementCounterAtomic('downloadFailedCount');
      this.logger.warn(
        `[Worker ${this.workerId}] Attempt ${index + 1}: Download failed - ${postResult.downloadError}`
      );
    }

    // Update manifest with upscale results
    if (postResult.upscaled) {
      await this.manifest.incrementCounterAtomic('upscaledCount');
      await this.manifest.updateItemAtomic(index, {
        upscaled: true,
        upscaleDownloadPath: postResult.upscaleDownloadPath,
      }, this.workerId);
      this.logger.success(
        `[Worker ${this.workerId}] Attempt ${index + 1}: Upscaled and downloaded HD to ${postResult.upscaleDownloadPath} (${postResult.upscaleFileSize})`
      );
    } else if (this.autoUpscale && postResult.downloaded) {
      await this.manifest.incrementCounterAtomic('upscaleFailedCount');
      this.logger.warn(
        `[Worker ${this.workerId}] Attempt ${index + 1}: Upscale failed - ${postResult.upscaleError}`
      );
    }

    // Update manifest with delete results
    if (postResult.deleted) {
      await this.manifest.incrementCounterAtomic('deletedCount');
      await this.manifest.updateItemAtomic(index, { deleted: true }, this.workerId);
      this.logger.success(
        `[Worker ${this.workerId}] Attempt ${index + 1}: Deleted from server`
      );
    } else if (this.autoDelete && postResult.downloaded) {
      // Only log delete failure if it wasn't skipped due to upscale failure
      if (!this.autoUpscale || postResult.upscaled) {
        await this.manifest.incrementCounterAtomic('deleteFailedCount');
        this.logger.warn(
          `[Worker ${this.workerId}] Attempt ${index + 1}: Delete failed - ${postResult.deleteError}`
        );
      } else {
        this.logger.info(
          `[Worker ${this.workerId}] Attempt ${index + 1}: Delete skipped - upscale failed`
        );
      }
    }
  }

  /**
   * Verify the page is still on the expected permalink, re-navigate if not.
   * @private
   */
  async _ensureOnPermalink() {
    try {
      const currentUrl = this.page.url();
      // The SPA routes to a new /imagine/post/<uuid> on every generation start.
      // That's expected — stay on whatever post page we're on. Only re-navigate
      // if we've left Imagine post pages entirely (e.g. "post not found" redirect
      // to /imagine home).
      if (currentUrl.includes('/imagine/post/')) {
        return;
      }
      this.logger.warn(`[Worker ${this.workerId}] Page drifted to ${currentUrl}, re-navigating to permalink`);
      await this.page.goto(this.permalink, {
        waitUntil: 'domcontentloaded',
        timeout: config.PAGE_LOAD_TIMEOUT,
      });
      await sleep(3000);
      await this._waitForReadyUI();
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] _ensureOnPermalink failed: ${error.message}`);
    }
  }

  /**
   * Signal worker to stop
   */
  stop() {
    if (!this.shouldStop) {
      this.logger.info(`[Worker ${this.workerId}] Stop signal received`);
      this.shouldStop = true;
    }
  }

  /**
   * Cleanup remaining videos on the server
   * Called after generation completes to download and delete any leftover videos
   * @returns {Promise<{downloaded: number, deleted: number, failed: number}>}
   */
  async cleanupRemainingVideos() {
    if (!this.downloadAndDeleteRemainingVideos) {
      return { downloaded: 0, deleted: 0, failed: 0 };
    }

    if (!this.postProcessor) {
      this.logger.warn(`[Worker ${this.workerId}] Cannot cleanup - no PostProcessor available`);
      return { downloaded: 0, deleted: 0, failed: 0 };
    }

    if (!this.page || !this.context) {
      this.logger.warn(`[Worker ${this.workerId}] Cannot cleanup - browser context not available`);
      return { downloaded: 0, deleted: 0, failed: 0 };
    }

    this.logger.info(`[Worker ${this.workerId}] Starting cleanup of remaining videos...`);

    const stats = { downloaded: 0, deleted: 0, failed: 0 };
    let cleanupIndex = 0;

    while (true) {
      // Detect remaining videos
      const remaining = await this._detectRemainingVideos();

      if (remaining.count === 0) {
        this.logger.info(`[Worker ${this.workerId}] No more videos to cleanup`);
        break;
      }

      this.logger.info(`[Worker ${this.workerId}] ${remaining.count} video(s) remaining, processing...`);

      // Navigate to the last video if there are multiple
      if (remaining.count > 1) {
        const clicked = await this._clickLastThumbnail();
        if (!clicked) {
          this.logger.warn(`[Worker ${this.workerId}] Failed to click last thumbnail, stopping cleanup`);
          stats.failed++;
          break;
        }
        // Wait for video to load after navigation
        await this._waitForVideoLoad();
      }

      // Process this video (download, upscale if needed, delete)
      const result = await this.postProcessor.processExistingVideo(cleanupIndex);

      if (result.downloaded) {
        stats.downloaded++;
        await this.manifest.incrementCounterAtomic('cleanupDownloadedCount');
        this.logger.success(
          `[Worker ${this.workerId}] Cleanup ${cleanupIndex + 1}: Downloaded ${result.downloadPath} (${result.fileSize})`
        );
      }

      if (result.deleted) {
        stats.deleted++;
        await this.manifest.incrementCounterAtomic('cleanupDeletedCount');
        this.logger.success(`[Worker ${this.workerId}] Cleanup ${cleanupIndex + 1}: Deleted from server`);
      } else {
        // Delete failed - stop to avoid infinite loop
        stats.failed++;
        await this.manifest.incrementCounterAtomic('cleanupFailedCount');
        this.logger.error(
          `[Worker ${this.workerId}] Cleanup ${cleanupIndex + 1}: Delete failed - ${result.deleteError}, stopping cleanup`
        );
        break;
      }

      cleanupIndex++;

      // Small delay between cleanups
      await sleep(1000);
    }

    this.logger.info(
      `[Worker ${this.workerId}] Cleanup complete: ${stats.downloaded} downloaded, ${stats.deleted} deleted, ${stats.failed} failed`
    );

    return stats;
  }

  /**
   * Get all visible thumbnail buttons
   * @private
   * @returns {Promise<Array>} Array of visible thumbnail elements
   */
  async _getVisibleThumbnails() {
    const thumbnails = await this.page.$$(selectors.THUMBNAIL_BUTTON);
    const visible = [];
    for (const thumb of thumbnails) {
      const isVisible = await thumb.isVisible().catch(() => false);
      if (isVisible) {
        visible.push(thumb);
      }
    }
    return visible;
  }

  /**
   * Detect remaining videos by counting thumbnail buttons
   * @private
   * @returns {Promise<{count: number, hasThumbnails: boolean}>}
   */
  async _detectRemainingVideos() {
    try {
      const visibleThumbnails = await this._getVisibleThumbnails();

      if (visibleThumbnails.length > 0) {
        return { count: visibleThumbnails.length, hasThumbnails: true };
      }

      // No thumbnails - check if there's a single video playing
      const video = await this.page.$(selectors.VIDEO_CONTAINER);
      if (video) {
        const isVisible = await video.isVisible().catch(() => false);
        const src = await video.getAttribute('src').catch(() => null);
        if (isVisible && src) {
          // Single video with no thumbnails means it's the last one
          return { count: 1, hasThumbnails: false };
        }
      }

      // No videos found
      return { count: 0, hasThumbnails: false };
    } catch (error) {
      this.logger.debug(`[Worker ${this.workerId}] Error detecting remaining videos: ${error.message}`);
      return { count: 0, hasThumbnails: false };
    }
  }

  /**
   * Click the last thumbnail button to select that video
   * @private
   * @returns {Promise<boolean>} True if click succeeded
   */
  async _clickLastThumbnail() {
    try {
      const visibleThumbnails = await this._getVisibleThumbnails();

      if (visibleThumbnails.length === 0) {
        return false;
      }

      // Click the last thumbnail
      const lastThumbnail = visibleThumbnails[visibleThumbnails.length - 1];
      await lastThumbnail.click();
      this.logger.debug(`[Worker ${this.workerId}] Clicked last thumbnail (${visibleThumbnails.length} total)`);

      await sleep(config.UI_ACTION_DELAY);
      return true;
    } catch (error) {
      this.logger.debug(`[Worker ${this.workerId}] Error clicking last thumbnail: ${error.message}`);
      return false;
    }
  }

  /**
   * Wait for video to load after navigation
   * @private
   */
  async _waitForVideoLoad() {
    try {
      // Wait for video element to be present and have a src
      await this.page.waitForSelector(`${selectors.VIDEO_CONTAINER}[src]`, {
        timeout: 10000,
      });
      // Give video a moment to fully load
      await sleep(1000);
    } catch (error) {
      this.logger.debug(`[Worker ${this.workerId}] Video load wait timed out: ${error.message}`);
    }
  }

  /**
   * Shutdown worker and cleanup resources
   */
  async shutdown() {
    const shutdownStart = Date.now();

    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
        this.page = null;
        this.generator = null;
      }

      // Cleanup worker profile
      try {
        await fs.rm(this.workerProfileDir, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(`[Worker ${this.workerId}] Profile cleanup failed: ${error.message}`);
      }

      const shutdownDurationMs = Date.now() - shutdownStart;
      this.logger.info(
        `[Worker ${this.workerId}] Shutdown complete in ${shutdownDurationMs}ms`
      );
    } catch (error) {
      this.logger.error(`[Worker ${this.workerId}] Shutdown error`, error);
    }
  }
}

export default ParallelWorker;
