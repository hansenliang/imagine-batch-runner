import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import config, { selectors } from '../config.js';
import { VideoGenerator } from './generator.js';

const execFileAsync = promisify(execFile);

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract the post UUID from a Grok Imagine permalink.
 * Returns null if the URL doesn't match the /imagine/post/{UUID} pattern.
 */
function extractPermalinkUUID(permalink) {
  if (!permalink) return null;
  const match = permalink.match(/\/imagine\/post\/([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * Copy only the bot-detection-relevant subset of a Chrome user-data-dir from
 * `source` → `dest`. The full source profile is ~220 MB, of which ~219 MB is
 * HTTP cache / V8 code cache / GPU shader caches / browsing history / etc.
 * that Cloudflare cannot see and Chrome rebuilds on its own. The ~1 MB
 * carry-along (cookies + per-origin storage + a few prefs) is what actually
 * keeps Cloudflare and Grok auth happy; see config.LEAN_PROFILE_INCLUDES.
 *
 * Skips any missing source paths silently — a fresh source profile may not
 * have them all yet, and Chrome will create what it needs on first launch.
 * Any other I/O error propagates so we don't silently produce a broken copy.
 */
async function copyLeanProfile(source, dest) {
  // Pre-create Default/ so include paths under it can be copied without a
  // separate parent-dir mkdir each time.
  await fs.mkdir(path.join(dest, 'Default'), { recursive: true });

  for (const rel of config.LEAN_PROFILE_INCLUDES) {
    const src = path.join(source, rel);
    const tgt = path.join(dest, rel);
    let stat;
    try {
      stat = await fs.stat(src);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await fs.mkdir(path.dirname(tgt), { recursive: true });
    if (stat.isDirectory()) {
      await fs.cp(src, tgt, { recursive: true, force: true });
    } else {
      await fs.copyFile(src, tgt);
    }
  }
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
    this.downloadMaxDurationOnly = options.downloadMaxDurationOnly || false;
    this.downloadDir = options.downloadDir || null;
    this.jobName = options.jobName || null;
    this.downloadAndDeleteRemainingVideos = options.downloadAndDeleteRemainingVideos || false;

    // Video settings selection (opt-in)
    this.selectMaxDuration = options.selectMaxDuration || false;
    this.selectMaxResolution = options.selectMaxResolution || false;
    // When false, a resolution downgrade (e.g. 720p → 480p due to per-resolution
    // rate limit) is treated as a hard rate limit instead of silently continuing.
    this.allowDowngradedQuality = options.allowDowngradedQuality !== false; // default true

    // Extend settings
    this.maxExtendMode = options.maxExtendMode || false;
    // maxExtendMode implies autoExtend
    this.autoExtend = this.maxExtendMode ? true : (options.autoExtend || false);
    this.extendFromTime = options.extendFromTime != null ? options.extendFromTime : null;

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

      // Seed the worker profile with the auth-relevant subset of the account
      // source profile. ~1 MB lean copy instead of ~220 MB full copy; see
      // copyLeanProfile() and config.LEAN_PROFILE_INCLUDES for rationale.
      const sourceProfileDir = path.join(config.PROFILES_DIR, `${this.accountAlias}-chrome`);

      try {
        await fs.access(sourceProfileDir);
        await copyLeanProfile(sourceProfileDir, this.workerProfileDir);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // No source profile yet — Playwright/Chrome will create one fresh.
          // _isAuthenticated() will catch the resulting "not logged in" state.
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

      // Dismiss any blocking overlays (privacy toasts, cookie banners, etc.)
      // before interacting with the page — these can intercept pointer events.
      await this._dismissOverlays();

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
      this.generator = new VideoGenerator(this.page, this.logger, {
        allowDowngradedQuality: this.allowDowngradedQuality,
      });

      // Create post-processor if download/upscale/delete enabled, or if cleanup is enabled
      if (this.autoDownload || this.downloadAndDeleteRemainingVideos) {
        const { PostProcessor } = await import('./post-processor.js');
        const sourceUUID = extractPermalinkUUID(this.permalink);
        // Derive registry name from the download folder (stable across autorun
        // cycles), not jobName (which gets a per-cycle timestamp suffix in autorun).
        const registryName = this.downloadDir ? path.basename(this.downloadDir) : this.jobName;
        const registryPath = registryName
          ? path.join(config.RUNS_DIR, 'uuid-registry', `${registryName}.txt`)
          : null;
        this.postProcessor = new PostProcessor(this.page, this.logger, {
          autoDownload: this.autoDownload || this.downloadAndDeleteRemainingVideos,
          autoUpscale: this.autoUpscale,
          autoDelete: this.autoDelete || this.downloadAndDeleteRemainingVideos,
          downloadDir: this.downloadDir,
          jobName: this.jobName,
          registryPath,
          sourceUUID,
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
   * Dismiss any blocking overlays (privacy toasts, cookie banners, etc.)
   * that sit above the main UI and intercept pointer events.
   * Called before any click interactions to ensure a clean slate.
   * @private
   */
  async _dismissOverlays() {
    try {
      const removed = await this.page.evaluate(() => {
        let count = 0;
        // Pattern 1: Fixed-position toast/banner overlays (e.g. privacy policy toast)
        document.querySelectorAll('div.fixed[class*="z-50"][class*="shadow"]').forEach(el => {
          el.remove();
          count++;
        });
        // Pattern 2: Absolute-position announcement banners (z-[9999])
        document.querySelectorAll('div.absolute[class*="z-[9999]"]').forEach(el => {
          el.remove();
          count++;
        });
        return count;
      });
      if (removed > 0) {
        this.logger.debug(`[Worker ${this.workerId}] Dismissed ${removed} blocking overlay(s)`);
        await sleep(300);
      }
    } catch {
      // Best-effort — don't let overlay dismissal break the flow
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
   * Race detection: wait until the page settles into either a loaded video OR
   * a static-image post for the given UUID. Used after navigating to a permalink
   * (or after a thumbnail click) where the destination could be either a video
   * (extend path) or an image post (generate path) — without this, a missing
   * video element silently consumes the full ELEMENT_WAIT_TIMEOUT (30s).
   * @private
   * @returns {Promise<'video'|'image'|'timeout'>}
   */
  async _waitForVideoOrImagePost(uuid, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await this.page.evaluate((id) => {
        const hasVideo = [...document.querySelectorAll('video')].some(v => !!(v.currentSrc || v.src));
        if (hasVideo) return 'video';
        const hasImage = id && !!document.querySelector(`img[src*="${id}"]`);
        if (hasImage) return 'image';
        return 'unknown';
      }, uuid).catch(() => 'unknown');
      if (state === 'video' || state === 'image') return state;
      await sleep(300);
    }
    return 'timeout';
  }

  /**
   * Wait for the page URL to stabilize (no SPA redirect pending).
   * Grok's SPA navigation can asynchronously redirect after domcontentloaded,
   * so we poll the URL until it stays the same for a stable window.
   * @param {number} [stableMs=1500] - How long the URL must stay unchanged
   * @param {number} [timeoutMs=8000] - Max time to wait for stability
   * @returns {Promise<string>} The stable URL
   * @private
   */
  async _waitForUrlStable(stableMs = 1500, timeoutMs = 8000) {
    const start = Date.now();
    let lastUrl = this.page.url();
    let lastChangeTime = start;

    while (Date.now() - start < timeoutMs) {
      await sleep(300);
      const currentUrl = this.page.url();
      if (currentUrl !== lastUrl) {
        this.logger.debug(
          `[Worker ${this.workerId}] URL changed during stability wait: ${lastUrl} → ${currentUrl}`
        );
        lastUrl = currentUrl;
        lastChangeTime = Date.now();
      } else if (Date.now() - lastChangeTime >= stableMs) {
        return lastUrl;
      }
    }
    this.logger.debug(
      `[Worker ${this.workerId}] URL stability timeout after ${timeoutMs}ms, using: ${lastUrl}`
    );
    return lastUrl;
  }

  /**
   * Switch from image mode to video mode.
   *
   * Grok UI variants (tried in order):
   *   1. Direct "Video" button (aria-label="Video") — current UI (April 2026)
   *   2. Settings gear → "Make Video" menu item — legacy UI
   *
   * If neither is found, assumes already in video mode (no-op).
   * @private
   */
  async _selectVideoMode() {
    try {
      // If any video element already has a src (e.g. from a previous run), we're already
      // in video mode. Skip the interaction to avoid triggering SPA navigation.
      const hasExistingVideo = await this.page.$$eval(selectors.VIDEO_CONTAINER,
        videos => videos.some(v => !!(v.currentSrc || v.src))
      ).catch(() => false);
      if (hasExistingVideo) {
        this.logger.debug(`[Worker ${this.workerId}] Video already present, skipping mode selection`);
        return;
      }

      // ── Path 1: Direct "Video" button (current Grok UI) ──
      const videoButton = await this.page.$(selectors.VIDEO_MODE_BUTTON);
      if (videoButton) {
        const isVisible = await videoButton.isVisible().catch(() => false);
        if (isVisible) {
          await videoButton.click();
          await sleep(config.UI_ACTION_DELAY);
          this.logger.info(`[Worker ${this.workerId}] Switched to video mode via Video button`);
          return;
        }
      }

      // ── Path 2: Settings gear → "Make Video" menu item (legacy UI) ──
      const settingsButton = await this.page.$(selectors.SETTINGS_BUTTON);
      if (!settingsButton) {
        this.logger.debug(`[Worker ${this.workerId}] No video/settings button found, assuming video mode`);
        return;
      }

      const isVisible = await settingsButton.isVisible().catch(() => false);
      if (!isVisible) {
        this.logger.debug(`[Worker ${this.workerId}] Settings button not visible, assuming video mode`);
        return;
      }

      await settingsButton.click();
      await sleep(config.UI_ACTION_DELAY);

      let makeVideoItem = await this.page.$(selectors.MAKE_VIDEO_MODE_ITEM);

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

    // Whether the permalink is a static image (no video to extend). Detected
    // lazily by _navigateToSourceVideo() on the first chain — checking here
    // upfront via _getVideoDuration() would be wrong, since init's page.goto()
    // gets auto-redirected by Grok to the latest derived video for the post,
    // which has a duration even when the permalink itself is an image.
    let isImagePost = false;

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

        // Track whether the video was freshly generated from an image (no existing
        // video at the permalink). When true, extendFromTime is skipped since the
        // generated video is too short for a specific-frame extend to make sense.
        let generatedFromImage = false;

        // Path of the most recently downloaded video for this chain (initial gen
        // or any successful extension). Used at chain end to skip a redundant
        // download in post-processing while still letting upscale/delete run.
        // Stays null when downloadMaxDurationOnly is set or per-rung download fails.
        let chainDownloadedPath = null;

        if (this.maxExtendMode) {
          // Always navigate via _navigateToSourceVideo so each chain starts on the
          // source post (Grok auto-redirects permalinks to the latest derivative,
          // and chain 2+ otherwise sits on the previous chain's generated video).
          // The return flag tells us whether the source is a video (extend path)
          // or a static image (generate path).
          this.logger.info(`[Worker ${this.workerId}] Chain ${index + 1}: navigating to source`);
          const navResult = await this._navigateToSourceVideo();

          if (navResult.isImagePost) {
            if (!isImagePost) {
              this.logger.info(
                `[Worker ${this.workerId}] Source is a static image — generating fresh video then extending to ${config.MAX_VIDEO_DURATION}s`
              );
              isImagePost = true;
            }
            generatedFromImage = true;
            // The thumbnail click landed us on the image page; init's
            // _selectVideoMode() ran on the redirected video, so re-select here
            // to ensure the generate UI is accessible.
            await this._selectVideoMode();
            await this._dismissOverlays();
            // Fall through to the generate path below.
          } else {
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
          }
        }

        if (!generationOk) {
          // Fresh generation path — used by normal mode and by maxExtendMode
          // when the source permalink is a static image.
          this.logger.info(`[Worker ${this.workerId}] Attempting generation ${index + 1}`);
          // For image-post chains we already navigated via _navigateToSourceVideo;
          // re-running _ensureOnPermalink would be a no-op anyway, but skip it for
          // clarity and to avoid an extra DOM round-trip.
          if (!generatedFromImage) {
            await this._ensureOnPermalink();
          }

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

            // Verified video on the page: count it in the per-duration bucket
            // and capture it to disk if per-rung downloads are enabled.
            const initialDur = await this._getVideoDuration();
            const downloadedPath = await this._handleRungSuccess(
              index,
              initialDur,
              `Attempt ${index + 1}`
            );
            if (downloadedPath) chainDownloadedPath = downloadedPath;
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

            // Page may be in a broken state (e.g. prompt input not found).
            // Reload to give the next attempt a clean slate.
            this.logger.info(`[Worker ${this.workerId}] Reloading page after failure`);
            try {
              await this.page.reload({ waitUntil: 'domcontentloaded', timeout: config.PAGE_LOAD_TIMEOUT });
              await sleep(3000);
              await this._waitForReadyUI();
            } catch (reloadError) {
              this.logger.warn(`[Worker ${this.workerId}] Page reload failed: ${reloadError.message}`);
            }
          }
        }

        // ── Step 2: Extend to max duration (if enabled and we have a video) ──
        let extResult = null;
        if (generationOk && this.autoExtend) {
          extResult = await this._runExtendLoop(this.page.url(), index, {
            skipExtendFromTime: generatedFromImage,
            initialDownloadedPath: chainDownloadedPath,
          });
          // Carry forward the latest per-rung download path from the extend loop
          // so the final post-processing pass can skip re-downloading and seed
          // the HD filename from the original.
          if (extResult.lastDownloadedPath) {
            chainDownloadedPath = extResult.lastDownloadedPath;
          }

          if (extResult.rateLimited) {
            // In max-extend mode, rate limit on extend is fatal (nothing else to do)
            // — unless the video is already at max duration
            if (this.maxExtendMode && extResult.successfulExtends === 0 && !extResult.alreadyAtTarget) {
              this.logger.warn(`[Worker ${this.workerId}] Rate limit during extend chain ${index + 1}`);
              await this.manifest.updateItemAtomic(
                index,
                { status: 'RATE_LIMITED', error: 'Rate limited during extension', attempts: 0 },
                this.workerId
              );
              throw new Error('RATE_LIMIT_STOP');
            }
          }

          // Same pattern for ghost-extend: in max-extend mode with no real
          // successful extends, there's no partial to preserve, so stop
          // immediately. The throw is caught in parallel-runner alongside
          // RATE_LIMIT_STOP and surfaces a clear stop reason.
          if (extResult.ghostExtendDetected) {
            if (this.maxExtendMode && extResult.successfulExtends === 0 && !extResult.alreadyAtTarget) {
              await this.manifest.updateItemAtomic(
                index,
                {
                  status: 'FAILED',
                  error: `Ghost extend (suspected Grok bug): ${extResult.ghostExtendUrl}`,
                  attempts: 0,
                },
                this.workerId
              );
              throw new Error(`GHOST_EXTEND_STOP: ${extResult.ghostExtendUrl}`);
            }
          }

          // In max-extend mode with zero successful extends, the chain plateaued.
          // - Video-post source: skip post-processing to protect the untouched source.
          // - Image-post source: we still generated a fresh video; let post-processing
          //   run on that 10s/etc. so it gets upscaled (delete is already gated by
          //   duration). The per-rung download already captured it to disk.
          // - alreadyAtTarget: source was already 30s, normal post-processing applies.
          if (this.maxExtendMode && extResult.successfulExtends === 0 && !extResult.alreadyAtTarget) {
            this.logger.warn(
              `[Worker ${this.workerId}] Chain ${index + 1}: No extensions succeeded${generatedFromImage ? ' (keeping freshly generated video)' : ', original video untouched'}`
            );
            await this.manifest.updateItemAtomic(
              index,
              { status: 'FAILED', error: 'All extension attempts failed', attempts: 0 },
              this.workerId
            );
            if (!generatedFromImage) {
              generationOk = false; // Skip post-processing for video-post sources
            }
          }

          // Navigate back to the last successfully extended video before post-processing.
          // After rate limit or failed extends, the page may be on the rate-limit screen
          // or a failed extension URL — not the actual video.
          if (generationOk && extResult.checkpointUrl) {
            await this._navigateToCheckpoint(extResult.checkpointUrl, extResult.lastKnownDuration);
          }
        }

        // ── Step 3: Post-processing (download / upscale / delete) ──────
        if (generationOk) {
          const savedAutoDownload = this.autoDownload;
          const savedAutoDelete = this.autoDelete;
          const savedAutoUpscale = this.postProcessor?.autoUpscale;

          // When downloadMaxDurationOnly is set, skip all post-processing for
          // videos that haven't reached max duration
          if (this.downloadMaxDurationOnly) {
            const finalDuration = await this._getVideoDuration();
            if (finalDuration < config.MAX_VIDEO_DURATION) {
              this.autoDownload = false;
              this.autoDelete = false;
              if (this.postProcessor) {
                this.postProcessor.autoDownload = false;
                this.postProcessor.autoUpscale = false;
                this.postProcessor.autoDelete = false;
              }
              this.logger.info(
                `[Worker ${this.workerId}] Skipping download — video is ${finalDuration.toFixed(1)}s (< ${config.MAX_VIDEO_DURATION}s), downloadMaxDurationOnly enabled`
              );
            }
          } else if (this.autoExtend && this.autoDelete) {
            // Only auto-delete if video reached max duration; partial extensions
            // are preserved on server for future continuation
            const finalDuration = await this._getVideoDuration();
            if (finalDuration < config.MAX_VIDEO_DURATION) {
              this.autoDelete = false;
              // Sync to post-processor — it has its own autoDelete property
              if (this.postProcessor) this.postProcessor.autoDelete = false;
              this.logger.info(
                `[Worker ${this.workerId}] Skipping delete — video is ${finalDuration.toFixed(1)}s (< ${config.MAX_VIDEO_DURATION}s), can be extended further`
              );
            }
          }

          await this._runPostProcessing(index, {
            skipDownload: chainDownloadedPath != null,
            originalPath: chainDownloadedPath,
          });

          this.autoDownload = savedAutoDownload;
          this.autoDelete = savedAutoDelete;
          if (this.postProcessor) {
            this.postProcessor.autoDownload = savedAutoDownload;
            this.postProcessor.autoUpscale = savedAutoUpscale;
            this.postProcessor.autoDelete = savedAutoDelete;
          }
        }

        // Propagate rate limit after post-processing partial extensions.
        // We post-process first (download the partial video) then stop.
        if (extResult?.rateLimited) {
          this.logger.warn(`[Worker ${this.workerId}] Rate limit during extend chain ${index + 1}`);
          throw new Error('RATE_LIMIT_STOP');
        }

        // Same pattern for ghost-extend: post-process whatever real successes
        // we accumulated before the ghost (chain may have grown e.g. 10s → 20s
        // legitimately, then ghost-failed on extend 3), then stop the run.
        if (extResult?.ghostExtendDetected) {
          this.logger.warn(
            `[Worker ${this.workerId}] Ghost extend during chain ${index + 1} — stopping after preserving partial work`
          );
          throw new Error(`GHOST_EXTEND_STOP: ${extResult.ghostExtendUrl}`);
        }

        // Max-extend plateau guard: per spec, a worker should only generate a
        // new video once its current chain has reached max duration. If the
        // chain ended without reaching max (extends exhausted, generation
        // moderated, structural failure, etc.), stop this worker rather than
        // burning credits on another fresh generation. Other workers continue;
        // autorun handles the next cycle. This worker exits cleanly.
        if (this.maxExtendMode) {
          const finalDur = generationOk ? await this._getVideoDuration() : 0;
          if (finalDur < config.MAX_VIDEO_DURATION) {
            this.logger.info(
              `[Worker ${this.workerId}] Chain ${index + 1}: ended at ${finalDur.toFixed(1)}s (< ${config.MAX_VIDEO_DURATION}s) — stopping worker (no new chains until current reaches max)`
            );
            stoppedEarly = true;
            break;
          }
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
      // Controlled stop signals propagate silently to the coordinator, which
      // logs them at WARN with the appropriate stop reason. Logging them here
      // as "Fatal error" with a stack trace is misleading — they're expected
      // termination paths, not crashes.
      if (
        error.message === 'RATE_LIMIT_STOP' ||
        error.message?.startsWith('GHOST_EXTEND_STOP')
      ) {
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
   * @param {Object} [options] - Options
   * @param {boolean} [options.skipExtendFromTime] - Skip extendFromTime on first extend
   *   (used when the video was freshly generated from an image and is too short for
   *   a specific-frame extend to make sense)
   * @returns {Promise<{successfulExtends: number, rateLimited: boolean, checkpointUrl: string}>}
   * @private
   */
  async _runExtendLoop(startCheckpointUrl, index, options = {}) {
    let successfulExtends = 0;
    let failedAttempts = 0;
    const maxFailedAttempts = 100;
    let checkpointUrl = startCheckpointUrl;
    let rateLimitedOnExtend = false;
    const targetDuration = config.MAX_VIDEO_DURATION;
    let lastKnownDuration = 0; // Track duration across extends for diagnostics
    let alreadyAtTarget = false; // True if video was already at max duration (no extend needed)
    let ghostExtendDetected = false; // True if Grok produced a same-length "extension"
    let ghostExtendUrl = null;       // URL of the ghost post (for diagnostics in the throw)
    // Carry forward the initial generation's per-rung download path so the
    // worker's end-of-chain post-processing can pick whichever rung was
    // downloaded last (initial gen, or any successful extension).
    let lastDownloadedPath = options.initialDownloadedPath || null;

    this.logger.debug(`[Worker ${this.workerId}] Extend loop starting — checkpoint: ${checkpointUrl}`);

    while (failedAttempts < maxFailedAttempts && !rateLimitedOnExtend && !ghostExtendDetected) {
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
        // Wait for SPA redirect to settle before checking URL
        const landedUrl = await this._waitForUrlStable();
        // Grok may redirect stale/image permalinks to the latest video's permalink.
        // Accept whatever /post/ URL we land on as the new checkpoint.
        if (landedUrl.includes('/imagine/post/') && landedUrl !== checkpointUrl) {
          this.logger.info(`[Worker ${this.workerId}] Checkpoint redirected to ${landedUrl}`);
          checkpointUrl = landedUrl;
        }
      }

      // Capture the duration of the video about to be extended. Used after the
      // generation completes to verify the result actually grew (a real extend
      // produces a strictly-longer video; a "ghost extend" — Grok bug where
      // the new post is unrelated to the source — leaves it at the same length).
      // Read here, before triggerExtendMode opens the menu / transitions UI,
      // so we're sampling the stable post page.
      const preExtendDuration = await this._getVideoDuration();

      // Step 1: Trigger extend mode.
      // On the first extend, if extendFromTime is set, use "extend from frame"
      // (seek to specific time → hover progress bar → click button).
      // Subsequent extends always use the normal Settings → "Extend video" path.
      let triggered;
      if (successfulExtends === 0 && failedAttempts === 0 && this.extendFromTime != null && !options.skipExtendFromTime) {
        const extUrl = this.page.url();
        const extDur = await this._getVideoDuration();
        this.logger.info(
          `[Worker ${this.workerId}] Triggering extend-from-frame at ${this.extendFromTime}s (page: ${extUrl}, video: ${extDur.toFixed(1)}s)`
        );
        triggered = await this.generator.triggerExtendFromFrame(this.extendFromTime, index);
        this.logger.info(
          `[Worker ${this.workerId}] Extend-from-frame result: ${triggered ? 'SUCCESS' : 'FAILED'}`
        );
        if (!triggered) {
          this.logger.warn(
            `[Worker ${this.workerId}] Extend-from-frame failed, falling back to normal extend`
          );
          triggered = await this.generator.triggerExtendMode(index);
        }
      } else {
        triggered = await this.generator.triggerExtendMode(index);
      }
      if (!triggered) {
        // Check if the video is already at max duration — "Extend video" won't
        // appear for videos that have reached Grok's maximum length.
        const currentDur = await this._getVideoDuration();
        if (currentDur >= targetDuration) {
          this.logger.info(
            `[Worker ${this.workerId}] Extend mode not available — video already at ${currentDur.toFixed(1)}s (max ${targetDuration}s)`
          );
          lastKnownDuration = currentDur;
          checkpointUrl = this.page.url();
          alreadyAtTarget = true;
          break;
        }
        // Recoverable: the page may have drifted, the More-options button may
        // not have rendered yet, or a transient overlay covered it. Cool down,
        // re-navigate to the checkpoint on the next outer iteration, and only
        // bump failedAttempts so the shared maxFailedAttempts ceiling eventually
        // cuts us off. We don't touch `extendAttemptCount` here — that counter
        // only tracks the inner generate() outcomes, not failures to even open
        // the extend UI.
        failedAttempts++;
        this.logger.warn(
          `[Worker ${this.workerId}] Could not trigger extend mode (${failedAttempts}/${maxFailedAttempts}), will re-navigate to checkpoint and retry`
        );
        await sleep(config.MODERATION_RETRY_COOLDOWN);
        // Force re-navigation on the next iteration even if the URL happens to
        // match — the page may need to fully reload to recover the menu button.
        if (this.page.url() === checkpointUrl) {
          try {
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: config.PAGE_LOAD_TIMEOUT });
            await sleep(3000);
            await this._waitForReadyUI();
            await this._waitForVideoLoaded();
          } catch (reloadErr) {
            this.logger.debug(
              `[Worker ${this.workerId}] Page reload after trigger failure failed: ${reloadErr.message}`
            );
          }
        }
        continue;
      }

      // Step 2: Select max extend duration (+10s pills)
      await this._selectMaxDuration(/^\+?\d+s$/);

      // Step 3: Inner retry loop — generate the extension, retrying on content
      // moderation (just hit generate again, like normal moderation retries).
      // Break back to outer loop on success, rate limit, or unrecoverable error.
      while (failedAttempts < maxFailedAttempts) {
        const extResult = await this.generator.generate(index, this.prompt, { logLabel: 'Extend' });
        const extDuration = Math.round((extResult.durationMs || 0) / 1000);

        if (extResult.success) {
          // Read post-extend duration BEFORE advancing checkpoint or counters,
          // so we can roll the "success" back to a ghost-extend stop without
          // having to undo state changes.
          const videoDur = await this._getVideoDuration();
          const ghostUrl = this.page.url();

          // Ghost-extend invariant: a real extension is *defined* by the video
          // growing in duration. If we observed full progress and got a
          // playable video but the duration didn't grow, Grok's "extend"
          // landed us on an unrelated post (suspected DB / moderation bug).
          // Stop the run rather than burn credits chasing fake successes.
          // Tolerance of 0.5s covers floating-point / measurement noise; even
          // a +5s near-cap extension grows by ~5s, well above this floor.
          if (preExtendDuration > 0 && videoDur > 0 && videoDur <= preExtendDuration + 0.5) {
            this.logger.warn(
              `[Worker ${this.workerId}] GHOST EXTEND detected — duration unchanged (${preExtendDuration.toFixed(1)}s → ${videoDur.toFixed(1)}s). ` +
                `Ghost post: ${ghostUrl} | Real checkpoint: ${checkpointUrl}. ` +
                `Suspected Grok bug; stopping run for this config to avoid burning credits.`
            );
            ghostExtendDetected = true;
            ghostExtendUrl = ghostUrl;
            // Do NOT advance checkpointUrl, do NOT increment successfulExtends.
            // Break out of inner loop; outer's while exits via ghostExtendDetected.
            break;
          }

          successfulExtends++;
          failedAttempts = 0; // Reset on success
          const prevCheckpoint = checkpointUrl;
          checkpointUrl = this.page.url(); // Advance checkpoint
          await this.manifest.incrementCounterAtomic('extendedCount');

          lastKnownDuration = videoDur;

          // Diagnostic: log checkpoint advancement and URL change
          if (checkpointUrl === prevCheckpoint) {
            this.logger.warn(
              `[Worker ${this.workerId}] Checkpoint URL unchanged after extend ${successfulExtends}: ${checkpointUrl}`
            );
          } else {
            this.logger.debug(
              `[Worker ${this.workerId}] Checkpoint advanced: ${prevCheckpoint} → ${checkpointUrl}`
            );
          }

          this.logger.success(
            `[Worker ${this.workerId}] Extend ${successfulExtends} succeeded in ${extDuration}s — video now ${videoDur.toFixed(1)}s / ${targetDuration}s`
          );

          // Bucket + capture the new rung. Mirrors the initial-generation path
          // in worker.run() so both success points share the same accounting.
          const rungPath = await this._handleRungSuccess(
            index,
            videoDur,
            `Extend ${successfulExtends}`
          );
          if (rungPath) lastDownloadedPath = rungPath;

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
          this.logger.debug(
            `[Worker ${this.workerId}] Rate limit page URL: ${this.page.url()} (checkpoint: ${checkpointUrl})`
          );
          rateLimitedOnExtend = true;
          break; // → outer loop exits via flag
        } else if (extResult.contentModerated) {
          failedAttempts++;
          await this.manifest.incrementCounterAtomic('extendAttemptCount');
          this.logger.warn(
            `[Worker ${this.workerId}] Extend content moderated (${failedAttempts}/${maxFailedAttempts}), retrying...`
          );

          // Diagnostic: log page URL on 1st moderation and every 10th (to detect drift without flooding logs)
          if (failedAttempts === 1 || failedAttempts % 10 === 0) {
            this.logger.debug(
              `[Worker ${this.workerId}] Page URL after moderation #${failedAttempts}: ${this.page.url()} (checkpoint: ${checkpointUrl})`
            );
          }

          // Cooldown before retry to let stale moderation messages clear
          await sleep(config.MODERATION_RETRY_COOLDOWN);

          // If the page drifted — either away from /imagine/post/ entirely, OR
          // to a /post/<UUID> different from the checkpoint (Grok's moderation-
          // redirect quirk where moderated generations bounce to an unrelated
          // existing post) — break to the outer loop, which will navigate back
          // to the checkpoint and re-trigger extend mode. Without this, we'd
          // retry generate() on an unrelated post in the wrong UI state.
          const postModerationUrl = this.page.url();
          const drifted =
            !postModerationUrl.includes('/imagine/post/') ||
            postModerationUrl !== checkpointUrl;
          if (drifted) {
            this.logger.warn(
              `[Worker ${this.workerId}] Page drifted to ${postModerationUrl} after moderation (checkpoint: ${checkpointUrl}), will re-navigate to checkpoint`
            );
            break; // → outer loop handles recovery
          }
          // Still on the checkpoint page — retry generate directly (UI still in extend mode)
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

    this.logger.debug(
      `[Worker ${this.workerId}] Extend loop exiting — checkpoint: ${checkpointUrl}, lastDuration: ${lastKnownDuration.toFixed(1)}s, currentPageUrl: ${this.page.url()}`
    );

    return {
      successfulExtends,
      rateLimited: rateLimitedOnExtend,
      checkpointUrl,
      lastKnownDuration,
      alreadyAtTarget,
      ghostExtendDetected,
      ghostExtendUrl,
      lastDownloadedPath,
    };
  }

  /**
   * Record a verified video as a success for this chain: bumps the per-duration
   * bucket on the manifest and, when per-rung downloads are enabled, captures
   * the video to disk via the PostProcessor. Used after initial generation and
   * after each successful extension — both produce a verified video on the page
   * that should be counted and downloaded.
   *
   * @param {number} index - Manifest item index for logging.
   * @param {number} durationSec - On-page video duration in seconds.
   * @param {string} label - Log prefix (e.g. "Attempt 4", "Extend 2").
   * @returns {Promise<string|null>} Local path of the downloaded video, or null
   *   when no download happened (download disabled, registry hit, or failure).
   * @private
   */
  async _handleRungSuccess(index, durationSec, label) {
    if (durationSec > 0) {
      await this.manifest.incrementSuccessByDurationAtomic(durationSec);
    }

    // Per-rung download only when explicitly enabled. Registry dedup makes
    // re-downloads of the same UUID a no-op, so we don't need our own guard.
    if (this.downloadMaxDurationOnly || !this.autoDownload || !this.postProcessor) {
      return null;
    }

    const dl = await this.postProcessor.downloadCurrent(index);
    if (dl.downloaded) {
      await this.manifest.incrementCounterAtomic('downloadedCount');
      this.logger.success(
        `[Worker ${this.workerId}] ${label}: Downloaded rung (${durationSec.toFixed(1)}s) to ${dl.downloadPath} (${dl.fileSize})`
      );
      return dl.downloadPath;
    }
    if (dl.skipped) {
      this.logger.info(
        `[Worker ${this.workerId}] ${label}: Rung already in registry, skipping download`
      );
      return null;
    }
    if (dl.downloadError) {
      await this.manifest.incrementCounterAtomic('downloadFailedCount');
      this.logger.warn(
        `[Worker ${this.workerId}] ${label}: Per-rung download failed - ${dl.downloadError}`
      );
    }
    return null;
  }

  /**
   * Post-processing: download, upscale, and/or delete the current video.
   * @param {number} index - Manifest item index
   * @param {Object} [options]
   * @param {boolean} [options.skipDownload=false] - Skip download (caller
   *   already downloaded the original via the extend-loop per-rung path).
   * @param {string|null} [options.originalPath=null] - Path of the
   *   already-downloaded original, used to derive the HD filename.
   * @private
   */
  async _runPostProcessing(index, options = {}) {
    if (!this.postProcessor) return;

    const postResult = await this.postProcessor.process(index, options);
    // When the caller already downloaded the original per-rung, suppress this
    // method's download-counter increment and "Downloaded to ..." log to avoid
    // double-counting and a confusing duplicate log line. The item-level update
    // (`downloaded: true`, `downloadPath`) still runs so the manifest reflects
    // that the chain produced a downloaded video.
    const downloadHandledByCaller = options.skipDownload === true;

    // Update manifest with download results
    if (postResult.downloaded) {
      if (!downloadHandledByCaller) {
        await this.manifest.incrementCounterAtomic('downloadedCount');
        this.logger.success(
          `[Worker ${this.workerId}] Attempt ${index + 1}: Downloaded to ${postResult.downloadPath} (${postResult.fileSize})`
        );
      }
      await this.manifest.updateItemAtomic(index, {
        downloaded: true,
        downloadPath: postResult.downloadPath,
      }, this.workerId);
    } else if (this.autoDownload && !downloadHandledByCaller) {
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
      // Re-navigating resets the page to default mode. If this is an image post,
      // re-select video mode so the generate button is accessible.
      await this._selectVideoMode();
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
   * Prune unwanted variations from the server. Walks every thumbnail at the
   * permalink, extracts each video's UUID, and deletes any video whose UUID is
   * not in the keep set (the source/permalink UUID is always kept).
   *
   * @param {string[]} keepUUIDs - UUIDs (full or 8-char prefix) to preserve
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false] - Log intended deletions without performing them
   * @returns {Promise<{kept: number, deleted: number, failed: number, unknown: number}>}
   */
  async prune(keepUUIDs = [], options = {}) {
    // Prune doesn't need autoDownload/cleanup wiring, so initialize() may not have
    // created the PostProcessor. Construct one on demand for UUID extraction +
    // delete plumbing.
    if (!this.postProcessor) {
      const { PostProcessor } = await import('./post-processor.js');
      this.postProcessor = new PostProcessor(this.page, this.logger, {
        downloadDir: this.downloadDir,
        jobName: this.jobName,
      });
    }
    const dryRun = options.dryRun === true;

    // Build keep set with both full UUIDs and 8-char prefixes so callers can
    // pass either form. Source/permalink UUID is always preserved.
    const keepSet = new Set();
    for (const u of keepUUIDs) {
      if (!u) continue;
      const lower = String(u).toLowerCase().trim();
      if (lower.length >= 8) {
        keepSet.add(lower);
        keepSet.add(lower.substring(0, 8));
      }
    }
    const sourceUUID = extractPermalinkUUID(this.permalink);
    if (sourceUUID) {
      const lower = sourceUUID.toLowerCase();
      keepSet.add(lower);
      keepSet.add(lower.substring(0, 8));
    }

    this.logger.info(`[Pruner] Walking thumbnails at ${this.permalink}`);
    this.logger.info(`[Pruner] Keep set: ${keepSet.size / 2} UUID(s) (incl. source)`);
    if (dryRun) {
      this.logger.info(`[Pruner] DRY RUN — no deletions will occur`);
    }

    const stats = { kept: 0, deleted: 0, failed: 0, unknown: 0 };
    let skippedCount = 0; // Videos walked-past (kept on server)
    let actionIndex = 0;

    while (true) {
      const remaining = await this._detectRemainingVideos();

      if (remaining.count === 0 || remaining.count <= skippedCount) {
        this.logger.info(`[Pruner] No more videos to process`);
        break;
      }

      // Navigate to a thumbnail (walk backwards past already-kept videos)
      if (remaining.count > 1) {
        const targetIndex = remaining.count - 1 - skippedCount;
        if (targetIndex < 0) break;
        const clicked = await this._clickThumbnailAtIndex(targetIndex);
        if (!clicked) {
          this.logger.warn(`[Pruner] Failed to click thumbnail at index ${targetIndex}, stopping`);
          stats.failed++;
          break;
        }
        await this._waitForVideoLoad();
      }

      // Extract this video's UUID
      const uuid = await this.postProcessor._extractVideoUUID();
      const uuidFull = uuid ? uuid.toLowerCase() : null;
      const uuid8 = uuidFull ? uuidFull.substring(0, 8) : 'unknown';

      if (!uuidFull) {
        this.logger.warn(`[Pruner] Could not extract UUID for current video — leaving on server`);
        stats.unknown++;
        skippedCount++;
        actionIndex++;
        await sleep(1000);
        continue;
      }

      const isKept = keepSet.has(uuidFull) || keepSet.has(uuid8);

      if (isKept) {
        this.logger.info(`[Pruner] Keep ${uuid8} (whitelisted or source)`);
        stats.kept++;
        skippedCount++;
      } else if (dryRun) {
        this.logger.info(`[Pruner] Would delete ${uuid8}`);
        stats.deleted++;
        skippedCount++;
      } else {
        const deleteResult = await this.postProcessor._deleteWithRetry(actionIndex);
        if (deleteResult.success) {
          this.logger.success(`[Pruner] Deleted ${uuid8}`);
          stats.deleted++;
          // Don't increment skippedCount — the count drops on next _detectRemainingVideos
        } else {
          this.logger.error(`[Pruner] Failed to delete ${uuid8}: ${deleteResult.error}`);
          stats.failed++;
          skippedCount++; // Walk past this one to avoid infinite retry
        }
      }

      actionIndex++;
      await sleep(1000);
    }

    const verb = dryRun ? 'would delete' : 'deleted';
    this.logger.info(
      `[Pruner] Done: ${stats.kept} kept, ${stats.deleted} ${verb}, ${stats.failed} failed, ${stats.unknown} unknown`
    );
    return stats;
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

    const stats = { downloaded: 0, deleted: 0, skipped: 0, failed: 0 };
    let cleanupIndex = 0;
    let skippedCount = 0; // Videos downloaded but not deleted (< max duration when autoExtend)

    while (true) {
      // Detect remaining videos
      const remaining = await this._detectRemainingVideos();

      // Stop if no videos left or all remaining have been processed (skipped)
      if (remaining.count === 0 || remaining.count <= skippedCount) {
        this.logger.info(`[Worker ${this.workerId}] No more videos to cleanup`);
        break;
      }

      this.logger.info(`[Worker ${this.workerId}] ${remaining.count} video(s) remaining, processing...`);

      // Navigate to the target video (process from last to first, skipping
      // already-processed videos that were kept on server at the end)
      if (remaining.count > 1) {
        const targetIndex = remaining.count - 1 - skippedCount;
        if (targetIndex < 0) break;
        const clicked = await this._clickThumbnailAtIndex(targetIndex);
        if (!clicked) {
          this.logger.warn(`[Worker ${this.workerId}] Failed to click thumbnail at index ${targetIndex}, stopping cleanup`);
          stats.failed++;
          break;
        }
        // Wait for video to load after navigation
        await this._waitForVideoLoad();
      }

      // Duration gates: suppress download/delete/upscale for videos under max duration
      const savedAutoDownload = this.postProcessor.autoDownload;
      const savedAutoUpscale = this.postProcessor.autoUpscale;
      const savedAutoDelete = this.postProcessor.autoDelete;
      let deleteSkipped = false;
      let downloadSkipped = false;

      if (this.downloadMaxDurationOnly) {
        const duration = await this._getVideoDuration();
        if (duration < config.MAX_VIDEO_DURATION) {
          this.postProcessor.autoDownload = false;
          this.postProcessor.autoUpscale = false;
          this.postProcessor.autoDelete = false;
          downloadSkipped = true;
          deleteSkipped = true;
          this.logger.info(
            `[Worker ${this.workerId}] Cleanup: skipping download — video is ${duration.toFixed(1)}s (< ${config.MAX_VIDEO_DURATION}s), downloadMaxDurationOnly enabled`
          );
        }
      } else if (this.autoExtend && this.autoDelete) {
        // When autoExtend is on, suppress deletion for videos that haven't
        // reached max duration — they can be extended further in a future run
        const duration = await this._getVideoDuration();
        if (duration < config.MAX_VIDEO_DURATION) {
          this.postProcessor.autoDelete = false;
          deleteSkipped = true;
          this.logger.info(
            `[Worker ${this.workerId}] Cleanup: skipping delete — video is ${duration.toFixed(1)}s (< ${config.MAX_VIDEO_DURATION}s), can be extended further`
          );
        }
      }

      // Process this video (download, upscale if needed, delete if allowed)
      const result = await this.postProcessor.processExistingVideo(cleanupIndex);

      // Restore flags
      this.postProcessor.autoDownload = savedAutoDownload;
      this.postProcessor.autoUpscale = savedAutoUpscale;
      this.postProcessor.autoDelete = savedAutoDelete;

      if (result.downloaded) {
        stats.downloaded++;
        await this.manifest.incrementCounterAtomic('cleanupDownloadedCount');
        this.logger.success(
          `[Worker ${this.workerId}] Cleanup ${cleanupIndex + 1}: Downloaded ${result.downloadPath} (${result.fileSize})`
        );
      }

      if (result.skipped) {
        // UUID already in registry — leave on server, count as skipped so the
        // loop walks past it and eventually terminates.
        skippedCount++;
        stats.skipped++;
        await this.manifest.incrementCounterAtomic('cleanupSkippedCount');
        this.logger.info(
          `[Worker ${this.workerId}] Cleanup ${cleanupIndex + 1}: Skipped — UUID already downloaded`
        );
      } else if (deleteSkipped) {
        // Video intentionally kept on server — track as skipped, not failed
        skippedCount++;
        stats.skipped++;
        await this.manifest.incrementCounterAtomic('cleanupSkippedCount');
      } else if (result.deleted) {
        stats.deleted++;
        await this.manifest.incrementCounterAtomic('cleanupDeletedCount');
        this.logger.success(`[Worker ${this.workerId}] Cleanup ${cleanupIndex + 1}: Deleted from server`);
      } else {
        // Actual delete failure (not intentional skip)
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

    const summaryParts = [
      `${stats.downloaded} downloaded`,
      `${stats.deleted} deleted`,
    ];
    if (stats.skipped > 0) {
      summaryParts.push(`${stats.skipped} kept on server`);
    }
    summaryParts.push(`${stats.failed} failed`);
    this.logger.info(
      `[Worker ${this.workerId}] Cleanup complete: ${summaryParts.join(', ')}`
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
   * Navigate to the source video for max-extend mode.
   * Grok auto-redirects permalink URLs to the latest video for that post.
   * To reach the original, we navigate to the permalink (accepting the redirect),
   * then find the thumbnail whose img src contains the permalink UUID and click it.
   *
   * Retries up to 3 times if the page fails to load a video (Grok sometimes shows
   * transient "post doesn't exist" errors on first load).
   *
   * @returns {Promise<{isImagePost: boolean}>} `isImagePost` is true when the
   *   permalink resolves to a static image (no video to extend) — caller should
   *   route through fresh-generation rather than the extend path.
   * @private
   */
  async _navigateToSourceVideo() {
    const uuid = this.permalink.split('/').pop();
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.logger.info(
        `[Worker ${this.workerId}] _navigateToSourceVideo attempt ${attempt}/${maxRetries} — going to ${this.permalink}`
      );

      try {
        await this.page.goto(this.permalink, {
          waitUntil: 'domcontentloaded',
          timeout: config.PAGE_LOAD_TIMEOUT,
        });
      } catch (navError) {
        this.logger.warn(
          `[Worker ${this.workerId}] page.goto failed (attempt ${attempt}): ${navError.message}`
        );
        if (attempt < maxRetries) {
          await sleep(3000);
          continue;
        }
        throw navError;
      }

      await sleep(3000);
      await this._waitForReadyUI();
      await this._dismissOverlays();

      // Race: the post-load page settles into either a video (extend path) or
      // a static image (generate path). Without this, a missing video element
      // would block us for the full ELEMENT_WAIT_TIMEOUT (30s).
      const initialState = await this._waitForVideoOrImagePost(uuid);
      if (initialState === 'image') {
        this.logger.info(
          `[Worker ${this.workerId}] Detected static image post (UUID: ${uuid}), no video to extend`
        );
        return { isImagePost: true };
      }

      // Wait for Grok's async SPA redirect to settle before checking the URL.
      // Without this, the URL may match our permalink briefly before Grok redirects
      // to the latest video for this post.
      const landedUrl = await this._waitForUrlStable();
      this.logger.info(
        `[Worker ${this.workerId}] Landed on: ${landedUrl} (permalink: ${this.permalink})`
      );

      // Verify a video actually loaded (Grok may show a "post doesn't exist" error page)
      const duration = await this._getVideoDuration();
      if (duration <= 0) {
        // If we landed on the correct permalink (URL contains our UUID) but no video
        // loaded, this is likely a static image post — retrying won't help.
        if (landedUrl.includes(uuid)) {
          this.logger.info(
            `[Worker ${this.workerId}] URL matches permalink but no video — static image post, skipping retries`
          );
          return { isImagePost: true };
        }
        this.logger.warn(
          `[Worker ${this.workerId}] No video loaded after navigation (attempt ${attempt}), duration=0`
        );
        if (attempt < maxRetries) {
          await sleep(3000);
          continue;
        }
        this.logger.warn(`[Worker ${this.workerId}] Exhausted retries — no video found`);
        return { isImagePost: false };
      }

      this.logger.info(
        `[Worker ${this.workerId}] Video loaded: duration=${duration.toFixed(1)}s, url=${landedUrl}`
      );

      // Check if we're on the correct video (URL contains our UUID)
      if (landedUrl.includes(uuid)) {
        this.logger.info(
          `[Worker ${this.workerId}] URL matches permalink, on correct video (${duration.toFixed(1)}s)`
        );
        return { isImagePost: false };
      }

      // We were redirected — need to find and click the correct thumbnail
      this.logger.info(
        `[Worker ${this.workerId}] Redirected to ${landedUrl}, searching for source thumbnail (UUID: ${uuid})`
      );

      if (!uuid) {
        this.logger.warn(`[Worker ${this.workerId}] Could not extract UUID from permalink`);
        return { isImagePost: false };
      }

      const thumbnails = await this._getVisibleThumbnails();
      this.logger.info(
        `[Worker ${this.workerId}] Found ${thumbnails.length} visible thumbnail(s)`
      );

      let foundMatch = false;
      for (let i = 0; i < thumbnails.length; i++) {
        const thumb = thumbnails[i];
        const img = await thumb.$('img');
        if (!img) continue;
        const src = await img.getAttribute('src').catch(() => '');
        this.logger.debug(
          `[Worker ${this.workerId}] Thumbnail ${i}: src=${src ? src.substring(0, 80) + '...' : '(none)'}`
        );
        if (src && src.includes(uuid)) {
          this.logger.info(
            `[Worker ${this.workerId}] Clicking source video thumbnail ${i} (matches UUID ${uuid})`
          );
          await thumb.click();

          // After thumbnail click, the source page might be a video (extend path)
          // or a static image post (generate path). Race detection here avoids the
          // 30s _waitForVideoLoaded() hang when there's no video to load.
          const postClickState = await this._waitForVideoOrImagePost(uuid);
          if (postClickState === 'image') {
            this.logger.info(
              `[Worker ${this.workerId}] Thumbnail click landed on static image post — no video to extend`
            );
            return { isImagePost: true };
          }

          const stableUrl = await this._waitForUrlStable();
          const navDur = await this._getVideoDuration();
          this.logger.info(
            `[Worker ${this.workerId}] After thumbnail click: url=${stableUrl}, duration=${navDur.toFixed(1)}s`
          );

          // Verify we actually ended up on the right video
          if (!stableUrl.includes(uuid)) {
            this.logger.warn(
              `[Worker ${this.workerId}] URL after thumbnail click doesn't contain UUID ${uuid}, got ${stableUrl}`
            );
            // Don't return — fall through to foundMatch=false for retry on next attempt
            break;
          }

          foundMatch = true;
          return { isImagePost: false };
        }
      }

      if (!foundMatch) {
        this.logger.warn(
          `[Worker ${this.workerId}] Could not find source thumbnail for UUID ${uuid} among ${thumbnails.length} thumbnail(s), using current video`
        );
        this.logger.info(
          `[Worker ${this.workerId}] Fallback video: url=${landedUrl}, duration=${duration.toFixed(1)}s`
        );
      }
      return { isImagePost: false };
    }
    return { isImagePost: false };
  }

  /**
   * Navigate to a checkpoint URL for post-processing, handling Grok's redirect behavior.
   *
   * Grok redirects /imagine/post/UUID permalinks to the "latest" video for that post,
   * which may not be the video we want. If a redirect is detected, we find the correct
   * video via its thumbnail (matching the checkpoint UUID in the thumbnail img src)
   * and click it — the same strategy used in _navigateToSourceVideo.
   *
   * @param {string} checkpointUrl - The /imagine/post/UUID URL of the target video
   * @param {number} expectedDuration - Duration (seconds) the video should be, for diagnostics
   * @private
   */
  async _navigateToCheckpoint(checkpointUrl, expectedDuration = 0) {
    const currentUrl = this.page.url();
    if (currentUrl === checkpointUrl) {
      this.logger.debug(
        `[Worker ${this.workerId}] Already on checkpoint URL, no navigation needed: ${currentUrl}`
      );
      return;
    }

    this.logger.info(`[Worker ${this.workerId}] Navigating to checkpoint for post-processing`);
    this.logger.debug(
      `[Worker ${this.workerId}] Post-processing nav: from=${currentUrl} to=${checkpointUrl}`
    );
    await this.page.goto(checkpointUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.PAGE_LOAD_TIMEOUT,
    });
    await sleep(3000);
    await this._waitForReadyUI();
    await this._waitForVideoLoaded();
    // Wait for SPA redirect to settle
    const landedUrl = await this._waitForUrlStable();
    const landedDuration = await this._getVideoDuration();

    // If Grok redirected us to a different video, try to find the correct one via thumbnails
    if (landedUrl !== checkpointUrl) {
      this.logger.warn(
        `[Worker ${this.workerId}] Post-processing checkpoint redirected: expected=${checkpointUrl} landed=${landedUrl}`
      );

      // Extract the UUID from the checkpoint URL and look for it in thumbnails
      const checkpointUuid = checkpointUrl.match(/\/imagine\/post\/([a-f0-9-]+)/i)?.[1];
      if (checkpointUuid) {
        const thumbnails = await this._getVisibleThumbnails();
        for (const thumb of thumbnails) {
          const img = await thumb.$('img');
          if (!img) continue;
          const src = await img.getAttribute('src').catch(() => '');
          if (src && src.includes(checkpointUuid)) {
            this.logger.info(
              `[Worker ${this.workerId}] Found checkpoint video in thumbnails, clicking (UUID: ${checkpointUuid.substring(0, 8)})`
            );
            await thumb.click();
            await this._waitForVideoLoaded();
            const stableUrl = await this._waitForUrlStable();
            const recoveredDuration = await this._getVideoDuration();
            this.logger.debug(
              `[Worker ${this.workerId}] Recovered checkpoint: url=${stableUrl} duration=${recoveredDuration.toFixed(1)}s`
            );
            return;
          }
        }
        this.logger.warn(
          `[Worker ${this.workerId}] Could not find checkpoint thumbnail for UUID ${checkpointUuid.substring(0, 8)}, using redirected video`
        );
      }
    }

    // Log duration match/mismatch for diagnostics
    if (expectedDuration > 0 && Math.abs(landedDuration - expectedDuration) > 1) {
      this.logger.warn(
        `[Worker ${this.workerId}] Post-processing duration mismatch: expected=${expectedDuration.toFixed(1)}s actual=${landedDuration.toFixed(1)}s at ${landedUrl}`
      );
    } else {
      this.logger.debug(
        `[Worker ${this.workerId}] Post-processing checkpoint OK: duration=${landedDuration.toFixed(1)}s at ${landedUrl}`
      );
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
   * Click a thumbnail button at a specific index
   * @private
   * @param {number} index - Zero-based index into the visible thumbnails array
   * @returns {Promise<boolean>} True if click succeeded
   */
  async _clickThumbnailAtIndex(index) {
    try {
      const visibleThumbnails = await this._getVisibleThumbnails();

      if (index < 0 || index >= visibleThumbnails.length) {
        return false;
      }

      await visibleThumbnails[index].click();
      this.logger.debug(`[Worker ${this.workerId}] Clicked thumbnail at index ${index} (${visibleThumbnails.length} total)`);

      await sleep(config.UI_ACTION_DELAY);
      return true;
    } catch (error) {
      this.logger.debug(`[Worker ${this.workerId}] Error clicking thumbnail at index ${index}: ${error.message}`);
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
   * Shutdown worker and cleanup resources.
   *
   * The worker profile is throwaway, so there's no state worth flushing back
   * to disk — Playwright's graceful `context.close()` empirically force-killed
   * 87% of the time anyway (after a full 5s wait), and the remaining 13% had
   * nothing in flight worth waiting for. Skip the wait entirely: fire
   * `context.close()` in the background so Playwright tears down its own
   * handles, then SIGKILL Chrome immediately.
   *
   * Worker profile dir cleanup is intentionally absent — ParallelRunner's
   * `cleanupOperationalFiles()` rms the parent `cacheDir` in one pass, which
   * covers this worker's dir. Doing both raced our own SIGKILL (renderer FDs
   * held for a few ms after kill).
   */
  async shutdown() {
    const shutdownStart = Date.now();

    try {
      if (this.context) {
        // Fire-and-forget: let Playwright clean up its protocol state in the
        // background, but don't wait — Chrome is about to die.
        this.context.close().catch(() => { /* Chrome already dead, expected */ });
        await this._forceKillChrome();
        this.context = null;
        this.page = null;
        this.generator = null;
      }

      const shutdownDurationMs = Date.now() - shutdownStart;
      this.logger.info(
        `[Worker ${this.workerId}] Shutdown complete in ${shutdownDurationMs}ms`
      );
    } catch (error) {
      this.logger.error(`[Worker ${this.workerId}] Shutdown error`, error);
    }
  }

  /**
   * Force-kill this worker's Chrome process by finding the PID via `ps` and
   * sending SIGKILL via `process.kill`. Chrome's renderer/utility children
   * detect the lost IPC channel and exit on their own.
   *
   * Why this shape rather than `pkill -9 -f <profileDir>` (the old approach):
   *   - **No substring collision.** We match the exact `--user-data-dir=<abs>`
   *     flag, so `worker-1`'s kill no longer takes down `worker-10`. This
   *     used to be theoretical-only during whole-cleanup (where every
   *     worker was dying anyway) but became a real bug on partial shutdown
   *     (e.g. one worker hits rate-limit, others still running).
   *   - **No reliance on `pkill` being in PATH.** `process.kill` is the
   *     same syscall the kernel exposes; no extra binary required.
   *   - **One `ps` invocation instead of a `pkill` spawn.** Lighter, and
   *     gives us the list of PIDs so we can log them explicitly.
   *
   * We can't use Playwright's `browser().process()` because for persistent
   * contexts Playwright doesn't expose the underlying ChildProcess handle.
   *
   * Win32: no-op (same as before). `ps`/SIGKILL aren't portable to Windows;
   * Chrome will be reaped when the parent node process exits.
   * @private
   */
  async _forceKillChrome() {
    if (process.platform === 'win32') {
      this.logger.debug(
        `[Worker ${this.workerId}] Force-kill not implemented for win32 — leaving Chrome to exit on its own`
      );
      return;
    }

    const needle = `--user-data-dir=${this.workerProfileDir}`;
    let stdout;
    try {
      // `pid=,command=` suppresses column headers for both fields, so we
      // get raw "<pid> <command>" lines.
      const result = await execFileAsync('ps', ['-A', '-o', 'pid=,command='], {
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      this.logger.debug(`[Worker ${this.workerId}] ps invocation failed: ${error.message}`);
      return;
    }

    const pids = stdout
      .split('\n')
      .filter((line) => line.includes(needle))
      .map((line) => parseInt(line.trim().split(/\s+/)[0], 10))
      .filter(Number.isFinite);

    if (pids.length === 0) {
      this.logger.debug(
        `[Worker ${this.workerId}] No Chrome process found for ${this.workerProfileDir}`
      );
      return;
    }

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        this.logger.debug(`[Worker ${this.workerId}] SIGKILL ${pid}`);
      } catch (error) {
        // ESRCH = process already dead, which is the success state.
        if (error.code !== 'ESRCH') {
          this.logger.warn(
            `[Worker ${this.workerId}] SIGKILL ${pid} failed: ${error.message}`
          );
        }
      }
    }
  }
}

export default ParallelWorker;
