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
 * Format timestamp for filenames (YYYYMMDD-HHmmss)
 */
function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
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
  }

  /**
   * Process post-generation actions (download, upscale, and/or delete)
   * @param {number} index - Attempt index for logging
   * @returns {Promise<Object>} Result with download/upscale/delete status
   */
  async process(index) {
    const result = {
      downloaded: false,
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

    // Step 1: Download original video if enabled
    if (this.autoDownload) {
      const downloadResult = await this._downloadWithRetry(index);
      result.downloaded = downloadResult.success;
      result.downloadPath = downloadResult.filePath;
      result.fileSize = downloadResult.fileSize;
      result.downloadError = downloadResult.error;
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

    // Generate filename with timestamp
    const timestamp = formatTimestamp();
    const filename = `video_${timestamp}.mp4`;
    const filePath = path.join(this.downloadDir, filename);

    try {
      // Set up download handler and click button
      const [download] = await Promise.all([
        this.page.waitForEvent('download', { timeout: config.DOWNLOAD_TIMEOUT }),
        downloadButton.click(),
      ]);

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
    try {
      // Step 1: Find and click the "More options" menu button
      const menuButton = await this._findMenuButton();
      if (!menuButton) {
        return { success: false, error: 'More options button not found' };
      }

      await menuButton.click();
      await sleep(500); // Wait for menu to open

      // Step 2: Find and click "Delete video" menu item
      const deleteItem = await this.page.$(selectors.DELETE_MENU_ITEM);
      if (!deleteItem) {
        // Try to close menu by clicking elsewhere
        await this.page.keyboard.press('Escape');
        return { success: false, error: 'Delete menu item not found' };
      }

      await deleteItem.click();
      await sleep(500); // Wait for confirmation modal

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

    // Generate HD filename from original path
    // e.g., video_20240115_143022.mp4 -> video_20240115_143022_hd.mp4
    let hdFilename;
    if (originalPath) {
      const originalFilename = path.basename(originalPath, '.mp4');
      hdFilename = `${originalFilename}_hd.mp4`;
    } else {
      const timestamp = formatTimestamp();
      hdFilename = `video_${timestamp}_hd.mp4`;
    }
    const hdFilePath = path.join(this.downloadDir, hdFilename);

    try {
      // Set up download handler and click button
      const [download] = await Promise.all([
        this.page.waitForEvent('download', { timeout: config.DOWNLOAD_TIMEOUT }),
        downloadButton.click(),
      ]);

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
