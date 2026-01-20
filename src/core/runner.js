import path from 'path';
import { BrowserManager } from './browser.js';
import { VideoGenerator } from './generator.js';
import { ManifestManager } from './manifest.js';
import { Logger } from '../utils/logger.js';
import { retry, sleep } from '../utils/retry.js';
import config from '../config.js';

/**
 * Main runner orchestrates the batch generation process
 */
export class BatchRunner {
  constructor(options) {
    this.options = options;
    this.runDir = null;
    this.logger = null;
    this.browser = null;
    this.generator = null;
    this.manifest = null;
  }

  /**
   * Initialize the runner
   */
  async init() {
    const { accountAlias, jobName } = this.options;

    // Setup run directory
    this.runDir = path.join(config.RUNS_DIR, jobName || `run_${Date.now()}`);
    this.logger = new Logger(this.runDir);

    this.logger.info('Initializing batch runner', {
      account: accountAlias,
      runDir: this.runDir,
    });

    // Initialize manifest
    this.manifest = new ManifestManager(this.runDir);
    await this.manifest.init(this.options);

    this.logger.success('Run initialized', {
      jobId: this.manifest.manifest.id,
      batchSize: this.manifest.manifest.batchSize,
    });
  }

  /**
   * Resume an existing run
   */
  async resume(runDir) {
    this.runDir = runDir;
    this.logger = new Logger(this.runDir);

    this.logger.info('Resuming existing run', { runDir });

    this.manifest = new ManifestManager(this.runDir);
    const loaded = await this.manifest.load();

    if (!loaded) {
      throw new Error('No manifest found in run directory');
    }

    this.options = {
      accountAlias: this.manifest.manifest.accountAlias,
      permalink: this.manifest.manifest.permalink,
      prompt: this.manifest.manifest.prompt,
      batchSize: this.manifest.manifest.batchSize,
      jobName: this.manifest.manifest.jobName,
    };

    const summary = this.manifest.getSummary();
    this.logger.info('Run resumed', summary);

    return summary;
  }

  /**
   * Start the batch run
   */
  async start() {
    const { accountAlias, permalink, prompt } = this.options;

    try {
      // Launch browser
      this.browser = new BrowserManager(accountAlias, this.logger);
      await this.browser.launch();

      // Navigate to permalink and validate
      await this.browser.navigateToPermalink(permalink);

      // Take initial screenshot for reference
      await this.browser.screenshot(path.join(this.runDir, 'debug', 'initial.png'));

      // Initialize generator
      this.generator = new VideoGenerator(this.browser, this.logger);

      // Update status to in progress
      await this.manifest.updateStatus('IN_PROGRESS');

      // Process items
      await this._processItems();

      // Determine final status
      const summary = this.manifest.getSummary();
      if (summary.status === 'IN_PROGRESS') {
        if (summary.completed === summary.total) {
          await this.manifest.updateStatus('COMPLETED');
        }
      }

      this.logger.success('Batch run completed', summary);
      return summary;

    } catch (error) {
      this.logger.error('Batch run failed', error);

      if (error.message?.includes('RATE_LIMIT')) {
        await this.manifest.updateStatus('STOPPED_RATE_LIMIT', error.message);
      } else if (error.message?.includes('AUTH_REQUIRED')) {
        await this.manifest.updateStatus('FAILED', 'Authentication required');
      } else {
        await this.manifest.updateStatus('FAILED', error.message);
      }

      throw error;

    } finally {
      await this.cleanup();
    }
  }

  /**
   * Process all items in the batch
   */
  async _processItems() {
    const { permalink, prompt } = this.options;
    const debugDir = path.join(this.runDir, 'debug');

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;

    while (true) {
      // Get next pending item
      const nextItem = this.manifest.getNextPending();
      if (!nextItem) {
        this.logger.info('No more pending items');
        break;
      }

      const index = nextItem.index;

      // Check rate limit before each generation
      const rateLimitStatus = await this.browser.detectRateLimit();
      if (rateLimitStatus.limited) {
        this.logger.warn('Rate limit detected, stopping run');
        await this.manifest.updateStatus(
          'STOPPED_RATE_LIMIT',
          rateLimitStatus.message || 'Rate limit detected'
        );
        break;
      }

      // Start item
      await this.manifest.startItem(index);

      // Show progress
      const summary = this.manifest.getSummary();
      await this.logger.progress(
        summary.completed,
        summary.total,
        `Generating video ${index + 1}...`
      );

      try {
        // Generate video (retry logic now handled internally in generator)
        await retry(
          async () => {
            return await this.generator.generate(index, prompt, debugDir);
          },
          {
            maxRetries: config.MAX_RETRIES,
            onRetry: async (attempt, maxRetries, delay, error) => {
              this.logger.warn(
                `[Video ${index + 1}] Attempt ${attempt}/${maxRetries} failed: ${error.message}. Retrying in ${Math.floor(delay / 1000)}s...`
              );

              // Reload permalink on retry to reset state
              await this.generator.reloadPermalink(permalink);
            },
            shouldRetry: (error) => {
              // Don't retry rate limits, auth errors, or content moderation (already retried internally)
              if (error.message?.includes('RATE_LIMIT') ||
                  error.message?.includes('AUTH_REQUIRED') ||
                  error.message?.includes('CONTENT_MODERATED')) {
                return false;
              }
              return true;
            },
          }
        );

        // Mark as completed
        await this.manifest.updateItem(index, {
          status: 'COMPLETED',
        });

        consecutiveFailures = 0;

        // Small delay between generations
        await sleep(2000);

      } catch (error) {
        // Categorize the error for better handling
        const errorType = this._categorizeError(error);

        // Mark as failed with error details
        await this.manifest.updateItem(index, {
          status: 'FAILED',
          error: error.message,
          errorType,
        });

        consecutiveFailures++;

        // Log appropriate message based on error type
        if (errorType === 'CONTENT_MODERATED') {
          this.logger.warn(
            `[Video ${index + 1}] Failed after ${config.MODERATION_RETRY_MAX} moderation retries. Moving to next item.`
          );
        } else if (errorType === 'RATE_LIMIT') {
          this.logger.error(`[Video ${index + 1}] Rate limit detected`);
          throw error; // Propagate to stop the run
        } else if (errorType === 'AUTH_REQUIRED') {
          this.logger.error(`[Video ${index + 1}] Authentication required`);
          throw error; // Propagate to stop the run
        } else if (errorType === 'TIMEOUT') {
          this.logger.warn(
            `[Video ${index + 1}] Generation timeout. Moving to next item.`
          );
        } else {
          this.logger.warn(
            `[Video ${index + 1}] Generation failed: ${error.message}. Moving to next item.`
          );
        }

        // If we hit too many consecutive failures, stop
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.logger.error(
            `Stopping run after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`
          );
          throw new Error(`Too many consecutive failures: ${error.message}`);
        }

        // Otherwise continue to next item
        this.logger.debug(`Continuing to next item after failure (type: ${errorType})`);
      }
    }
  }

  /**
   * Categorize error for better handling
   */
  _categorizeError(error) {
    const message = error.message || '';

    if (message.includes('CONTENT_MODERATED')) {
      return 'CONTENT_MODERATED';
    } else if (message.includes('RATE_LIMIT')) {
      return 'RATE_LIMIT';
    } else if (message.includes('AUTH_REQUIRED')) {
      return 'AUTH_REQUIRED';
    } else if (message.includes('TIMEOUT')) {
      return 'TIMEOUT';
    } else if (message.includes('NETWORK_ERROR')) {
      return 'NETWORK_ERROR';
    } else if (message.includes('GENERATION_ERROR')) {
      return 'GENERATION_ERROR';
    } else {
      return 'UNKNOWN';
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  /**
   * Get current status
   */
  async getStatus() {
    if (!this.manifest) {
      throw new Error('Runner not initialized');
    }
    return this.manifest.getSummary();
  }
}

export default BatchRunner;
