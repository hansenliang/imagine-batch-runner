import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import config from '../config.js';
import { VideoGenerator } from './generator.js';
import { sleep } from '../utils/retry.js';

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
    this.logger.info(`[Worker ${this.workerId}] Initializing...`);

    try {
      // Create worker profile directory
      await fs.mkdir(this.workerProfileDir, { recursive: true });

      // Copy account profile to worker-specific directory
      const sourceProfileDir = path.join(config.PROFILES_DIR, `${this.accountAlias}-chrome`);

      try {
        await fs.access(sourceProfileDir);
        this.logger.debug(`[Worker ${this.workerId}] Copying profile from ${sourceProfileDir}`);
        await fs.cp(sourceProfileDir, this.workerProfileDir, {
          recursive: true,
          force: true
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.logger.warn(`[Worker ${this.workerId}] Source profile not found, creating empty profile`);
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
      this.logger.info(`[Worker ${this.workerId}] Navigating to permalink...`);
      await this.page.goto(this.permalink, {
        waitUntil: 'domcontentloaded',  // Less strict than networkidle
        timeout: config.PAGE_LOAD_TIMEOUT,
      });
      await sleep(3000);  // Give time for dynamic content to load

      // Check authentication
      const authenticated = await this._isAuthenticated();
      if (!authenticated) {
        throw new Error('AUTH_REQUIRED: Not authenticated. Worker cannot proceed.');
      }

      // Create video generator with mock browser object
      const mockBrowser = {
        page: this.page,
        screenshot: async (filepath) => {
          try {
            await this.page.screenshot({ path: filepath, fullPage: true });
            this.logger.debug(`[Worker ${this.workerId}] Screenshot saved: ${filepath}`);
          } catch (error) {
            this.logger.warn(`[Worker ${this.workerId}] Failed to take screenshot: ${error.message}`);
          }
        },
        saveHTML: async (filepath) => {
          try {
            const html = await this.page.content();
            await fs.writeFile(filepath, html, 'utf-8');
            this.logger.debug(`[Worker ${this.workerId}] HTML saved: ${filepath}`);
          } catch (error) {
            this.logger.warn(`[Worker ${this.workerId}] Failed to save HTML: ${error.message}`);
          }
        },
      };

      this.generator = new VideoGenerator(mockBrowser, this.logger);

      this.logger.success(`[Worker ${this.workerId}] Initialized successfully`);
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
   * Run worker loop: claim work, generate videos, repeat until no work
   */
  async run() {
    this.isRunning = true;
    let stoppedEarly = false;
    this.logger.info(`[Worker ${this.workerId}] Starting work loop`);

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

        this.logger.info(`[Worker ${this.workerId}] Processing video ${index + 1}`);

        try {
          // Generate video (this will complete even if stop signal comes mid-generation)
          const startTime = Date.now();
          const result = await this.generator.generate(index, this.prompt, this.debugDir);
          const duration = Math.floor((Date.now() - startTime) / 1000);

          // Update manifest: COMPLETED
          await this.manifest.updateItemAtomic(
            index,
            { status: 'COMPLETED' },
            this.workerId
          );

          this.logger.success(`[Worker ${this.workerId}] Video ${index + 1} completed in ${duration}s`);

          if (result?.rateLimitDetected) {
            this.logger.warn(
              `[Worker ${this.workerId}] Rate limit detected after generation started; stopping after current video`
            );
            await this.manifest.updateStatusAtomic('STOPPED_RATE_LIMIT', 'Rate limit detected');
            this.shouldStop = true;
          }

          // Check if we should stop AFTER completing work
          if (this.shouldStop) {
            this.logger.info(`[Worker ${this.workerId}] Stop signal received, exiting after completing video ${index + 1}`);
            stoppedEarly = true;
            break;
          }

          // Small delay between generations
          await sleep(config.CLAIM_RETRY_INTERVAL || 2000);

        } catch (error) {
          this.logger.error(`[Worker ${this.workerId}] Video ${index + 1} failed`, error);

          // Check if rate limit
          if (error.message?.includes('RATE_LIMIT')) {
            this.logger.warn(`[Worker ${this.workerId}] Rate limit detected during video ${index + 1}`);
            await this.manifest.updateItemAtomic(
              index,
              {
                status: 'FAILED',
                error: error.message
              },
              this.workerId
            );
            throw new Error('RATE_LIMIT_STOP'); // Signal to coordinator
          }

          // Update manifest: FAILED (will retry if attempts < 3)
          await this.manifest.updateItemAtomic(
            index,
            {
              status: 'FAILED',
              error: error.message
            },
            this.workerId
          );

          // Continue to next item
          await sleep(config.CLAIM_RETRY_INTERVAL || 2000);
        }
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
    this.logger.info(`[Worker ${this.workerId}] Shutting down...`);

    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
        this.page = null;
        this.generator = null;
      }

      // Cleanup worker profile if configured
      if (config.WORKER_PROFILE_CLEANUP !== false) {
        try {
          await fs.rm(this.workerProfileDir, { recursive: true, force: true });
          this.logger.debug(`[Worker ${this.workerId}] Profile cleanup completed`);
        } catch (error) {
          this.logger.warn(`[Worker ${this.workerId}] Profile cleanup failed: ${error.message}`);
        }
      }

      this.logger.info(`[Worker ${this.workerId}] Shutdown complete`);
    } catch (error) {
      this.logger.error(`[Worker ${this.workerId}] Shutdown error`, error);
    }
  }
}

export default ParallelWorker;
