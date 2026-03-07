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
   * Select the maximum available video duration.
   * Called once per worker session during initialization.
   * @private
   */
  async _selectMaxDuration() {
    try {
      // Click video options button to open duration menu
      const optionsButton = await this.page.$(selectors.VIDEO_OPTIONS_BUTTON);
      if (!optionsButton) {
        this.logger.warn(`[Worker ${this.workerId}] Video options button not found, using default duration`);
        return;
      }

      await optionsButton.click();
      await sleep(config.UI_ACTION_DELAY); // Wait for menu to open

      // Find all buttons in the menu and filter for duration patterns (e.g., "6s", "10s")
      const buttons = await this.page.$$('button');
      const durationButtons = [];

      for (const button of buttons) {
        const isVisible = await button.isVisible().catch(() => false);
        if (!isVisible) continue;

        const ariaLabel = await button.getAttribute('aria-label').catch(() => '');
        const text = await button.innerText().catch(() => '');
        const label = ariaLabel || text;

        // Match duration pattern: digits followed by 's' (e.g., "6s", "10s")
        const match = label.match(/^(\d+)s$/);
        if (match) {
          durationButtons.push({
            button,
            duration: parseInt(match[1], 10),
            label,
          });
        }
      }

      if (durationButtons.length === 0) {
        this.logger.warn(`[Worker ${this.workerId}] No duration buttons found, using default duration`);
        // Close menu by pressing Escape
        await this.page.keyboard.press('Escape');
        return;
      }

      // Find and click the maximum duration
      const maxDuration = durationButtons.reduce((max, curr) =>
        curr.duration > max.duration ? curr : max
      );

      await maxDuration.button.click();
      await sleep(config.UI_ACTION_DELAY); // Wait for menu to close

      this.selectedDuration = `${maxDuration.duration}s`;
      this.logger.info(`[Worker ${this.workerId}] Selected video duration: ${this.selectedDuration}`);
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] Duration selection failed: ${error.message}, using default`);
      this.selectedDuration = null;
    }
  }

  /**
   * Select the maximum available video resolution.
   * Called once per worker session during initialization.
   * @private
   */
  async _selectMaxResolution() {
    try {
      // Click video options button to open menu
      const optionsButton = await this.page.$(selectors.VIDEO_OPTIONS_BUTTON);
      if (!optionsButton) {
        this.logger.warn(`[Worker ${this.workerId}] Video options button not found, using default resolution`);
        return;
      }

      await optionsButton.click();
      await sleep(config.UI_ACTION_DELAY); // Wait for menu to open

      // Find all buttons in the menu and filter for resolution patterns (e.g., "480p", "720p")
      const buttons = await this.page.$$('button');
      const resolutionButtons = [];

      for (const button of buttons) {
        const isVisible = await button.isVisible().catch(() => false);
        if (!isVisible) continue;

        const ariaLabel = await button.getAttribute('aria-label').catch(() => '');
        const text = await button.innerText().catch(() => '');
        const label = ariaLabel || text;

        // Match resolution pattern: digits followed by 'p' (e.g., "480p", "720p", "1080p")
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
        // Close menu by pressing Escape
        await this.page.keyboard.press('Escape');
        return;
      }

      // Find and click the maximum resolution
      const maxResolution = resolutionButtons.reduce((max, curr) =>
        curr.resolution > max.resolution ? curr : max
      );

      await maxResolution.button.click();
      await sleep(config.UI_ACTION_DELAY); // Wait for menu to close

      this.selectedResolution = `${maxResolution.resolution}p`;
      this.logger.info(`[Worker ${this.workerId}] Selected video resolution: ${this.selectedResolution}`);
    } catch (error) {
      this.logger.warn(`[Worker ${this.workerId}] Resolution selection failed: ${error.message}, using default`);
      this.selectedResolution = null;
    }
  }

  /**
   * Run worker loop: claim work, generate videos, repeat until no work
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
          // Release the item back to PENDING
          await this.manifest.updateItemAtomic(
            index,
            { status: 'PENDING' },
            this.workerId
          );
          stoppedEarly = true;
          break;
        }

        this.logger.info(`[Worker ${this.workerId}] Attempting generation ${index + 1}`);

        // Generate video (returns result with success, rateLimited, attempted)
        const result = await this.generator.generate(index, this.prompt);
        const duration = Math.round((result.durationMs || 0) / 1000);

        // Handle rate limit
        if (result.rateLimited) {
          this.logger.warn(`[Worker ${this.workerId}] Rate limit detected during attempt ${index + 1}`);
          await this.manifest.updateItemAtomic(
            index,
            {
              status: 'RATE_LIMITED',
              error: result.error,
              attempts: 0
            },
            this.workerId
          );
          throw new Error('RATE_LIMIT_STOP'); // Signal to coordinator
        }

        // Handle success
        if (result.success) {
          await this.manifest.updateItemAtomic(
            index,
            {
              status: 'COMPLETED',
              attempts: result.attempted ? 1 : 0
            },
            this.workerId
          );

          // Track A/B test occurrences
          if (result.abTestDetected) {
            await this.manifest.incrementCounterAtomic('abTestCount');
          }

          const effectiveResolution = result.actualResolution || this.selectedResolution;
          const settingsInfo = [this.selectedDuration, effectiveResolution].filter(Boolean).join(', ');
          const settingsSuffix = settingsInfo ? ` (${settingsInfo})` : '';
          this.logger.success(
            `[Worker ${this.workerId}] Attempt ${index + 1}: Success in ${duration}s${settingsSuffix} - ${this.page.url()}`
          );

          // Post-processing: download and/or delete
          if (this.postProcessor) {
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
        } else if (result.contentModerated) {
          // Content moderation - expected failure, already logged as WARN in generator
          await this.manifest.updateItemAtomic(
            index,
            {
              status: 'CONTENT_MODERATED',
              error: result.error,
              attempts: 1
            },
            this.workerId
          );
          // No additional logging - generator already logged WARN
        } else {
          // Technical failure - unexpected
          await this.manifest.updateItemAtomic(
            index,
            {
              status: 'FAILED',
              error: result.error,
              attempts: result.attempted ? 1 : 0
            },
            this.workerId
          );

          this.logger.error(
            `[Worker ${this.workerId}] Attempt ${index + 1}: Failed - ${result.error || 'Unknown error'}`
          );
        }

        // Check if we should stop AFTER completing work
        if (this.shouldStop) {
          this.logger.info(`[Worker ${this.workerId}] Stop signal received, exiting after completing attempt ${index + 1}`);
          stoppedEarly = true;
          break;
        }

        // Small delay between generations
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
