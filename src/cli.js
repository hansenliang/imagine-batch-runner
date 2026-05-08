#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { AccountManager } from './core/accounts.js';
import { ParallelRunner } from './core/parallel-runner.js';
import { AutoRunner } from './core/auto-runner.js';
import config from './config.js';

const program = new Command();

async function getGitCommitHash() {
  try {
    const headPath = path.join(config.PROJECT_ROOT, '.git', 'HEAD');
    const head = (await fs.readFile(headPath, 'utf-8')).trim();
    if (head.startsWith('ref:')) {
      const ref = head.split(' ')[1];
      const refPath = path.join(config.PROJECT_ROOT, '.git', ref);
      return (await fs.readFile(refPath, 'utf-8')).trim();
    }
    return head;
  } catch {
    return null;
  }
}

async function getCodeVersionLabel() {
  let pkgVersion = null;
  try {
    const pkgPath = path.join(config.PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    pkgVersion = pkg?.version || null;
  } catch {
    // Ignore version lookup errors
  }

  const hash = await getGitCommitHash();
  if (pkgVersion && hash) return `v${pkgVersion} (${hash.slice(0, 7)})`;
  if (pkgVersion) return `v${pkgVersion}`;
  if (hash) return hash.slice(0, 7);
  return 'unknown';
}

program
  .name('grok-batch')
  .description('Local batch image-to-video generator for Grok Imagine')
  .version('1.0.0');

/**
 * Account management commands
 */
const accounts = program.command('accounts').description('Manage account profiles');

accounts
  .command('add <alias>')
  .description('Add a new account by logging in via browser')
  .action(async (alias) => {
    try {
      const manager = new AccountManager();
      await manager.addAccount(alias);
    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

accounts
  .command('list')
  .description('List all configured accounts')
  .action(async () => {
    try {
      const manager = new AccountManager();
      await manager.listAccounts();
    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

/**
 * Run commands
 */
const run = program.command('run').description('Manage batch runs');

run
  .command('start')
  .description('Start a new batch generation run')
  .option('--config <path>', 'Load config from JSON file')
  .option('--account <alias>', 'Account alias to use')
  .option('--permalink <url>', 'Grok image permalink URL')
  .option('--prompt <text>', 'Prompt for video generation')
  .option('--count <number>', 'Number of videos to generate', String(config.DEFAULT_BATCH_SIZE))
  .option('--job-name <name>', 'Custom job name (default: auto-generated)')
  .option('--parallel <count>', 'Number of parallel workers (1-100)', '1')
  .option('--auto-download', 'Automatically download generated videos', true)
  .option('--auto-upscale', 'Automatically upscale videos to HD (requires --auto-download)', true)
  .option('--auto-delete', 'Automatically delete videos after download (requires --auto-download)', false)
  .option('--auto-extend', 'Extend each video to max duration (30s) after generation', false)
  .option('--extend-from-time <seconds>', 'Seek to this timestamp (seconds) and extend from that frame instead of from the end')
  .option('--download-max-duration-only', 'Only download/process videos that reached max duration (30s)', false)
  .option('--download-and-delete-remaining', 'Download and delete any remaining videos at end of run (forces --auto-download and --auto-delete)', false)
  .action(async (options) => {
    try {
      // Load config file if specified
      if (options.config) {
        console.log(chalk.gray(`Loading config from: ${options.config}\n`));
        const configData = JSON.parse(await fs.readFile(options.config, 'utf-8'));

        // Merge config with options, but preserve config values for defaults
        // Save original values to detect if they were explicitly set
        // Note: defaults are autoDownload=true, autoUpscale=true, autoDelete=false
        const parallelWasDefault = options.parallel === '1';
        const countWasDefault = options.count === String(config.DEFAULT_BATCH_SIZE);
        const autoDownloadWasDefault = options.autoDownload === true;
        const autoUpscaleWasDefault = options.autoUpscale === true;
        const autoDeleteWasDefault = options.autoDelete === false;

        options = { ...configData, ...options };

        // If parallel wasn't explicitly set on CLI, use config value
        if (parallelWasDefault && configData.parallel !== undefined) {
          options.parallel = configData.parallel;
        }

        // If count wasn't explicitly set on CLI, use config value
        if (countWasDefault && configData.count !== undefined) {
          options.count = configData.count;
        }

        // If auto-download wasn't explicitly set on CLI, use config value
        if (autoDownloadWasDefault && configData.autoDownload !== undefined) {
          options.autoDownload = configData.autoDownload;
        }

        // If auto-upscale wasn't explicitly set on CLI, use config value
        if (autoUpscaleWasDefault && configData.autoUpscale !== undefined) {
          options.autoUpscale = configData.autoUpscale;
        }

        // If auto-delete wasn't explicitly set on CLI, use config value
        if (autoDeleteWasDefault && configData.autoDelete !== undefined) {
          options.autoDelete = configData.autoDelete;
        }

        // If auto-extend wasn't explicitly set on CLI, use config value
        if (options.autoExtend === false && configData.autoExtend !== undefined) {
          options.autoExtend = configData.autoExtend;
        }

        // If extend-from-time wasn't explicitly set on CLI, use config value
        if (options.extendFromTime === undefined && configData.extendFromTime !== undefined) {
          options.extendFromTime = configData.extendFromTime;
        }

        // If downloadMaxDurationOnly wasn't explicitly set on CLI, use config value
        if (options.downloadMaxDurationOnly === false && configData.downloadMaxDurationOnly !== undefined) {
          options.downloadMaxDurationOnly = configData.downloadMaxDurationOnly;
        }

        // Handle downloadAndDeleteRemainingVideos from config
        if (configData.downloadAndDeleteRemainingVideos !== undefined) {
          options.downloadAndDeleteRemaining = configData.downloadAndDeleteRemainingVideos;
        }
      }

      // Validate auto-upscale requires auto-download
      if (options.autoUpscale && !options.autoDownload) {
        throw new Error('--auto-upscale requires --auto-download to be enabled');
      }

      // Validate auto-delete requires auto-download
      if (options.autoDelete && !options.autoDownload) {
        throw new Error('--auto-delete requires --auto-download to be enabled');
      }

      // Validate required fields
      if (!options.account) {
        throw new Error('--account is required (or specify in config file)');
      }
      if (!options.permalink) {
        throw new Error('--permalink is required (or specify in config file)');
      }
      if (!options.prompt) {
        throw new Error('--prompt is required (or specify in config file)');
      }

      // Validate inputs
      const batchSize = parseInt(options.count, 10);
      if (isNaN(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw new Error('Count must be between 1 and 1000');
      }

      const parallelism = parseInt(options.parallel, 10);
      if (isNaN(parallelism) || parallelism < 1 || parallelism > 100) {
        throw new Error('Parallel must be between 1 and 100');
      }

      if (!options.permalink.includes('grok.com/imagine')) {
        throw new Error('Permalink must be a Grok Imagine URL');
      }

      // Parse and validate extend-from-time
      let extendFromTime = null;
      if (options.extendFromTime !== undefined) {
        extendFromTime = parseFloat(options.extendFromTime);
        if (isNaN(extendFromTime) || extendFromTime < 0) {
          throw new Error('--extend-from-time must be a non-negative number (seconds)');
        }
      }

      // Check if account exists
      const accountManager = new AccountManager();
      const exists = await accountManager.accountExists(options.account);
      if (!exists) {
        throw new Error(`Account "${options.account}" not found. Run "grok-batch accounts add ${options.account}" first.`);
      }

      console.log(chalk.blue('\n🚀 Starting batch run...\n'));
      console.log(chalk.gray(`Code version: ${await getCodeVersionLabel()}`));
      console.log(chalk.gray(`Account: ${options.account}`));
      console.log(chalk.gray(`Permalink: ${options.permalink}`));
      console.log(chalk.gray(`Batch size: ${batchSize}`));
      console.log(chalk.gray(`Parallelism: ${parallelism} workers`));
      if (options.autoExtend) {
        console.log(chalk.gray(`Auto-extend: enabled (target ${config.MAX_VIDEO_DURATION}s)`));
      }
      if (extendFromTime != null) {
        console.log(chalk.gray(`Extend from frame: ${extendFromTime}s`));
      }
      if (options.downloadMaxDurationOnly) {
        console.log(chalk.gray(`Download max-duration only: enabled (skip download for videos < ${config.MAX_VIDEO_DURATION}s)`));
      }
      if (options.downloadAndDeleteRemaining) {
        console.log(chalk.gray(`Download and delete remaining: enabled (autoDownload and autoDelete forced to true)`));
      } else {
        if (options.autoDownload) {
          console.log(chalk.gray(`Auto-download: enabled`));
        }
        if (options.autoUpscale) {
          console.log(chalk.gray(`Auto-upscale: enabled`));
        }
        if (options.autoDelete) {
          console.log(chalk.gray(`Auto-delete: enabled`));
        }
      }
      console.log('');

      // Create and start runner (always use ParallelRunner, parallelism=1 runs sequentially)
      const runner = new ParallelRunner({
        accountAlias: options.account,
        permalink: options.permalink,
        prompt: options.prompt,
        batchSize,
        jobName: options.jobName,
        parallelism,
        autoDownload: options.autoDownload || false,
        autoUpscale: options.autoUpscale || false,
        autoDelete: options.autoDelete || false,
        autoExtend: options.autoExtend || false,
        extendFromTime,
        downloadMaxDurationOnly: options.downloadMaxDurationOnly || false,
        downloadAndDeleteRemainingVideos: options.downloadAndDeleteRemaining || false,
      });

      await runner.init();
      const summary = await runner.start();

      // Update account last used
      await accountManager.updateLastUsed(options.account);

    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

run
  .command('max-extend')
  .description('Extend an existing video to maximum duration (30s) with parallel branching')
  .option('--config <path>', 'Load config from JSON file')
  .option('--account <alias>', 'Account alias to use')
  .option('--permalink <url>', 'Existing video permalink (< 30s)')
  .option('--prompt <text>', 'Prompt for extension generations')
  .option('--count <number>', 'Number of independent extension chains', '1')
  .option('--job-name <name>', 'Custom job name (default: auto-generated)')
  .option('--parallel <count>', 'Number of parallel workers', '1')
  .option('--auto-download', 'Automatically download extended videos', true)
  .option('--auto-upscale', 'Automatically upscale videos to HD (requires --auto-download)', true)
  .option('--auto-delete', 'Automatically delete extensions after download (never deletes original)', false)
  .option('--download-max-duration-only', 'Only download/process videos that reached max duration (30s)', false)
  .option('--extend-from-time <seconds>', 'Seek to this timestamp (seconds) and extend from that frame instead of from the end')
  .action(async (options) => {
    try {
      // Load config file if specified
      if (options.config) {
        console.log(chalk.gray(`Loading config from: ${options.config}\n`));
        const configData = JSON.parse(await fs.readFile(options.config, 'utf-8'));

        const parallelWasDefault = options.parallel === '1';
        const countWasDefault = options.count === '1';
        const autoDownloadWasDefault = options.autoDownload === true;
        const autoUpscaleWasDefault = options.autoUpscale === true;
        const autoDeleteWasDefault = options.autoDelete === false;

        options = { ...configData, ...options };

        if (parallelWasDefault && configData.parallel !== undefined) {
          options.parallel = configData.parallel;
        }
        if (countWasDefault && configData.count !== undefined) {
          options.count = configData.count;
        }
        if (autoDownloadWasDefault && configData.autoDownload !== undefined) {
          options.autoDownload = configData.autoDownload;
        }
        if (autoUpscaleWasDefault && configData.autoUpscale !== undefined) {
          options.autoUpscale = configData.autoUpscale;
        }
        if (autoDeleteWasDefault && configData.autoDelete !== undefined) {
          options.autoDelete = configData.autoDelete;
        }

        // If extend-from-time wasn't explicitly set on CLI, use config value
        if (options.extendFromTime === undefined && configData.extendFromTime !== undefined) {
          options.extendFromTime = configData.extendFromTime;
        }

        // If downloadMaxDurationOnly wasn't explicitly set on CLI, use config value
        if (options.downloadMaxDurationOnly === false && configData.downloadMaxDurationOnly !== undefined) {
          options.downloadMaxDurationOnly = configData.downloadMaxDurationOnly;
        }
      }

      // Validate auto-upscale requires auto-download
      if (options.autoUpscale && !options.autoDownload) {
        throw new Error('--auto-upscale requires --auto-download to be enabled');
      }

      // Validate auto-delete requires auto-download
      if (options.autoDelete && !options.autoDownload) {
        throw new Error('--auto-delete requires --auto-download to be enabled');
      }

      // Validate required fields
      if (!options.account) {
        throw new Error('--account is required (or specify in config file)');
      }
      if (!options.permalink) {
        throw new Error('--permalink is required (or specify in config file)');
      }
      if (!options.prompt) {
        throw new Error('--prompt is required (or specify in config file)');
      }

      // Validate inputs
      const count = parseInt(options.count, 10);
      if (isNaN(count) || count < 1 || count > 1000) {
        throw new Error('Count must be between 1 and 1000');
      }

      const parallelism = parseInt(options.parallel, 10);
      if (isNaN(parallelism) || parallelism < 1 || parallelism > 100) {
        throw new Error('Parallel must be between 1 and 100');
      }

      if (!options.permalink.includes('grok.com/imagine')) {
        throw new Error('Permalink must be a Grok Imagine URL');
      }

      // Parse and validate extend-from-time
      let extendFromTime = null;
      if (options.extendFromTime !== undefined) {
        extendFromTime = parseFloat(options.extendFromTime);
        if (isNaN(extendFromTime) || extendFromTime < 0) {
          throw new Error('--extend-from-time must be a non-negative number (seconds)');
        }
      }

      // Check if account exists
      const accountManager = new AccountManager();
      const exists = await accountManager.accountExists(options.account);
      if (!exists) {
        throw new Error(`Account "${options.account}" not found. Run "grok-batch accounts add ${options.account}" first.`);
      }

      console.log(chalk.blue('\n🔄 Starting max-extend run...\n'));
      console.log(chalk.gray(`Code version: ${await getCodeVersionLabel()}`));
      console.log(chalk.gray(`Account: ${options.account}`));
      console.log(chalk.gray(`Source video: ${options.permalink}`));
      console.log(chalk.gray(`Extension chains: ${count}`));
      console.log(chalk.gray(`Parallelism: ${parallelism} workers`));
      console.log(chalk.gray(`Target: ${config.MAX_VIDEO_DURATION}s (max duration)`));
      if (extendFromTime != null) {
        console.log(chalk.gray(`Extend from frame: ${extendFromTime}s`));
      }
      if (options.downloadMaxDurationOnly) {
        console.log(chalk.gray(`Download max-duration only: enabled (skip download for videos < ${config.MAX_VIDEO_DURATION}s)`));
      }
      if (options.autoDownload) {
        console.log(chalk.gray(`Auto-download: enabled`));
      }
      if (options.autoUpscale) {
        console.log(chalk.gray(`Auto-upscale: enabled`));
      }
      if (options.autoDelete) {
        console.log(chalk.gray(`Auto-delete: enabled (extensions only, original preserved)`));
      }
      console.log('');

      const runner = new ParallelRunner({
        accountAlias: options.account,
        permalink: options.permalink,
        prompt: options.prompt,
        batchSize: count,
        jobName: options.jobName,
        parallelism,
        autoDownload: options.autoDownload || false,
        autoUpscale: options.autoUpscale || false,
        autoDelete: options.autoDelete || false,
        downloadMaxDurationOnly: options.downloadMaxDurationOnly || false,
        extendFromTime,
        maxExtendMode: true,
      });

      await runner.init();
      const summary = await runner.start();

      // Update account last used
      await accountManager.updateLastUsed(options.account);

    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

run
  .command('prune')
  .description('Delete unwanted videos from a permalink, keeping only whitelisted UUIDs (and the source)')
  .option('--account <alias>', 'Account alias to use')
  .option('--permalink <url>', 'Grok Imagine permalink to prune')
  .option('--keep <uuids>', 'Comma-separated UUIDs to keep (full UUID or 8-char prefix)')
  .option('--keep-file <path>', 'Path to file with one UUID per line')
  .option('--dry-run', 'Log intended deletions without performing them', false)
  .action(async (options) => {
    try {
      if (!options.account) {
        throw new Error('--account is required');
      }
      if (!options.permalink) {
        throw new Error('--permalink is required');
      }
      if (!options.permalink.includes('grok.com/imagine')) {
        throw new Error('Permalink must be a Grok Imagine URL');
      }

      const keepUUIDs = [];
      if (options.keep) {
        for (const u of options.keep.split(',')) {
          const trimmed = u.trim();
          if (trimmed) keepUUIDs.push(trimmed);
        }
      }
      if (options.keepFile) {
        const text = await fs.readFile(options.keepFile, 'utf-8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) keepUUIDs.push(trimmed);
        }
      }

      const accountManager = new AccountManager();
      const exists = await accountManager.accountExists(options.account);
      if (!exists) {
        throw new Error(`Account "${options.account}" not found.`);
      }

      console.log(chalk.blue('\n🧹 Starting prune run...\n'));
      console.log(chalk.gray(`Code version: ${await getCodeVersionLabel()}`));
      console.log(chalk.gray(`Account: ${options.account}`));
      console.log(chalk.gray(`Permalink: ${options.permalink}`));
      console.log(chalk.gray(`Keep set: ${keepUUIDs.length} UUID(s) (source always kept)`));
      if (options.dryRun) {
        console.log(chalk.yellow(`Mode: DRY RUN — no deletions will occur`));
      }
      console.log('');

      // Lazy imports to avoid loading playwright machinery for non-prune CLI calls.
      const { Logger } = await import('./utils/logger.js');
      const { ParallelWorker } = await import('./core/worker.js');

      const jobName = `prune_${Date.now()}`;
      const logDir = config.SINGLE_RUN_LOGS_DIR;
      const logPath = path.join(logDir, `${jobName}.log`);
      await fs.mkdir(logDir, { recursive: true });
      const logger = new Logger(logPath);

      const cacheDir = path.join(config.CACHE_DIR, jobName);
      await fs.mkdir(cacheDir, { recursive: true });

      const worker = new ParallelWorker(
        0,
        options.account,
        options.permalink,
        '', // prompt unused for prune
        null, // manifest unused — prune doesn't touch counter state
        logger,
        cacheDir
      );

      try {
        await worker.initialize();
        const stats = await worker.prune(keepUUIDs, { dryRun: options.dryRun === true });
        const verb = options.dryRun ? 'would delete' : 'deleted';
        console.log(chalk.green(`\n✓ Prune complete:`));
        console.log(chalk.gray(`  Kept:    ${stats.kept}`));
        console.log(chalk.gray(`  ${verb.charAt(0).toUpperCase() + verb.slice(1)}: ${stats.deleted}`));
        console.log(chalk.gray(`  Failed:  ${stats.failed}`));
        console.log(chalk.gray(`  Unknown: ${stats.unknown}`));
      } finally {
        await worker.shutdown();
        // Best-effort cache cleanup
        await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
      }

      await accountManager.updateLastUsed(options.account);
    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

/**
 * Auto-run commands
 */
const autorun = program.command('autorun').description('Continuous scheduled batch runs');

autorun
  .command('start')
  .description('Start continuous auto-run session')
  .option('--interval <duration>', 'Time between cycles (e.g., 30m, 1h, 2h)', '2h')
  .option('--config-dir <path>', 'Directory containing config files', config.DEFAULT_AUTORUN_CONFIG_DIR)
  .option('--dry-run', 'Validate configs without running', false)
  .option('--run-once', 'Run all configs once and exit', false)
  .action(async (options) => {
    try {
      // Parse interval to milliseconds
      const intervalMs = AutoRunner.parseInterval(options.interval);

      // Create and start auto-runner
      const runner = new AutoRunner({
        intervalMs,
        configDir: options.configDir,
        dryRun: options.dryRun,
        runOnce: options.runOnce,
      });

      await runner.start();
    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

program.parse();
