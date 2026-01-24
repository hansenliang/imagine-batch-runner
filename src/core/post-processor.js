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
 * Format timestamp for filenames (YYYYMMDD_HHmmss)
 */
function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * PostProcessor - handles download and delete operations after successful video generation
 */
export class PostProcessor {
  /**
   * @param {import('playwright').Page} page - Playwright page instance
   * @param {import('../utils/logger.js').Logger} logger - Logger instance
   * @param {Object} options - Configuration options
   * @param {boolean} options.autoDownload - Whether to download videos
   * @param {boolean} options.autoDelete - Whether to delete videos after download
   * @param {string} options.downloadDir - Directory to save downloads
   * @param {string} options.jobName - Job name for logging
   */
  constructor(page, logger, options = {}) {
    this.page = page;
    this.logger = logger;
    this.autoDownload = options.autoDownload || false;
    this.autoDelete = options.autoDelete || false;
    this.downloadDir = options.downloadDir || config.DOWNLOAD_DIR;
    this.jobName = options.jobName || 'unknown';
    this.downloadDirCreated = false;
  }

  /**
   * Process post-generation actions (download and/or delete)
   * @param {number} index - Attempt index for logging
   * @returns {Promise<Object>} Result with download/delete status
   */
  async process(index) {
    const result = {
      downloaded: false,
      downloadPath: null,
      fileSize: null,
      deleted: false,
      downloadError: null,
      deleteError: null,
    };

    // Wait before starting post-processing
    await sleep(config.POST_GENERATION_DELAY);

    // Download if enabled
    if (this.autoDownload) {
      const downloadResult = await this._downloadWithRetry(index);
      result.downloaded = downloadResult.success;
      result.downloadPath = downloadResult.filePath;
      result.fileSize = downloadResult.fileSize;
      result.downloadError = downloadResult.error;
    }

    // Only delete if download succeeded (or download not enabled but delete is)
    if (this.autoDelete) {
      if (!this.autoDownload || result.downloaded) {
        await sleep(config.POST_DOWNLOAD_DELAY);
        const deleteResult = await this._deleteWithRetry(index);
        result.deleted = deleteResult.success;
        result.deleteError = deleteResult.error;
      } else {
        result.deleteError = 'Skipped - download failed';
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
}

export default PostProcessor;
