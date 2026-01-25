import path from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import config from '../config.js';
import { ManifestManager } from './manifest.js';
import { Logger } from '../utils/logger.js';
import { ParallelWorker } from './worker.js';

/**
 * Parallel Runner - coordinates multiple workers for concurrent video generation
 */
export class ParallelRunner {
  constructor(options) {
    const {
      accountAlias,
      permalink,
      prompt,
      batchSize = config.DEFAULT_BATCH_SIZE,
      jobName = `job_${Date.now()}`,
      parallelism = config.DEFAULT_PARALLELISM || 10,
      autoDownload = false,
      autoUpscale = false,
      autoDelete = false,
      logFilePath = null,  // Optional: caller can specify exact log file path
    } = options;

    this.accountAlias = accountAlias;
    this.permalink = permalink;
    this.prompt = prompt;
    this.batchSize = batchSize;
    this.jobName = jobName;
    this.parallelism = parallelism;
    this.autoDownload = autoDownload;
    this.autoUpscale = autoUpscale;
    this.autoDelete = autoDelete;

    // Runtime state
    // If logFilePath provided, use it; otherwise default to logs/runs/<jobName>.log
    this.logFilePath = logFilePath || path.join(config.SINGLE_RUN_LOGS_DIR, `${this.jobName}.log`);
    this.cacheDir = path.join(config.CACHE_DIR, this.jobName);  // ephemeral files (manifest, worker-profiles)
    // downloadBaseName allows consolidating downloads by base job name (without timestamp)
    const downloadFolderName = options.downloadBaseName || this.jobName;
    this.downloadDir = autoDownload ? path.join(config.DOWNLOAD_DIR, downloadFolderName) : null;
    this.manifest = null;
    this.logger = null;
    this.workers = [];
    this.rateLimitDetected = false;
    this.summaryPrinted = false;
  }

  /**
   * Initialize a new parallel run
   */
  async init() {
    // Create directories: parent of log file, cache for manifest and worker-profiles
    await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.mkdir(path.join(this.cacheDir, 'worker-profiles'), { recursive: true });

    // Initialize logger (writes to logFilePath)
    this.logger = new Logger(this.logFilePath);
    await this.logger.info('=== Parallel Run Started ===');
    await this.logger.info(`Job: ${this.jobName}`);
    await this.logger.info(`Account: ${this.accountAlias}`);
    await this.logger.info(`Batch size: ${this.batchSize}`);
    await this.logger.info(`Parallelism: ${this.parallelism} workers`);
    await this.logger.info(`Permalink: ${this.permalink}`);

    // Initialize manifest (stored in cacheDir)
    this.manifest = new ManifestManager(this.cacheDir);
    await this.manifest.init({
      accountAlias: this.accountAlias,
      permalink: this.permalink,
      prompt: this.prompt,
      batchSize: this.batchSize,
      jobName: this.jobName,
    });

    await this.logger.info(`Log file: ${this.logFilePath}`);
    await this.logger.info(`Cache directory: ${this.cacheDir}`);
    await this.logger.success('Initialization complete');
  }

  /**
   * Start parallel execution
   */
  async start() {
    try {
      await this.manifest.updateStatusAtomic('IN_PROGRESS');

      // Create workers
      for (let i = 0; i < this.parallelism; i++) {
        const worker = new ParallelWorker(
          i,
          this.accountAlias,
          this.permalink,
          this.prompt,
          this.manifest,
          this.logger,
          this.cacheDir,
          {
            autoDownload: this.autoDownload,
            autoUpscale: this.autoUpscale,
            autoDelete: this.autoDelete,
            downloadDir: this.downloadDir,
            jobName: this.jobName,
          }
        );
        this.workers.push(worker);
      }

      // Initialize all workers in parallel
      await this.logger.info(`Launching ${this.workers.length} workers...`);

      const initPromises = this.workers.map(async (worker) => {
        try {
          await worker.initialize();
        } catch (error) {
          await this.logger.error(`Worker ${worker.workerId} initialization failed`, error);
        }
      });

      await Promise.allSettled(initPromises);

      const successfulWorkers = this.workers.filter(w => w.context !== null);
      await this.logger.success(`${successfulWorkers.length} workers initialized successfully`);

      if (successfulWorkers.length === 0) {
        throw new Error('No workers initialized successfully');
      }

      // Start all workers in parallel
      await this.logger.info('Starting parallel video generation...');
      const workerPromises = successfulWorkers.map(worker =>
        worker.run().catch(error => {
          // Catch errors but don't stop other workers
          if (error.message === 'RATE_LIMIT_STOP') {
            if (!this.rateLimitDetected) {
              this.rateLimitDetected = true;
              this.logger.warn(`Rate limit detected by worker ${worker.workerId}`);
              this.logger.info('Signaling all workers to stop gracefully...');
              this.logger.info('Workers will complete their current video before shutting down');
              this.workers.forEach(w => w.stop());
            }
          }
          return { error, workerId: worker.workerId };
        })
      );

      // Wait for all workers to complete
      const results = await Promise.allSettled(workerPromises);

      // Check results
      const errors = results
        .filter(r => r.status === 'rejected' || r.value?.error)
        .map(r => r.reason || r.value?.error);

      await this.manifest.load();
      const manifestStatus = this.manifest.manifest?.status;

      if (this.rateLimitDetected || manifestStatus === 'STOPPED_RATE_LIMIT') {
        await this.logger.warn('Run stopped due to rate limit');
        await this.manifest.updateStatusAtomic('STOPPED_RATE_LIMIT', 'Rate limit detected');
      } else if (errors.length > 0 && errors.length === successfulWorkers.length) {
        // All workers failed
        await this.logger.error('All workers failed');
        await this.manifest.updateStatusAtomic('FAILED', 'All workers failed');
      } else {
        await this.manifest.updateStatusAtomic('COMPLETED');
      }

      // Print final summary
      await this._printSummary();
      this.summaryPrinted = true;

      // Return summary for CLI
      return this.manifest.getSummary();

    } catch (error) {
      await this.logger.error('Parallel run failed', error);
      await this.manifest.updateStatusAtomic('FAILED', error.message);
      throw error;
    } finally {
      if (!this.summaryPrinted) {
        await this._printSummary();
        this.summaryPrinted = true;
      }
      await this.cleanup();
    }
  }

  /**
   * Cleanup: shutdown all workers
   */
  async cleanup() {
    await this.logger.info(`Cleaning up workers (${this.workers.length})...`);
    const cleanupStart = Date.now();

    const shutdownPromises = this.workers.map(async worker => {
      try {
        await worker.shutdown();
      } catch (error) {
        await this.logger.warn(`Worker ${worker.workerId} cleanup error: ${error.message}`);
      }
    });

    await Promise.allSettled(shutdownPromises);

    const cleanupDurationMs = Date.now() - cleanupStart;
    await this.logger.success(`Cleanup complete in ${cleanupDurationMs}ms`);

    // Clean up operational files (keep run.log)
    await this.cleanupOperationalFiles();
  }

  /**
   * Clean up operational files after run completes (keeps run.log in runDir)
   */
  async cleanupOperationalFiles() {
    // Remove entire cache directory (manifest, worker-profiles, etc.)
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors - directory may not exist
    }
  }

  /**
   * Print final summary with attempt-based reporting
   * @private
   */
  async _printSummary() {
    const summary = this.manifest.getSummary();

    // Console output: color-coded emoji summary
    console.log(chalk.blue('\n📊 Run Summary:\n'));
    console.log(chalk.gray(`  Workers: ${this.parallelism}`));
    console.log(chalk.gray(`  Total attempts: ${summary.totalAttempts}`));
    console.log(chalk.green(`    ✓ Successful: ${summary.successful}`));
    if (summary.contentModerated > 0) {
      console.log(chalk.yellow(`    ⚠ Content moderated: ${summary.contentModerated}`));
    }
    if (summary.failed > 0) {
      console.log(chalk.red(`    ✗ Failed: ${summary.failed}`));
    }
    if (summary.rateLimited > 0) {
      console.log(chalk.yellow(`  Rate limited: ${summary.rateLimited} (not attempted)`));
    }
    if (this.autoDownload) {
      console.log(chalk.green(`    Downloaded: ${summary.downloaded}`));
      if (summary.downloadFailed > 0) {
        console.log(chalk.yellow(`    Download failed: ${summary.downloadFailed}`));
      }
    }
    if (this.autoUpscale) {
      console.log(chalk.green(`    Upscaled: ${summary.upscaled}`));
      if (summary.upscaleFailed > 0) {
        console.log(chalk.yellow(`    Upscale failed: ${summary.upscaleFailed}`));
      }
    }
    if (this.autoDelete) {
      console.log(chalk.green(`    Deleted: ${summary.deleted}`));
      if (summary.deleteFailed > 0) {
        console.log(chalk.yellow(`    Delete failed: ${summary.deleteFailed}`));
      }
    }
    console.log(chalk.gray(`  Status: ${summary.status}`));
    if (summary.stopReason) {
      console.log(chalk.yellow(`  Stop reason: ${summary.stopReason}`));
    }
    console.log('');

    // File log only (console already has emoji summary above)
    await this.logger.logToFileOnly('=== Run Summary ===');
    await this.logger.logToFileOnly(`Workers: ${this.parallelism}`);
    await this.logger.logToFileOnly(`Total attempts: ${summary.totalAttempts}`);
    await this.logger.logToFileOnly(`  Successful: ${summary.successful}`);
    if (summary.contentModerated > 0) {
      await this.logger.logToFileOnly(`  Content moderated: ${summary.contentModerated}`);
    }
    if (summary.failed > 0) {
      await this.logger.logToFileOnly(`  Failed: ${summary.failed}`);
    }
    if (summary.rateLimited > 0) {
      await this.logger.logToFileOnly(`Rate limited: ${summary.rateLimited} (not attempted)`);
    }
    if (this.autoDownload) {
      await this.logger.logToFileOnly(`  Downloaded: ${summary.downloaded}`);
      if (summary.downloadFailed > 0) {
        await this.logger.logToFileOnly(`  Download failed: ${summary.downloadFailed}`);
      }
    }
    if (this.autoUpscale) {
      await this.logger.logToFileOnly(`  Upscaled: ${summary.upscaled}`);
      if (summary.upscaleFailed > 0) {
        await this.logger.logToFileOnly(`  Upscale failed: ${summary.upscaleFailed}`);
      }
    }
    if (this.autoDelete) {
      await this.logger.logToFileOnly(`  Deleted: ${summary.deleted}`);
      if (summary.deleteFailed > 0) {
        await this.logger.logToFileOnly(`  Delete failed: ${summary.deleteFailed}`);
      }
    }
    await this.logger.logToFileOnly(`Status: ${summary.status}`);
    if (summary.stopReason) {
      await this.logger.logToFileOnly(`Stop reason: ${summary.stopReason}`);
    }
  }

}

export default ParallelRunner;
