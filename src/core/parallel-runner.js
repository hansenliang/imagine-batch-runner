import path from 'path';
import fs from 'fs/promises';
import config from '../config.js';
import { ManifestManager } from './manifest.js';
import { Logger } from '../utils/logger.js';
import { ParallelWorker } from './worker.js';
import { sleep } from '../utils/retry.js';

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
    } = options;

    this.accountAlias = accountAlias;
    this.permalink = permalink;
    this.prompt = prompt;
    this.batchSize = Math.min(batchSize, config.MAX_BATCH_SIZE);
    this.jobName = jobName;
    this.parallelism = Math.min(parallelism, config.MAX_PARALLELISM || 100);

    // Runtime state
    this.runDir = path.join(config.RUNS_DIR, this.jobName);
    this.manifest = null;
    this.logger = null;
    this.workers = [];
    this.rateLimitDetected = false;
  }

  /**
   * Initialize a new parallel run
   */
  async init() {
    // Create run directory
    await fs.mkdir(this.runDir, { recursive: true });
    await fs.mkdir(path.join(this.runDir, 'debug'), { recursive: true });
    await fs.mkdir(path.join(this.runDir, 'worker-profiles'), { recursive: true });

    // Initialize logger
    this.logger = new Logger(this.runDir);
    await this.logger.info('=== Parallel Run Started ===');
    await this.logger.info(`Job: ${this.jobName}`);
    await this.logger.info(`Account: ${this.accountAlias}`);
    await this.logger.info(`Batch size: ${this.batchSize}`);
    await this.logger.info(`Parallelism: ${this.parallelism} workers`);
    await this.logger.info(`Permalink: ${this.permalink}`);
    await this.logger.info(`Prompt: "${this.prompt}"`);

    // Initialize manifest
    this.manifest = new ManifestManager(this.runDir);
    await this.manifest.init({
      accountAlias: this.accountAlias,
      permalink: this.permalink,
      prompt: this.prompt,
      batchSize: this.batchSize,
      jobName: this.jobName,
    });

    await this.logger.info(`Run directory: ${this.runDir}`);
    await this.logger.success('Initialization complete');
  }

  /**
   * Resume an existing parallel run
   */
  async resume(runDir) {
    this.runDir = runDir;

    // Initialize logger
    this.logger = new Logger(this.runDir);
    await this.logger.info('=== Resuming Parallel Run ===');

    // Load manifest
    this.manifest = new ManifestManager(this.runDir);
    const manifest = await this.manifest.load();

    if (!manifest) {
      throw new Error(`No manifest found in ${this.runDir}`);
    }

    // Restore state from manifest
    this.accountAlias = manifest.accountAlias;
    this.permalink = manifest.permalink;
    this.prompt = manifest.prompt;
    this.batchSize = manifest.batchSize;
    this.jobName = manifest.jobName;

    // Reset IN_PROGRESS items to PENDING (they were interrupted)
    const inProgressItems = manifest.items.filter(i => i.status === 'IN_PROGRESS');
    if (inProgressItems.length > 0) {
      await this.logger.info(`Resetting ${inProgressItems.length} interrupted items to PENDING`);
      for (const item of inProgressItems) {
        await this.manifest.updateItem(item.index, { status: 'PENDING' });
      }
    }

    await this.manifest.updateStatus('IN_PROGRESS');

    const summary = this.manifest.getSummary();
    await this.logger.info(`Progress: ${summary.completed}/${summary.total} completed, ${summary.failed} failed`);
    await this.logger.success('Resume initialized');
  }

  /**
   * Start parallel execution
   */
  async start() {
    try {
      await this.manifest.updateStatusAtomic('IN_PROGRESS');

      await this.logger.info(`Launching ${this.parallelism} workers...`);

      // Create workers
      for (let i = 0; i < this.parallelism; i++) {
        const worker = new ParallelWorker(
          i,
          this.accountAlias,
          this.permalink,
          this.prompt,
          this.manifest,
          this.logger,
          this.runDir
        );
        this.workers.push(worker);
      }

      // Initialize workers with staggered start
      for (let i = 0; i < this.workers.length; i++) {
        const worker = this.workers[i];
        try {
          await worker.initialize();
          // Stagger launches to avoid overwhelming the system
          if (i < this.workers.length - 1) {
            await sleep(config.WORKER_STARTUP_DELAY || 1000);
          }
        } catch (error) {
          await this.logger.error(`Worker ${i} initialization failed`, error);
          // Continue with other workers
        }
      }

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
            this.rateLimitDetected = true;
            this.logger.warn('Rate limit detected, stopping all workers...');
            // Stop all workers
            this.workers.forEach(w => w.stop());
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

      if (this.rateLimitDetected) {
        await this.logger.warn('Run stopped due to rate limit');
        await this.manifest.updateStatusAtomic('STOPPED_RATE_LIMIT', 'Rate limit detected');
      } else if (errors.length > 0 && errors.length === successfulWorkers.length) {
        // All workers failed
        await this.logger.error('All workers failed');
        await this.manifest.updateStatusAtomic('FAILED', 'All workers failed');
      } else {
        // Check if all items completed
        const summary = this.manifest.getSummary();
        if (summary.remaining === 0) {
          await this.logger.success('All videos generated successfully!');
          await this.manifest.updateStatusAtomic('COMPLETED');
        } else {
          await this.logger.warn(`Run completed with ${summary.remaining} items remaining`);
          await this.manifest.updateStatusAtomic('COMPLETED');
        }
      }

      // Print final summary
      await this._printSummary();

      // Return summary for CLI
      return this.manifest.getSummary();

    } catch (error) {
      await this.logger.error('Parallel run failed', error);
      await this.manifest.updateStatusAtomic('FAILED', error.message);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Cleanup: shutdown all workers
   */
  async cleanup() {
    await this.logger.info('Cleaning up workers...');

    const shutdownPromises = this.workers.map(async worker => {
      try {
        await worker.shutdown();
      } catch (error) {
        await this.logger.warn(`Worker ${worker.workerId} cleanup error: ${error.message}`);
      }
    });

    await Promise.allSettled(shutdownPromises);

    // Cleanup worker profiles directory if empty
    try {
      const workerProfilesDir = path.join(this.runDir, 'worker-profiles');
      const remaining = await fs.readdir(workerProfilesDir);
      if (remaining.length === 0) {
        await fs.rmdir(workerProfilesDir);
        await this.logger.debug('Worker profiles directory cleaned up');
      }
    } catch (error) {
      // Ignore cleanup errors
    }

    await this.logger.success('Cleanup complete');
  }

  /**
   * Print final summary
   * @private
   */
  async _printSummary() {
    const summary = this.manifest.getSummary();

    await this.logger.info('=== Run Summary ===');
    await this.logger.info(`Total: ${summary.total}`);
    await this.logger.info(`Completed: ${summary.completed}`);
    await this.logger.info(`Failed: ${summary.failed}`);
    await this.logger.info(`Remaining: ${summary.remaining}`);
    await this.logger.info(`Status: ${summary.status}`);

    if (summary.stopReason) {
      await this.logger.info(`Stop reason: ${summary.stopReason}`);
    }

    await this.logger.info(`Run directory: ${this.runDir}`);
  }

  /**
   * Static helper: detect if a run directory contains a parallel run
   */
  static async isParallelRun(runDir) {
    try {
      const workerProfilesDir = path.join(runDir, 'worker-profiles');
      await fs.access(workerProfilesDir);
      return true;
    } catch {
      return false;
    }
  }
}

export default ParallelRunner;
