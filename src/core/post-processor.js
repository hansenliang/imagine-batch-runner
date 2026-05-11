import fs from 'fs/promises';
import path from 'path';
import config, { selectors } from '../config.js';

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format timestamp for filenames (YYMMDD-HHmmss)
 */
function formatTimestamp(date = new Date()) {
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Get video duration in whole seconds from the page's video element.
 * @param {import('playwright').Page} page
 * @returns {Promise<number>} Duration in seconds (rounded), or 0 if unavailable
 */
async function getVideoDurationSeconds(page) {
  try {
    const dur = await page.evaluate((sel) => {
      const videos = document.querySelectorAll(sel);
      for (const v of videos) {
        if ((v.currentSrc || v.src) && v.duration > 0) return v.duration;
      }
      return 0;
    }, selectors.VIDEO_CONTAINER);
    return Math.round(dur);
  } catch {
    return 0;
  }
}

/**
 * PostProcessor - handles download, upscale, and delete operations after successful video generation
 */
export class PostProcessor {
  /**
   * @param {import('playwright').Page} page - Playwright page instance
   * @param {import('../utils/logger.js').Logger} logger - Logger instance
   * @param {Object} options - Configuration options
   * @param {boolean} options.autoDownload - Whether to download videos
   * @param {boolean} options.autoUpscale - Whether to upscale videos to HD
   * @param {boolean} options.autoDelete - Whether to delete videos after download
   * @param {string} options.downloadDir - Directory to save downloads
   * @param {string} options.jobName - Job name for logging
   * @param {string} [options.registryPath] - Path to persistent UUID registry file
   * @param {string} [options.sourceUUID] - Permalink/source UUID to always treat as already-downloaded
   */
  constructor(page, logger, options = {}) {
    this.page = page;
    this.logger = logger;
    this.autoDownload = options.autoDownload || false;
    this.autoUpscale = options.autoUpscale || false;
    this.autoDelete = options.autoDelete || false;
    this.downloadDir = options.downloadDir || config.DOWNLOAD_DIR;
    this.jobName = options.jobName || 'unknown';
    this.downloadDirCreated = false;
    this._knownUUIDs = new Set();
    this._registryPath = options.registryPath || null;
    this._registryLoaded = false;
    if (options.sourceUUID) {
      const sourceUUID8 = options.sourceUUID.substring(0, 8).toLowerCase();
      this._knownUUIDs.add(sourceUUID8);
    }
  }

  /**
   * Lazy-load the persistent UUID registry into the in-memory set.
   * Idempotent. Missing file is treated as empty registry.
   * @private
   */
  async _ensureRegistryLoaded() {
    if (this._registryLoaded || !this._registryPath) {
      this._registryLoaded = true;
      return;
    }
    this._registryLoaded = true;
    try {
      const text = await fs.readFile(this._registryPath, 'utf-8');
      let count = 0;
      for (const line of text.split('\n')) {
        const uuid8 = line.trim().toLowerCase();
        if (uuid8.length === 8) {
          this._knownUUIDs.add(uuid8);
          count++;
        }
      }
      if (count > 0) {
        this.logger.debug(`Loaded ${count} UUID(s) from registry: ${this._registryPath}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`Failed to read UUID registry (${this._registryPath}): ${error.message}`);
      }
    }
  }

  /**
   * Append a UUID to the persistent registry file and add to the in-memory set.
   * Idempotent on the in-memory set; the file may accumulate occasional duplicate
   * lines from concurrent workers, which is harmless.
   * @private
   */
  async _recordDownloadedUUID(uuid8) {
    if (!uuid8 || uuid8 === 'unknown') return;
    const normalized = uuid8.toLowerCase();
    this._knownUUIDs.add(normalized);
    if (!this._registryPath) return;
    try {
      await fs.mkdir(path.dirname(this._registryPath), { recursive: true });
      await fs.appendFile(this._registryPath, normalized + '\n');
    } catch (error) {
      this.logger.warn(`Failed to append UUID to registry (${this._registryPath}): ${error.message}`);
    }
  }

  /**
   * Download the currently-displayed video without upscale/delete. Intended for
   * mid-chain captures inside the extend loop, where we want to preserve every
   * rung (10s, 20s, 30s) on disk before moving on. The UUID registry guarantees
   * we never double-download the same video; the final post-processing pass at
   * chain end will see those UUIDs already registered and skip its own download.
   *
   * Returns the same shape as the download portion of `process()`. The caller
   * is responsible for any manifest counter updates.
   * @param {number} index - Attempt index for logging
   * @returns {Promise<{downloaded: boolean, skipped: boolean, downloadPath: ?string, fileSize: ?string, downloadError: ?string}>}
   */
  async downloadCurrent(index) {
    // Match the small POST_GENERATION_DELAY that process() uses, so the video
    // element is settled before we try to extract its UUID/duration.
    await sleep(config.POST_GENERATION_DELAY);
    const downloadResult = await this._downloadWithRetry(index);
    return {
      downloaded: downloadResult.success && !downloadResult.skipped,
      skipped: downloadResult.skipped || false,
      downloadPath: downloadResult.filePath || null,
      fileSize: downloadResult.fileSize || null,
      downloadError: downloadResult.error || null,
    };
  }

  /**
   * Process post-generation actions (download, upscale, and/or delete)
   * @param {number} index - Attempt index for logging
   * @param {Object} [options]
   * @param {boolean} [options.skipDownload=false] - When true, assume the
   *   caller already downloaded the current video (e.g. via `downloadCurrent`
   *   during the extend loop) and proceed straight to upscale/delete. The
   *   `originalPath` option is used to derive the HD filename and signals
   *   to downstream steps that a verified download exists.
   * @param {string|null} [options.originalPath=null] - File path of the
   *   already-downloaded original video, used as the HD filename base. Only
   *   meaningful when `skipDownload=true`.
   * @returns {Promise<Object>} Result with download/upscale/delete status
   */
  async process(index, options = {}) {
    const { skipDownload = false, originalPath = null } = options;

    const result = {
      downloaded: false,
      skipped: false,
      downloadPath: null,
      fileSize: null,
      upscaled: false,
      upscaleDownloadPath: null,
      upscaleFileSize: null,
      upscaleError: null,
      deleted: false,
      downloadError: null,
      deleteError: null,
    };

    // Wait before starting post-processing
    await sleep(config.POST_GENERATION_DELAY);

    // Step 1: Download original video if enabled (unless caller already did)
    if (this.autoDownload && !skipDownload) {
      const downloadResult = await this._downloadWithRetry(index);
      result.downloaded = downloadResult.success && !downloadResult.skipped;
      result.skipped = downloadResult.skipped || false;
      result.downloadPath = downloadResult.filePath;
      result.fileSize = downloadResult.fileSize;
      result.downloadError = downloadResult.error;
    } else if (skipDownload && originalPath) {
      // Caller already downloaded — treat as a successful download for the
      // purposes of upscale/delete gating, and seed the path so HD filename
      // derives from the original.
      result.downloaded = true;
      result.downloadPath = originalPath;
    }

    // If we skipped the download (UUID already in registry), leave the server video
    // untouched — no upscale, no delete. The registry is the source of truth.
    // (Only applies when WE attempted the download; caller-supplied skipDownload
    // means the download already happened on a prior loop iteration and we should
    // proceed.)
    if (result.skipped) {
      return result;
    }

    // Step 2: Upscale if enabled AND original download succeeded
    if (this.autoUpscale) {
      if (!this.autoDownload || result.downloaded) {
        await sleep(config.POST_DOWNLOAD_DELAY);
        const upscaleResult = await this._upscaleWithRetry(index, result.downloadPath);
        result.upscaled = upscaleResult.success;
        result.upscaleDownloadPath = upscaleResult.filePath;
        result.upscaleFileSize = upscaleResult.fileSize;
        result.upscaleError = upscaleResult.error;
      } else {
        result.upscaleError = 'Skipped - original download failed';
      }
    }

    // Step 3: Delete only if ALL enabled operations succeeded
    if (this.autoDelete) {
      const canDelete =
        (!this.autoDownload || result.downloaded) &&
        (!this.autoUpscale || result.upscaled);

      if (canDelete) {
        await sleep(config.POST_DOWNLOAD_DELAY);
        const deleteResult = await this._deleteWithRetry(index);
        result.deleted = deleteResult.success;
        result.deleteError = deleteResult.error;
      } else {
        if (!result.downloaded) {
          result.deleteError = 'Skipped - download failed';
        } else if (!result.upscaled) {
          result.deleteError = 'Skipped - upscale failed';
        }
      }
    }

    return result;
  }

  /**
   * Check if current video is already HD
   * @returns {Promise<boolean>} True if HD badge is detected
   */
  async isHD() {
    const result = await this._detectHDBadge();
    return result.detected;
  }

  /**
   * Process an existing video (for cleanup workflow)
   * Handles both HD and non-HD videos appropriately
   * @param {number} index - Index for logging
   * @returns {Promise<Object>} Result with download/upscale/delete status
   */
  async processExistingVideo(index) {
    const result = {
      downloaded: false,
      skipped: false,
      downloadPath: null,
      fileSize: null,
      upscaled: false,
      upscaleDownloadPath: null,
      upscaleFileSize: null,
      upscaleError: null,
      deleted: false,
      downloadError: null,
      deleteError: null,
      alreadyHD: false,
    };

    // Check if video is already HD
    const isAlreadyHD = await this.isHD();
    result.alreadyHD = isAlreadyHD;

    if (isAlreadyHD) {
      // Video is already HD - just download HD version and delete
      this.logger.debug(`[Cleanup ${index + 1}] Video already HD, downloading HD version`);

      const hdDownloadResult = await this._downloadHDVideo(index, null);
      result.downloaded = hdDownloadResult.success && !hdDownloadResult.skipped;
      result.skipped = hdDownloadResult.skipped || false;
      result.downloadPath = hdDownloadResult.filePath;
      result.fileSize = hdDownloadResult.fileSize;
      result.downloadError = hdDownloadResult.error;
      result.upscaled = result.downloaded; // Mark as upscaled since it was already HD
      result.upscaleDownloadPath = hdDownloadResult.filePath;
      result.upscaleFileSize = hdDownloadResult.fileSize;

      // If skipped, leave the server video untouched.
      if (result.skipped) {
        return result;
      }

      // Delete if enabled and download succeeded
      if (this.autoDelete && result.downloaded) {
        await sleep(config.POST_DOWNLOAD_DELAY);
        const deleteResult = await this._deleteWithRetry(index);
        result.deleted = deleteResult.success;
        result.deleteError = deleteResult.error;
      } else if (!result.downloaded) {
        result.deleteError = 'Skipped - download failed';
      }
    } else {
      // Video is not HD - use full process() flow (download original, upscale, download HD, delete)
      this.logger.debug(`[Cleanup ${index + 1}] Video not HD, running full download/upscale/delete flow`);
      const fullResult = await this.process(index);
      Object.assign(result, fullResult);
    }

    return result;
  }

  /**
   * Download with retry logic
   * @private
   */
  async _downloadWithRetry(index) {
    let lastError = null;

    for (let attempt = 1; attempt <= config.DOWNLOAD_RETRY_MAX; attempt++) {
      try {
        const result = await this._performDownload(index);
        if (result.success) {
          return result;
        }
        lastError = result.error;
      } catch (error) {
        lastError = error.message;
      }

      if (attempt < config.DOWNLOAD_RETRY_MAX) {
        this.logger.debug(`[Attempt ${index + 1}] Download retry ${attempt}/${config.DOWNLOAD_RETRY_MAX} failed, waiting ${config.DOWNLOAD_RETRY_DELAY}ms`);
        await sleep(config.DOWNLOAD_RETRY_DELAY);
      }
    }

    return {
      success: false,
      filePath: null,
      fileSize: null,
      error: `Download failed after ${config.DOWNLOAD_RETRY_MAX} retries - ${lastError}`,
    };
  }

  /**
   * Perform a single download attempt
   * @private
   */
  async _performDownload(index) {
    await this._dismissBanners();

    // Ensure download directory exists
    if (!this.downloadDirCreated) {
      await fs.mkdir(this.downloadDir, { recursive: true });
      this.downloadDirCreated = true;
    }

    // Find download button
    const downloadButton = await this._findDownloadButton();
    if (!downloadButton) {
      return {
        success: false,
        filePath: null,
        fileSize: null,
        error: 'Download button not found',
      };
    }

    // Extract video UUID for deduplication
    const uuid = await this._extractVideoUUID();
    const uuid8 = uuid ? uuid.substring(0, 8).toLowerCase() : 'unknown';

    // If we've already downloaded this UUID, skip the actual download entirely.
    const duplicateCheck = await this._checkForDuplicate(uuid8);
    if (duplicateCheck.isDuplicate) {
      this.logger.info(`[Attempt ${index + 1}] Skipping download — UUID ${uuid8} already in registry`);
      return {
        success: true,
        skipped: true,
        filePath: null,
        fileSize: null,
        error: null,
      };
    }

    // Get video duration for filename
    const durationSec = await getVideoDurationSeconds(this.page);
    const durTag = durationSec > 0 ? `${durationSec}s` : 'unknown';

    // Generate filename: YYMMDD-HHmmss_UUID_DURs.mp4 (full UUID for direct
    // grok.com/imagine/post/<UUID> link lookup; dedup still uses 8-char prefix
    // via the registry).
    const uuidForFilename = uuid ? uuid.toLowerCase() : 'unknown';
    const timestamp = formatTimestamp();
    const filename = `${timestamp}_${uuidForFilename}_${durTag}.mp4`;
    const filePath = path.join(this.downloadDir, filename);

    try {
      // Click button and wait for download (handles both same-page and new-tab downloads)
      const download = await this._clickAndWaitForDownload(downloadButton);

      // Save the download to our target path
      await download.saveAs(filePath);

      // Verify download
      const verified = await this._verifyDownload(filePath);
      if (!verified) {
        return {
          success: false,
          filePath: null,
          fileSize: null,
          error: 'Download verification failed - file empty or missing',
        };
      }

      // Persist this UUID so future runs (after manual folder cleanup) skip it.
      await this._recordDownloadedUUID(uuid8);

      // Get file size
      const stats = await fs.stat(filePath);
      const fileSize = this._formatFileSize(stats.size);

      return {
        success: true,
        filePath,
        fileSize,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        filePath: null,
        fileSize: null,
        error: error.message,
      };
    }
  }

  /**
   * Extract video UUID from the current video's src URL or the page URL.
   * Strategy 1: Video src pattern /generated/{UUID}/...
   * Strategy 2: Page URL pattern /imagine/post/{UUID}
   * @private
   * @returns {Promise<string|null>} UUID or null if not found
   */
  async _extractVideoUUID() {
    try {
      // Strategy 1: Extract from video element's src URL
      const video = await this.page.$(selectors.VIDEO_CONTAINER);
      if (video) {
        // Use currentSrc (handles dual video elements and programmatic src).
        // getAttribute('src') fails when src is set via <source> children or JS.
        const src = await video.evaluate(v => v.currentSrc || v.src || '').catch(() => '');
        if (src) {
          const match = src.match(/\/generated\/([a-f0-9-]+)\//i);
          if (match) return match[1];
          this.logger.debug(`Video src does not match /generated/UUID/ pattern: ${src.substring(0, 120)}`);
        }
      }

      // Strategy 2: Extract from page URL (/imagine/post/{UUID})
      const pageUrl = this.page.url();
      const pageMatch = pageUrl.match(/\/imagine\/post\/([a-f0-9-]+)/i);
      if (pageMatch) {
        this.logger.debug(`UUID extracted from page URL: ${pageMatch[1]}`);
        return pageMatch[1];
      }

      this.logger.debug(`UUID extraction: no video src match and page URL not a post permalink: ${pageUrl}`);
      return null;
    } catch (error) {
      this.logger.debug(`UUID extraction failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if a UUID has already been downloaded (in-memory set + persistent registry).
   * @private
   * @param {string} uuid8 - First 8 chars of UUID
   * @returns {Promise<{isDuplicate: boolean}>}
   */
  async _checkForDuplicate(uuid8) {
    if (!uuid8 || uuid8 === 'unknown') {
      return { isDuplicate: false };
    }
    await this._ensureRegistryLoaded();
    return { isDuplicate: this._knownUUIDs.has(uuid8.toLowerCase()) };
  }

  /**
   * Dismiss any announcement banners that may block UI elements
   * @private
   */
  async _dismissBanners() {
    try {
      // Remove any blocking overlays (privacy toasts, cookie banners, etc.)
      await this.page.evaluate(() => {
        document.querySelectorAll('div.fixed[class*="z-50"][class*="shadow"]').forEach(el => el.remove());
      }).catch(() => {});

      const dismissButton = await this.page.$(selectors.ANNOUNCEMENT_BANNER_DISMISS);
      if (dismissButton) {
        const isVisible = await dismissButton.isVisible().catch(() => false);
        if (isVisible) {
          await dismissButton.click();
          this.logger.debug('Dismissed announcement banner');
          await sleep(config.UI_ACTION_DELAY);
        }
      }
    } catch (error) {
      // Silently ignore - banner dismissal is best-effort
    }
  }

  /**
   * Find the download button using multiple selector strategies
   * @private
   */
  async _findDownloadButton() {
    try {
      // Try the configured selector
      let button = await this.page.$(selectors.DOWNLOAD_BUTTON);
      if (button) {
        const isVisible = await button.isVisible().catch(() => false);
        if (isVisible) return button;
      }

      // Fallback: scan for buttons with download-related labels
      const candidates = await this.page.$$('button, [role="button"], a[download]');
      const matchers = [/download/i, /save/i];

      for (const candidate of candidates) {
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        const aria = await candidate.getAttribute('aria-label').catch(() => '');
        const title = await candidate.getAttribute('title').catch(() => '');
        const text = await candidate.innerText().catch(() => '');
        const label = `${aria} ${title} ${text}`.trim();

        if (matchers.some(pattern => pattern.test(label))) {
          return candidate;
        }
      }

      return null;
    } catch (error) {
      this.logger.debug(`Download button search failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Click a download button and wait for the download, handling both same-page
   * downloads and new-tab downloads (Grok may use either).
   * @private
   * @param {import('playwright').ElementHandle} button - The download button to click
   * @returns {Promise<import('playwright').Download>} The Playwright Download object
   */
  async _clickAndWaitForDownload(button) {
    const context = this.page.context();
    let newPage = null;

    // Set up both listeners BEFORE clicking so we don't miss events
    const samePagePromise = this.page.waitForEvent('download', { timeout: config.DOWNLOAD_TIMEOUT })
      .then(download => ({ download, source: 'same-page' }));

    const newTabPromise = context.waitForEvent('page', { timeout: config.DOWNLOAD_TIMEOUT })
      .then(async (page) => {
        newPage = page;
        const download = await page.waitForEvent('download', { timeout: config.DOWNLOAD_TIMEOUT });
        return { download, source: 'new-tab' };
      });

    // Suppress unhandled rejections on the losing race promise
    samePagePromise.catch(() => {});
    newTabPromise.catch(() => {});

    // Click the download button
    await button.click();

    try {
      // Race: whichever download path fires first wins
      const result = await Promise.race([samePagePromise, newTabPromise]);
      this.logger.debug(`Download initiated via ${result.source}`);
      return result.download;
    } finally {
      // Always close the extra tab if one was opened
      if (newPage && !newPage.isClosed()) {
        await newPage.close().catch(() => {});
      }
    }
  }

  /**
   * Delete with retry logic
   * @private
   */
  async _deleteWithRetry(index) {
    let lastError = null;

    for (let attempt = 1; attempt <= config.DOWNLOAD_RETRY_MAX; attempt++) {
      try {
        const result = await this._performDelete(index);
        if (result.success) {
          return result;
        }
        lastError = result.error;
      } catch (error) {
        lastError = error.message;
      }

      if (attempt < config.DOWNLOAD_RETRY_MAX) {
        this.logger.debug(`[Attempt ${index + 1}] Delete retry ${attempt}/${config.DOWNLOAD_RETRY_MAX} failed, waiting ${config.DOWNLOAD_RETRY_DELAY}ms`);
        await sleep(config.DOWNLOAD_RETRY_DELAY);
      }
    }

    return {
      success: false,
      error: `Delete failed after ${config.DOWNLOAD_RETRY_MAX} retries - ${lastError}`,
    };
  }

  /**
   * Perform a single delete attempt
   * @private
   */
  async _performDelete(index) {
    await this._dismissBanners();

    try {
      // Step 1: Find and click the "More options" menu button
      const menuButton = await this._findMenuButton();
      if (!menuButton) {
        return { success: false, error: 'More options button not found' };
      }

      await menuButton.click();
      await sleep(config.UI_ACTION_DELAY); // Wait for menu to open

      // Step 2: Find and click "Delete video" menu item
      const deleteItem = await this.page.$(selectors.DELETE_MENU_ITEM);
      if (!deleteItem) {
        // Try to close menu by clicking elsewhere
        await this.page.keyboard.press('Escape');
        return { success: false, error: 'Delete menu item not found' };
      }

      await deleteItem.click();
      await sleep(config.UI_ACTION_DELAY); // Wait for confirmation modal

      // Step 3: Find and click confirm button in modal
      const confirmButton = await this.page.$(selectors.DELETE_CONFIRM_BUTTON);
      if (!confirmButton) {
        // Try to close modal
        await this.page.keyboard.press('Escape');
        return { success: false, error: 'Delete confirm button not found' };
      }

      await confirmButton.click();

      // Step 4: Wait for modal to close (indicates deletion completed)
      try {
        await this.page.waitForSelector(selectors.DELETE_MODAL, {
          state: 'hidden',
          timeout: 10000,
        });
      } catch (error) {
        // Modal might have closed quickly, check if video is gone
        this.logger.debug('Modal close wait timed out, checking if delete succeeded');
      }

      return { success: true, error: null };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Find the menu button (three dots / "More options")
   * @private
   */
  async _findMenuButton() {
    try {
      // Try the configured selector
      let button = await this.page.$(selectors.VIDEO_MENU_BUTTON);
      if (button) {
        const isVisible = await button.isVisible().catch(() => false);
        if (isVisible) return button;
      }

      // Fallback: scan for buttons with more/options-related labels
      const candidates = await this.page.$$('button, [role="button"]');
      const matchers = [/more\s*options/i, /options/i, /menu/i];

      for (const candidate of candidates) {
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        const aria = await candidate.getAttribute('aria-label').catch(() => '');
        const title = await candidate.getAttribute('title').catch(() => '');
        const label = `${aria} ${title}`.trim();

        if (matchers.some(pattern => pattern.test(label))) {
          return candidate;
        }
      }

      return null;
    } catch (error) {
      this.logger.debug(`Menu button search failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Verify download succeeded (file exists and has content)
   * @private
   */
  async _verifyDownload(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Format file size for display
   * @private
   */
  _formatFileSize(bytes) {
    if (bytes < 1024) {
      return `${bytes}B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)}KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    } else {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    }
  }

  // ============================================
  // UPSCALE METHODS
  // ============================================

  /**
   * Upscale with retry logic
   * @private
   */
  async _upscaleWithRetry(index, originalPath) {
    let lastError = null;

    for (let attempt = 1; attempt <= config.UPSCALE_RETRY_MAX; attempt++) {
      try {
        const result = await this._performUpscale(index, originalPath);
        if (result.success) {
          return result;
        }
        lastError = result.error;
      } catch (error) {
        lastError = error.message;
      }

      if (attempt < config.UPSCALE_RETRY_MAX) {
        this.logger.debug(`[Attempt ${index + 1}] Upscale retry ${attempt}/${config.UPSCALE_RETRY_MAX} failed, waiting ${config.UPSCALE_RETRY_DELAY}ms`);
        await sleep(config.UPSCALE_RETRY_DELAY);
      }
    }

    return {
      success: false,
      filePath: null,
      fileSize: null,
      error: `Upscale failed after ${config.UPSCALE_RETRY_MAX} retries - ${lastError}`,
    };
  }

  /**
   * Perform a single upscale attempt
   * @private
   */
  async _performUpscale(index, originalPath) {
    await this._dismissBanners();

    try {
      // Step 1: Click the "More options" menu button
      const menuButton = await this._findMenuButton();
      if (!menuButton) {
        return { success: false, filePath: null, fileSize: null, error: 'More options button not found' };
      }

      await menuButton.click();
      await sleep(500); // Wait for menu to open

      // Step 2: Find and click "Upscale video" menu item
      const upscaleItem = await this._findUpscaleMenuItem();
      if (!upscaleItem) {
        await this.page.keyboard.press('Escape'); // Close menu
        return { success: false, filePath: null, fileSize: null, error: 'Upscale menu item not found' };
      }

      await upscaleItem.click();
      this.logger.debug(`[Attempt ${index + 1}] Clicked Upscale video`);

      // Step 3: Wait for upscaling to complete
      const upscaleComplete = await this._waitForUpscaleCompletion(index);
      if (!upscaleComplete.success) {
        return { success: false, filePath: null, fileSize: null, error: upscaleComplete.error };
      }

      // Step 4: Wait for video to update after HD badge appears
      await sleep(config.UPSCALE_POST_COMPLETION_DELAY);

      // Step 5: Download the HD version
      const hdDownloadResult = await this._downloadHDVideo(index, originalPath);

      return hdDownloadResult;
    } catch (error) {
      return { success: false, filePath: null, fileSize: null, error: error.message };
    }
  }

  /**
   * Find the "Upscale video" menu item
   * @private
   */
  async _findUpscaleMenuItem() {
    try {
      // Try the configured selector
      let item = await this.page.$(selectors.UPSCALE_MENU_ITEM);
      if (item) {
        const isVisible = await item.isVisible().catch(() => false);
        if (isVisible) return item;
      }

      // Fallback: scan menu items for upscale text
      const menuItems = await this.page.$$('[role="menuitem"]');
      for (const menuItem of menuItems) {
        const isVisible = await menuItem.isVisible().catch(() => false);
        if (!isVisible) continue;

        const text = await menuItem.innerText().catch(() => '');
        if (/upscale/i.test(text)) {
          return menuItem;
        }
      }

      return null;
    } catch (error) {
      this.logger.debug(`Upscale menu item search failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Wait for upscaling to complete (detect "Upscaling" indicator, then HD badge)
   * State machine:
   *   1. Look for "Upscaling" indicator to confirm upscale started
   *   2. Wait for "Upscaling" indicator to disappear
   *   3. Verify HD badge appears
   * @private
   */
  async _waitForUpscaleCompletion(index) {
    const startTime = Date.now();
    const checkInterval = 500; // Check every 500ms
    let sawUpscalingIndicator = false;

    this.logger.debug(`[Attempt ${index + 1}] Waiting for upscale to complete`);

    while (true) {
      const elapsed = Date.now() - startTime;

      // Check timeout
      if (elapsed > config.UPSCALE_TIMEOUT) {
        if (!sawUpscalingIndicator) {
          return { success: false, error: 'Upscale timeout - never saw upscaling indicator' };
        }
        return { success: false, error: `Upscale timeout after ${config.UPSCALE_TIMEOUT / 1000}s` };
      }

      // Detect "Upscaling" indicator
      const upscalingIndicator = await this._detectUpscalingIndicator();

      if (upscalingIndicator.detected) {
        if (!sawUpscalingIndicator) {
          sawUpscalingIndicator = true;
          this.logger.debug(`[Attempt ${index + 1}] Upscaling indicator detected`);
        }
      } else if (sawUpscalingIndicator) {
        // Upscaling indicator disappeared - check for HD badge
        const hdBadge = await this._detectHDBadge();
        if (hdBadge.detected) {
          this.logger.debug(`[Attempt ${index + 1}] HD badge detected - upscale complete`);
          return { success: true };
        }
      }

      // Also check for HD badge directly (in case we missed the upscaling indicator)
      if (!sawUpscalingIndicator) {
        const hdBadge = await this._detectHDBadge();
        if (hdBadge.detected) {
          this.logger.debug(`[Attempt ${index + 1}] HD badge detected (indicator may have been brief)`);
          return { success: true };
        }
      }

      await sleep(checkInterval);
    }
  }

  /**
   * Detect the "Upscaling" indicator
   * @private
   */
  async _detectUpscalingIndicator() {
    try {
      // Look for text containing "Upscaling"
      const indicator = await this.page.$(selectors.UPSCALING_INDICATOR);
      if (indicator) {
        const isVisible = await indicator.isVisible().catch(() => false);
        if (isVisible) {
          return { detected: true };
        }
      }

      // Fallback: search for any visible element with "Upscaling" text
      const elements = await this.page.$$('span, div');
      for (const el of elements.slice(0, 100)) { // Limit search for performance
        try {
          const text = await el.innerText().catch(() => '');
          if (/^upscaling$/i.test(text.trim())) {
            const isVisible = await el.isVisible().catch(() => false);
            if (isVisible) {
              return { detected: true };
            }
          }
        } catch {
          continue;
        }
      }

      return { detected: false };
    } catch (error) {
      return { detected: false };
    }
  }

  /**
   * Detect the HD badge indicating upscale is complete
   * @private
   */
  async _detectHDBadge() {
    try {
      const badge = await this.page.$(selectors.HD_BADGE);
      if (badge) {
        const isVisible = await badge.isVisible().catch(() => false);
        if (isVisible) {
          return { detected: true };
        }
      }

      // Fallback: search for "HD" text in likely badge locations
      const candidates = await this.page.$$('span, div, button');
      for (const candidate of candidates.slice(0, 100)) {
        try {
          const text = await candidate.innerText().catch(() => '');
          if (/^hd$/i.test(text.trim())) {
            const isVisible = await candidate.isVisible().catch(() => false);
            if (isVisible) {
              return { detected: true };
            }
          }
        } catch {
          continue;
        }
      }

      return { detected: false };
    } catch (error) {
      return { detected: false };
    }
  }

  /**
   * Download the HD version of the video
   * @private
   */
  async _downloadHDVideo(index, originalPath) {
    // Ensure download directory exists
    if (!this.downloadDirCreated) {
      await fs.mkdir(this.downloadDir, { recursive: true });
      this.downloadDirCreated = true;
    }

    // Find download button
    const downloadButton = await this._findDownloadButton();
    if (!downloadButton) {
      return {
        success: false,
        filePath: null,
        fileSize: null,
        error: 'Download button not found for HD video',
      };
    }

    // Generate HD filename from original path or create new one with UUID
    let hdFilename;
    let uuid8ForTracking = null; // Track UUID for standalone HD downloads

    if (originalPath) {
      // Derive from original: YYMMDD-HHmmss_UUID_DURs.mp4 -> YYMMDD-HHmmss_UUID_DURs_hd.mp4
      const originalFilename = path.basename(originalPath, '.mp4');
      hdFilename = `${originalFilename}_hd.mp4`;
    } else {
      // No original path - extract UUID, dedup, build filename
      const uuid = await this._extractVideoUUID();
      const uuid8 = uuid ? uuid.substring(0, 8).toLowerCase() : 'unknown';

      const duplicateCheck = await this._checkForDuplicate(uuid8);
      if (duplicateCheck.isDuplicate) {
        this.logger.info(`[Attempt ${index + 1}] Skipping HD download — UUID ${uuid8} already in registry`);
        return {
          success: true,
          skipped: true,
          filePath: null,
          fileSize: null,
          error: null,
        };
      }

      uuid8ForTracking = uuid8 !== 'unknown' ? uuid8 : null;
      const timestamp = formatTimestamp();
      const durationSec = await getVideoDurationSeconds(this.page);
      const durTag = durationSec > 0 ? `${durationSec}s` : 'unknown';
      const uuidForFilename = uuid ? uuid.toLowerCase() : 'unknown';
      hdFilename = `${timestamp}_${uuidForFilename}_${durTag}_hd.mp4`;
    }
    const hdFilePath = path.join(this.downloadDir, hdFilename);

    try {
      // Click button and wait for download (handles both same-page and new-tab downloads)
      const download = await this._clickAndWaitForDownload(downloadButton);

      // Save the download to our target path
      await download.saveAs(hdFilePath);

      // Verify download
      const verified = await this._verifyDownload(hdFilePath);
      if (!verified) {
        return {
          success: false,
          filePath: null,
          fileSize: null,
          error: 'HD download verification failed - file empty or missing',
        };
      }

      // Persist UUID for standalone HD downloads (no original path; the original-flow
      // already recorded the UUID before reaching here).
      if (uuid8ForTracking) {
        await this._recordDownloadedUUID(uuid8ForTracking);
      }

      // Get file size
      const stats = await fs.stat(hdFilePath);
      const fileSize = this._formatFileSize(stats.size);

      return {
        success: true,
        filePath: hdFilePath,
        fileSize,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        filePath: null,
        fileSize: null,
        error: error.message,
      };
    }
  }
}

export default PostProcessor;
