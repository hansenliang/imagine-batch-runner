import path from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import config from '../config.js';
import { AccountManager } from './accounts.js';
import { ParallelRunner } from './parallel-runner.js';
import { Logger } from '../utils/logger.js';

/**
 * Format milliseconds as human-readable duration
 */
function formatDuration(ms) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h`;
  } else {
    return `${minutes}m`;
  }
}

/**
 * Format timestamp for session/job names (YYYYMMDD-HHmmss)
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
 * Format timestamp for display (YYYY-MM-DD HH:mm:ss)
 */
function formatDisplayTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * AutoRunner - orchestrates continuous scheduled batch runs
 */
export class AutoRunner {
  constructor(options) {
    const {
      intervalMs = config.DEFAULT_AUTORUN_INTERVAL,
      configDir = config.DEFAULT_AUTORUN_CONFIG_DIR,
      dryRun = false,
      runOnce = false,
    } = options;

    this.intervalMs = intervalMs;
    this.configDir = path.resolve(configDir);
    this.dryRun = dryRun;
    this.runOnce = runOnce;

    // Session state
    this.sessionStartTime = new Date();
    const timestamp = formatTimestamp(this.sessionStartTime);
    this.sessionId = `autorun_${timestamp}`;
    this.sessionDir = path.join(config.AUTORUN_LOGS_DIR, this.sessionId);
    this.summaryLogPath = path.join(this.sessionDir, 'summary.log');
    this.detailedLogsDir = path.join(this.sessionDir, 'detailed');
    this.cycleCount = 0;
    this.isRunning = false;
    this.shutdownRequested = false;

    // Scheduling
    this.nextCycleTimeout = null;
    this.nextCycleTime = null;
    this.cycleStartTime = null;

    // Logging
    this.logger = null;

    // Account manager
    this.accountManager = new AccountManager();

    // Cumulative session statistics
    this.sessionStats = {
      totalCycles: 0,
      totalAttempts: 0,
      totalSuccessful: 0,
      totalFailed: 0,
      totalContentModerated: 0,
      totalRateLimited: 0,
      totalDownloaded: 0,
      totalDownloadFailed: 0,
      totalUpscaled: 0,
      totalUpscaleFailed: 0,
      totalDeleted: 0,
      totalDeleteFailed: 0,
      parallelism: 0,
    };

    // Per-cycle summaries for the summary log
    this.cycleSummaries = [];
  }

  /**
   * Parse interval string to milliseconds
   */
  static parseInterval(str) {
    const match = str.match(/^(\d+)(m|h)$/);
    if (!match) {
      throw new Error('Invalid interval format. Use: 30m, 1h, 4h, etc.');
    }
    const value = parseInt(match[1], 10);
    const unit = match[2];

    let ms;
    if (unit === 'm') {
      ms = value * 60 * 1000;
    } else if (unit === 'h') {
      ms = value * 60 * 60 * 1000;
    }

    if (ms < config.AUTORUN_MIN_INTERVAL) {
      throw new Error(`Interval must be at least 30 minutes`);
    }

    return ms;
  }

  /**
   * Start the auto-run session
   */
  async start() {
    this.isRunning = true;

    // Setup signal handlers for graceful shutdown
    this._setupSignalHandlers();

    // Create session and detailed logs directories
    await fs.mkdir(this.sessionDir, { recursive: true });
    await fs.mkdir(this.detailedLogsDir, { recursive: true });

    // Initialize logger for session-level logging (run.log in session dir)
    this.logger = new Logger(path.join(this.sessionDir, 'run.log'));

    // Print header
    console.log(chalk.blue('\n========================================'));
    console.log(chalk.blue('     AUTO-RUN SESSION STARTED'));
    console.log(chalk.blue('========================================\n'));

    await this.logger.info('=== Auto-Run Session Started ===');
    await this.logger.info(`Session ID: ${this.sessionId}`);
    await this.logger.info(`Interval: ${formatDuration(this.intervalMs)}`);
    await this.logger.info(`Config directory: ${this.configDir}`);
    await this.logger.info(`Mode: ${this.dryRun ? 'Dry run' : this.runOnce ? 'Run once' : 'Continuous'}`);

    console.log(chalk.gray(`Session ID: ${this.sessionId}`));
    console.log(chalk.gray(`Interval: ${formatDuration(this.intervalMs)}`));
    console.log(chalk.gray(`Config directory: ${this.configDir}`));
    console.log(chalk.gray(`Summary log: ${this.summaryLogPath}`));
    console.log(chalk.gray(`Detailed logs: ${this.detailedLogsDir}`));
    console.log('');

    // Discover and validate configs
    const { validConfigs, invalidConfigs } = await this.discoverConfigs();

    if (invalidConfigs.length > 0) {
      console.log(chalk.yellow(`\nInvalid configs (${invalidConfigs.length}):`));
      for (const { file, errors } of invalidConfigs) {
        console.log(chalk.red(`  - ${file}`));
        for (const error of errors) {
          console.log(chalk.gray(`      ${error}`));
        }
      }
      await this.logger.warn(`Found ${invalidConfigs.length} invalid configs`);
    }

    if (validConfigs.length === 0) {
      console.log(chalk.red('\nNo valid configs found. Exiting.\n'));
      await this.logger.error('No valid configs found');
      return;
    }

    console.log(chalk.green(`\nValid configs (${validConfigs.length}):`));
    for (const { file, data } of validConfigs) {
      console.log(chalk.white(`  - ${file}`));
      console.log(chalk.gray(`      Account: ${data.account}, Count: ${data.count || config.DEFAULT_BATCH_SIZE}`));
    }
    console.log('');

    await this.logger.info(`Found ${validConfigs.length} valid configs`);

    // Dry run: just show what would run and exit
    if (this.dryRun) {
      console.log(chalk.yellow('\nDry run complete. No configs were executed.\n'));
      await this.logger.info('Dry run complete');
      return;
    }

    // Run initial cycle
    await this.runCycle(validConfigs);

    // If run-once mode, exit after first cycle
    if (this.runOnce) {
      console.log(chalk.blue('\nRun-once mode: exiting after first cycle.\n'));
      await this.logger.info('Run-once mode complete');
      await this._printSessionSummary();
      return;
    }

    // Schedule next cycle (continuous mode)
    if (!this.shutdownRequested) {
      this.scheduleNextCycle();

      // Keep process alive
      await new Promise((resolve) => {
        this._resolveWhenDone = resolve;
      });
    }

    await this._printSessionSummary();
  }

  /**
   * Run a single cycle of all configs
   */
  async runCycle(validConfigs = null) {
    if (this.shutdownRequested) {
      return;
    }

    this.cycleCount++;
    this.cycleStartTime = Date.now();
    this.sessionStats.totalCycles++;

    // Re-discover configs if not provided (for subsequent cycles)
    if (!validConfigs) {
      const discovery = await this.discoverConfigs();
      validConfigs = discovery.validConfigs;

      if (validConfigs.length === 0) {
        await this.logger.warn(`Cycle ${this.cycleCount}: No valid configs found, skipping`);
        console.log(chalk.yellow(`\nCycle ${this.cycleCount}: No valid configs found, skipping.\n`));
        return;
      }
    }

    console.log(chalk.blue('\n----------------------------------------'));
    console.log(chalk.blue(`  Cycle ${this.cycleCount} starting...`));
    console.log(chalk.blue('----------------------------------------\n'));

    await this.logger.info(`=== Cycle ${this.cycleCount} Starting ===`);
    await this.logger.info(`Configs to process: ${validConfigs.length}`);

    // Track cycle-level stats
    const cycleStats = {
      totalAttempts: 0,
      successful: 0,
      failed: 0,
      contentModerated: 0,
      rateLimited: 0,
      downloaded: 0,
      downloadFailed: 0,
      upscaled: 0,
      upscaleFailed: 0,
      deleted: 0,
      deleteFailed: 0,
      parallelism: 0,
      status: 'COMPLETED',
      stopReason: null,
    };

    // Run configs sequentially
    for (let i = 0; i < validConfigs.length; i++) {
      if (this.shutdownRequested) {
        await this.logger.info('Shutdown requested, stopping cycle');
        console.log(chalk.yellow('\nShutdown requested, stopping cycle...\n'));
        break;
      }

      const { file, data } = validConfigs[i];
      const timestamp = new Date().toLocaleTimeString();
      const parallelism = parseInt(data.parallel, 10) || config.DEFAULT_PARALLELISM;

      console.log(chalk.gray(`[${timestamp}] ${file}`));
      console.log(chalk.gray(`           Account: ${data.account}, Videos: ${data.count || config.DEFAULT_BATCH_SIZE}`));

      try {
        const result = await this.runConfig(file, data);

        // Accumulate stats from this run
        cycleStats.totalAttempts += result.totalAttempts;
        cycleStats.successful += result.successful;
        cycleStats.failed += result.failed;
        cycleStats.contentModerated += result.contentModerated;
        cycleStats.rateLimited += result.rateLimited;
        cycleStats.downloaded += result.downloaded || 0;
        cycleStats.downloadFailed += result.downloadFailed || 0;
        cycleStats.upscaled += result.upscaled || 0;
        cycleStats.upscaleFailed += result.upscaleFailed || 0;
        cycleStats.deleted += result.deleted || 0;
        cycleStats.deleteFailed += result.deleteFailed || 0;
        cycleStats.parallelism = Math.max(cycleStats.parallelism, parallelism);

        if (result.status === 'COMPLETED') {
          console.log(chalk.green(`           -> Completed (${result.successful}/${result.totalVideos})\n`));
        } else if (result.status === 'STOPPED_RATE_LIMIT') {
          cycleStats.status = 'STOPPED_RATE_LIMIT';
          cycleStats.stopReason = 'Rate limit detected';
          console.log(chalk.yellow(`           -> Rate limited (${result.successful}/${result.totalVideos})\n`));
        } else {
          cycleStats.status = 'FAILED';
          cycleStats.stopReason = result.error || 'Unknown error';
          console.log(chalk.red(`           -> Failed: ${result.error || 'Unknown error'}\n`));
        }
      } catch (error) {
        cycleStats.failed++;
        cycleStats.status = 'FAILED';
        cycleStats.stopReason = error.message;
        console.log(chalk.red(`           -> Error: ${error.message}\n`));
        await this.logger.error(`Config ${file} error`, error);
      }
    }

    // Update cumulative session stats
    this.sessionStats.totalAttempts += cycleStats.totalAttempts;
    this.sessionStats.totalSuccessful += cycleStats.successful;
    this.sessionStats.totalFailed += cycleStats.failed;
    this.sessionStats.totalContentModerated += cycleStats.contentModerated;
    this.sessionStats.totalRateLimited += cycleStats.rateLimited;
    this.sessionStats.totalDownloaded += cycleStats.downloaded;
    this.sessionStats.totalDownloadFailed += cycleStats.downloadFailed;
    this.sessionStats.totalUpscaled += cycleStats.upscaled;
    this.sessionStats.totalUpscaleFailed += cycleStats.upscaleFailed;
    this.sessionStats.totalDeleted += cycleStats.deleted;
    this.sessionStats.totalDeleteFailed += cycleStats.deleteFailed;
    this.sessionStats.parallelism = Math.max(this.sessionStats.parallelism, cycleStats.parallelism);

    // Print cycle summary
    const cycleDuration = Date.now() - this.cycleStartTime;
    console.log(chalk.blue('\n----------------------------------------'));
    console.log(chalk.blue(`  Cycle ${this.cycleCount} Complete`));
    console.log(chalk.gray(`  Duration: ${formatDuration(cycleDuration)}`));
    console.log(chalk.green(`  Successful: ${cycleStats.successful}`));
    if (cycleStats.contentModerated > 0) {
      console.log(chalk.yellow(`  Content moderated: ${cycleStats.contentModerated}`));
    }
    if (cycleStats.failed > 0) {
      console.log(chalk.red(`  Failed: ${cycleStats.failed}`));
    }
    if (cycleStats.rateLimited > 0) {
      console.log(chalk.yellow(`  Rate limited: ${cycleStats.rateLimited}`));
    }
    console.log(chalk.blue('----------------------------------------\n'));

    await this.logger.info(`Cycle ${this.cycleCount} complete`);
    await this.logger.info(`  Duration: ${formatDuration(cycleDuration)}`);
    await this.logger.info(`  Successful: ${cycleStats.successful}, Content moderated: ${cycleStats.contentModerated}, Failed: ${cycleStats.failed}, Rate limited: ${cycleStats.rateLimited}`);

    // Write summary log with TOTALS and per-cycle summaries
    await this._writeSummaryLog(cycleStats);
  }

  /**
   * Run a single config using ParallelRunner
   */
  async runConfig(file, configData) {
    // Generate job name: use config's jobName if present, otherwise use filename
    const baseName = configData.jobName || path.basename(file, '.json');
    const timestamp = formatTimestamp();
    const jobName = `${baseName}-${timestamp}`;

    // Detailed log goes in the session's detailed/ directory
    const logFilePath = path.join(this.detailedLogsDir, `${jobName}.log`);

    // Extract config values with defaults
    const batchSize = parseInt(configData.count, 10) || config.DEFAULT_BATCH_SIZE;
    const parallelism = parseInt(configData.parallel, 10) || config.DEFAULT_PARALLELISM;

    await this.logger.info(`Starting config: ${file}`);
    await this.logger.info(`  Job name: ${jobName}`);
    await this.logger.info(`  Account: ${configData.account}`);
    await this.logger.info(`  Batch size: ${batchSize}, Parallelism: ${parallelism}`);

    try {
      // Create and initialize runner
      const runner = new ParallelRunner({
        accountAlias: configData.account,
        permalink: configData.permalink,
        prompt: configData.prompt,
        batchSize,
        jobName,
        parallelism,
        autoDownload: configData.autoDownload !== false,  // default true
        autoUpscale: configData.autoUpscale !== false,    // default true
        autoDelete: configData.autoDelete || false,       // default false
        logFilePath,  // Pass the detailed log path
      });

      await runner.init();
      const summary = await runner.start();

      // Update account last used
      await this.accountManager.updateLastUsed(configData.account);

      await this.logger.info(`Config ${file} completed: ${summary.status}`);

      return {
        status: summary.status,
        successful: summary.successful,
        totalVideos: batchSize,
        totalAttempts: summary.totalAttempts || 0,
        failed: summary.failed || 0,
        contentModerated: summary.contentModerated || 0,
        rateLimited: summary.rateLimited || 0,
        downloaded: summary.downloaded || 0,
        downloadFailed: summary.downloadFailed || 0,
        upscaled: summary.upscaled || 0,
        upscaleFailed: summary.upscaleFailed || 0,
        deleted: summary.deleted || 0,
        deleteFailed: summary.deleteFailed || 0,
        stopReason: summary.stopReason,
      };
    } catch (error) {
      await this.logger.error(`Config ${file} failed`, error);
      return {
        status: 'FAILED',
        error: error.message,
        successful: 0,
        totalVideos: batchSize,
        totalAttempts: 0,
        failed: 0,
        contentModerated: 0,
        rateLimited: 0,
      };
    }
  }

  /**
   * Discover and validate all config files in the config directory
   */
  async discoverConfigs() {
    const validConfigs = [];
    const invalidConfigs = [];

    // Check if directory exists
    try {
      await fs.access(this.configDir);
    } catch {
      throw new Error(`Config directory not found: ${this.configDir}`);
    }

    // Read all files in directory
    const files = await fs.readdir(this.configDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    if (jsonFiles.length === 0) {
      throw new Error(`No JSON config files found in ${this.configDir}`);
    }

    // Validate each config
    for (const file of jsonFiles) {
      const configPath = path.join(this.configDir, file);
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        const configData = JSON.parse(content);

        const validation = await this.validateConfig(configData, file);
        if (validation.valid) {
          validConfigs.push({ path: configPath, file, data: configData });
        } else {
          invalidConfigs.push({ path: configPath, file, errors: validation.errors });
        }
      } catch (error) {
        invalidConfigs.push({
          path: configPath,
          file,
          errors: [`Parse error: ${error.message}`],
        });
      }
    }

    return { validConfigs, invalidConfigs };
  }

  /**
   * Validate a single config
   */
  async validateConfig(configData, filename) {
    const errors = [];

    // Required fields
    if (!configData.account) {
      errors.push('Missing required field: account');
    }
    if (!configData.permalink) {
      errors.push('Missing required field: permalink');
    }
    if (!configData.prompt) {
      errors.push('Missing required field: prompt');
    }

    // Permalink format
    if (configData.permalink && !configData.permalink.includes('grok.com/imagine')) {
      errors.push('Permalink must be a Grok Imagine URL');
    }

    // Count validation
    if (configData.count !== undefined) {
      const count = parseInt(configData.count, 10);
      if (isNaN(count) || count < 1 || count > 1000) {
        errors.push('Count must be between 1 and 1000');
      }
    }

    // Parallel validation
    if (configData.parallel !== undefined) {
      const parallel = parseInt(configData.parallel, 10);
      if (isNaN(parallel) || parallel < 1 || parallel > 100) {
        errors.push('Parallel must be between 1 and 100');
      }
    }

    // Account exists check
    if (configData.account) {
      const exists = await this.accountManager.accountExists(configData.account);
      if (!exists) {
        errors.push(`Account "${configData.account}" not found`);
      }
    }

    // Auto-upscale requires auto-download
    if (configData.autoUpscale && configData.autoDownload === false) {
      errors.push('autoUpscale requires autoDownload to be enabled');
    }

    // Auto-delete requires auto-download
    if (configData.autoDelete && configData.autoDownload === false) {
      errors.push('autoDelete requires autoDownload to be enabled');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Schedule the next cycle
   */
  scheduleNextCycle() {
    if (this.shutdownRequested) {
      return;
    }

    const now = Date.now();
    const idealNextStart = this.cycleStartTime + this.intervalMs;

    let waitMs;
    if (idealNextStart <= now) {
      // Cycle took longer than interval, start next cycle soon
      console.log(chalk.yellow('Cycle took longer than interval. Starting next cycle in 1 minute.'));
      this.logger.warn('Cycle took longer than interval');
      waitMs = 60 * 1000; // 1 minute buffer
    } else {
      waitMs = idealNextStart - now;
    }

    this.nextCycleTime = new Date(now + waitMs);

    console.log(chalk.gray(`Next cycle at: ${this.nextCycleTime.toLocaleString()}`));
    console.log(chalk.gray(`              (in ${formatDuration(waitMs)})`));
    console.log(chalk.gray('\nPress Ctrl+C to stop.\n'));

    this.nextCycleTimeout = setTimeout(async () => {
      try {
        await this.runCycle();
      } catch (error) {
        await this.logger.error('Cycle error', error);
        console.error(chalk.red(`\nCycle error: ${error.message}\n`));
      }

      // Schedule next cycle after this one completes
      if (!this.shutdownRequested && !this.runOnce) {
        this.scheduleNextCycle();
      }
    }, waitMs);
  }

  /**
   * Stop the auto-run session gracefully
   */
  async stop() {
    this.shutdownRequested = true;

    // Cancel scheduled next cycle
    if (this.nextCycleTimeout) {
      clearTimeout(this.nextCycleTimeout);
      this.nextCycleTimeout = null;
    }

    await this.logger.info('Shutdown initiated');

    // Resolve the waiting promise to exit
    if (this._resolveWhenDone) {
      this._resolveWhenDone();
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  _setupSignalHandlers() {
    let forceShutdownWarned = false;

    const shutdown = async (signal) => {
      if (this.shutdownRequested) {
        if (!forceShutdownWarned) {
          console.log(chalk.yellow('\nForce shutdown. Exiting immediately.\n'));
          forceShutdownWarned = true;
        }
        process.exit(1);
      }

      console.log(chalk.yellow(`\n${signal} received. Graceful shutdown initiated...`));
      console.log(chalk.gray('Waiting for current config to complete.'));
      console.log(chalk.gray('Press Ctrl+C again to force quit.\n'));

      await this.stop();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  /**
   * Write the summary log file with TOTALS at top and per-cycle summaries below
   */
  async _writeSummaryLog(cycleStats) {
    const now = new Date();
    const cycleTimestamp = formatDisplayTimestamp(now);

    // Store this cycle's summary
    this.cycleSummaries.push({
      cycleNumber: this.cycleCount,
      timestamp: cycleTimestamp,
      stats: { ...cycleStats },
    });

    // Build the summary file content
    const lines = [];

    // TOTALS section at top
    lines.push('---');
    lines.push(`📊 AUTORUN TOTALS (${this.sessionStats.totalCycles} cycles, last updated ${cycleTimestamp}):`);
    lines.push(`  Session started: ${formatDisplayTimestamp(this.sessionStartTime)}`);
    lines.push(`  Workers: ${this.sessionStats.parallelism}`);
    lines.push(`  Total attempts: ${this.sessionStats.totalAttempts}`);
    lines.push(`    ✓ Successful: ${this.sessionStats.totalSuccessful}`);
    if (this.sessionStats.totalContentModerated > 0) {
      lines.push(`    ⚠ Content moderated: ${this.sessionStats.totalContentModerated}`);
    }
    if (this.sessionStats.totalFailed > 0) {
      lines.push(`    ✗ Failed: ${this.sessionStats.totalFailed}`);
    }
    if (this.sessionStats.totalRateLimited > 0) {
      lines.push(`  Rate limited: ${this.sessionStats.totalRateLimited}`);
    }
    lines.push('---');
    lines.push('');

    // Per-cycle summaries (newest first)
    for (let i = this.cycleSummaries.length - 1; i >= 0; i--) {
      const cycle = this.cycleSummaries[i];
      lines.push(`--- Cycle ${cycle.cycleNumber} (${cycle.timestamp}) ---`);
      lines.push('📊 Auto-Run Summary:');
      lines.push(`  Workers: ${cycle.stats.parallelism}`);
      lines.push(`  Total attempts: ${cycle.stats.totalAttempts}`);
      lines.push(`    ✓ Successful: ${cycle.stats.successful}`);
      if (cycle.stats.contentModerated > 0) {
        lines.push(`    ⚠ Content moderated: ${cycle.stats.contentModerated}`);
      }
      if (cycle.stats.failed > 0) {
        lines.push(`    ✗ Failed: ${cycle.stats.failed}`);
      }
      if (cycle.stats.rateLimited > 0) {
        lines.push(`  Rate limited: ${cycle.stats.rateLimited}`);
      }
      lines.push(`  Status: ${cycle.stats.status}`);
      if (cycle.stats.stopReason) {
        lines.push(`  Stop reason: ${cycle.stats.stopReason}`);
      }
      lines.push('---');
      lines.push('');
    }

    // Write the entire file
    try {
      await fs.writeFile(this.summaryLogPath, lines.join('\n'), 'utf-8');
    } catch (error) {
      await this.logger.error('Failed to write summary log', error);
    }
  }

  /**
   * Print final session summary
   */
  async _printSessionSummary() {
    console.log(chalk.blue('\n========================================'));
    console.log(chalk.blue('     SESSION SUMMARY'));
    console.log(chalk.blue('========================================\n'));

    console.log(chalk.gray(`Session ID: ${this.sessionId}`));
    console.log(chalk.gray(`Total cycles: ${this.sessionStats.totalCycles}`));
    console.log(chalk.gray(`Total attempts: ${this.sessionStats.totalAttempts}`));
    console.log(chalk.green(`  Successful: ${this.sessionStats.totalSuccessful}`));
    if (this.sessionStats.totalContentModerated > 0) {
      console.log(chalk.yellow(`  Content moderated: ${this.sessionStats.totalContentModerated}`));
    }
    if (this.sessionStats.totalFailed > 0) {
      console.log(chalk.red(`  Failed: ${this.sessionStats.totalFailed}`));
    }
    if (this.sessionStats.totalRateLimited > 0) {
      console.log(chalk.yellow(`  Rate limited: ${this.sessionStats.totalRateLimited}`));
    }
    if (this.sessionStats.totalDownloaded > 0 || this.sessionStats.totalDownloadFailed > 0) {
      console.log(chalk.green(`  Downloaded: ${this.sessionStats.totalDownloaded}`));
      if (this.sessionStats.totalDownloadFailed > 0) {
        console.log(chalk.yellow(`  Download failed: ${this.sessionStats.totalDownloadFailed}`));
      }
    }
    if (this.sessionStats.totalUpscaled > 0 || this.sessionStats.totalUpscaleFailed > 0) {
      console.log(chalk.green(`  Upscaled: ${this.sessionStats.totalUpscaled}`));
      if (this.sessionStats.totalUpscaleFailed > 0) {
        console.log(chalk.yellow(`  Upscale failed: ${this.sessionStats.totalUpscaleFailed}`));
      }
    }
    if (this.sessionStats.totalDeleted > 0 || this.sessionStats.totalDeleteFailed > 0) {
      console.log(chalk.green(`  Deleted: ${this.sessionStats.totalDeleted}`));
      if (this.sessionStats.totalDeleteFailed > 0) {
        console.log(chalk.yellow(`  Delete failed: ${this.sessionStats.totalDeleteFailed}`));
      }
    }
    console.log(chalk.gray(`\nSummary log: ${this.summaryLogPath}`));
    console.log(chalk.gray(`Detailed logs: ${this.sessionDir}\n`));

    await this.logger.info('=== Session Summary ===');
    await this.logger.info(`Total cycles: ${this.sessionStats.totalCycles}`);
    await this.logger.info(`Total attempts: ${this.sessionStats.totalAttempts}`);
    await this.logger.info(`  Successful: ${this.sessionStats.totalSuccessful}`);
    await this.logger.info(`  Content moderated: ${this.sessionStats.totalContentModerated}`);
    await this.logger.info(`  Failed: ${this.sessionStats.totalFailed}`);
    await this.logger.info(`  Rate limited: ${this.sessionStats.totalRateLimited}`);
    if (this.sessionStats.totalDownloaded > 0 || this.sessionStats.totalDownloadFailed > 0) {
      await this.logger.info(`  Downloaded: ${this.sessionStats.totalDownloaded}`);
      await this.logger.info(`  Download failed: ${this.sessionStats.totalDownloadFailed}`);
    }
    if (this.sessionStats.totalUpscaled > 0 || this.sessionStats.totalUpscaleFailed > 0) {
      await this.logger.info(`  Upscaled: ${this.sessionStats.totalUpscaled}`);
      await this.logger.info(`  Upscale failed: ${this.sessionStats.totalUpscaleFailed}`);
    }
    if (this.sessionStats.totalDeleted > 0 || this.sessionStats.totalDeleteFailed > 0) {
      await this.logger.info(`  Deleted: ${this.sessionStats.totalDeleted}`);
      await this.logger.info(`  Delete failed: ${this.sessionStats.totalDeleteFailed}`);
    }
  }
}

export default AutoRunner;
