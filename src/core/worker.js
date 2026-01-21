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
  constructor(workerId, accountAlias, permalink, prompt, manifest, logger, runDir) {
    this.workerId = workerId;
    this.accountAlias = accountAlias;
    this.permalink = permalink;
    this.prompt = prompt;
    this.manifest = manifest;
    this.logger = logger;
    this.runDir = runDir;

    // Browser resources
    this.context = null;
    this.page = null;
    this.generator = null;

    // Worker-specific paths
    this.workerProfileDir = path.join(runDir, 'worker-profiles', `worker-${workerId}`);
    this.debugDir = path.join(runDir, 'debug');

    // State
    this.isRunning = false;
    this.shouldStop = false;
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

      // Create video generator
      const mockBrowser = {
        page: this.page,
        screenshot: async (filepath) => {
          try {
            await this.page.screenshot({ path: filepath, fullPage: true });
          } catch (error) {
            this.logger.warn(`[Worker ${this.workerId}] Failed to take screenshot: ${error.message}`);
          }
        },
        saveHTML: async (filepath) => {
          try {
            const html = await this.page.content();
            await fs.writeFile(filepath, html, 'utf-8');
          } catch (error) {
            this.logger.warn(`[Worker ${this.workerId}] Failed to save HTML: ${error.message}`);
          }
        },
      };

      this.generator = new VideoGenerator(mockBrowser, this.logger);

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
        const result = await this.generator.generate(index, this.prompt, this.debugDir);
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

          this.logger.success(
            `[Worker ${this.workerId}] Attempt ${index + 1}: Success in ${duration}s - ${this.page.url()}`
          );
        } else {
          // Handle failure
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
            `[Worker ${this.workerId}] Attempt ${index + 1}: Failed`
          );
        }

        if (result.rateLimitAfterStart) {
          this.logger.warn(
            `[Worker ${this.workerId}] Rate limit detected after start, stopping after attempt ${index + 1}`
          );
          throw new Error('RATE_LIMIT_STOP');
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
