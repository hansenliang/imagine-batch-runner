#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { AccountManager } from './core/accounts.js';
import { ParallelRunner } from './core/parallel-runner.js';
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
  .action(async (options) => {
    try {
      // Load config file if specified
      if (options.config) {
        console.log(chalk.gray(`Loading config from: ${options.config}\n`));
        const configData = JSON.parse(await fs.readFile(options.config, 'utf-8'));

        // Merge config with options, but preserve config values for defaults
        // Save original values to detect if they were explicitly set
        const parallelWasDefault = options.parallel === '1';
        const countWasDefault = options.count === String(config.DEFAULT_BATCH_SIZE);

        options = { ...configData, ...options };

        // If parallel wasn't explicitly set on CLI, use config value
        if (parallelWasDefault && configData.parallel !== undefined) {
          options.parallel = configData.parallel;
        }

        // If count wasn't explicitly set on CLI, use config value
        if (countWasDefault && configData.count !== undefined) {
          options.count = configData.count;
        }
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
      console.log('');

      // Create and start runner (always use ParallelRunner, parallelism=1 runs sequentially)
      const runner = new ParallelRunner({
        accountAlias: options.account,
        permalink: options.permalink,
        prompt: options.prompt,
        batchSize,
        jobName: options.jobName,
        parallelism,
      });

      await runner.init();
      const summary = await runner.start();

      // Print summary
      console.log(chalk.blue('\n📊 Run Summary:\n'));
      console.log(chalk.gray(`  Workers: ${parallelism}`));
      console.log(chalk.gray(`  Total attempts: ${summary.totalAttempts}`));
      console.log(chalk.green(`    ✓ Successful: ${summary.successfulAttempts} (${summary.videosCompleted} videos)`));
      if (summary.failedAttempts > 0) {
        console.log(chalk.red(`    ✗ Failed: ${summary.failedAttempts} (${summary.videosFailed} videos)`));
      }
      if (summary.videosRateLimited > 0) {
        console.log(chalk.yellow(`  Rate limited: ${summary.videosRateLimited} videos (not attempted)`));
      }
      console.log(chalk.gray(`  Status: ${summary.status}`));
      if (summary.stopReason) {
        console.log(chalk.yellow(`  Stop reason: ${summary.stopReason}`));
      }
      console.log('');

      // Update account last used
      await accountManager.updateLastUsed(options.account);

    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

run
  .command('resume <runDir>')
  .description('Resume a stopped or failed run')
  .option('--parallel <count>', 'Override parallelism (for parallel runs)', null)
  .action(async (runDir, options) => {
    try {
      console.log(chalk.blue('\n🔄 Resuming run...\n'));
      console.log(chalk.gray(`Code version: ${await getCodeVersionLabel()}\n`));

      // Always use ParallelRunner for resume (handles both parallel and sequential)
      const runner = new ParallelRunner({});
      await runner.resume(runDir);

      const parallelism = runner.parallelism || 1;
      console.log(chalk.gray(`Detected run with ${parallelism} workers\n`));

      // Override parallelism if specified
      if (options.parallel) {
        const newParallelism = parseInt(options.parallel, 10);
        if (newParallelism > 0 && newParallelism <= 100) {
          runner.parallelism = newParallelism;
          console.log(chalk.gray(`Overriding parallelism to ${newParallelism} workers\n`));
        }
      }

      const summary = await runner.start();
      const finalParallelism = runner.parallelism || 1;

      // Print summary
      console.log(chalk.blue('\n📊 Run Summary:\n'));
      console.log(chalk.gray(`  Workers: ${finalParallelism}`));
      console.log(chalk.gray(`  Total attempts: ${summary.totalAttempts}`));
      console.log(chalk.green(`    ✓ Successful: ${summary.successfulAttempts} (${summary.videosCompleted} videos)`));
      if (summary.failedAttempts > 0) {
        console.log(chalk.red(`    ✗ Failed: ${summary.failedAttempts} (${summary.videosFailed} videos)`));
      }
      if (summary.videosRateLimited > 0) {
        console.log(chalk.yellow(`  Rate limited: ${summary.videosRateLimited} videos (not attempted)`));
      }
      console.log(chalk.gray(`  Status: ${summary.status}`));
      if (summary.stopReason) {
        console.log(chalk.yellow(`  Stop reason: ${summary.stopReason}`));
      }
      console.log('');

    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

run
  .command('status <runDir>')
  .description('Show status of a run')
  .action(async (runDir) => {
    try {
      const manifestPath = path.join(runDir, 'manifest.json');
      const data = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(data);
      const items = Array.isArray(manifest.items) ? manifest.items : [];
      const completedCount = items.length
        ? items.filter(item => item.status === 'COMPLETED').length
        : manifest.completedCount;
      const failedCount = items.length
        ? items.filter(item => item.status === 'FAILED').length
        : manifest.failedCount;

      console.log(chalk.blue('\n📊 Run Status:\n'));
      console.log(chalk.gray(`  Job ID: ${manifest.id}`));
      console.log(chalk.gray(`  Job Name: ${manifest.jobName}`));
      console.log(chalk.gray(`  Account: ${manifest.accountAlias}`));
      console.log(chalk.gray(`  Permalink: ${manifest.permalink}`));
      console.log('');
      console.log(chalk.white(`  Status: ${manifest.status}`));
      console.log(chalk.green(`  Completed: ${completedCount}/${manifest.batchSize}`));
      console.log(chalk.red(`  Failed: ${failedCount}`));
      console.log(chalk.yellow(`  Remaining: ${manifest.batchSize - completedCount - failedCount}`));
      console.log('');
      console.log(chalk.gray(`  Created: ${new Date(manifest.createdAt).toLocaleString()}`));
      console.log(chalk.gray(`  Updated: ${new Date(manifest.updatedAt).toLocaleString()}`));

      if (manifest.stopReason) {
        console.log('');
        console.log(chalk.yellow(`  Stop reason: ${manifest.stopReason}`));
      }

      console.log('');

    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

run
  .command('list')
  .description('List all runs')
  .action(async () => {
    try {
      const runsDir = config.RUNS_DIR;
      const entries = await fs.readdir(runsDir, { withFileTypes: true });
      const runs = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        try {
          const manifestPath = path.join(runsDir, entry.name, 'manifest.json');
          const data = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(data);
          runs.push({ dir: entry.name, manifest });
        } catch {
          // Skip invalid runs
        }
      }

      if (runs.length === 0) {
        console.log(chalk.yellow('\nNo runs found.\n'));
        return;
      }

      console.log(chalk.blue('\n📁 All Runs:\n'));
      runs.sort((a, b) => new Date(b.manifest.createdAt) - new Date(a.manifest.createdAt));

      runs.forEach(({ dir, manifest }) => {
        const items = Array.isArray(manifest.items) ? manifest.items : [];
        const completedCount = items.length
          ? items.filter(item => item.status === 'COMPLETED').length
          : manifest.completedCount;
        const statusColor = manifest.status === 'COMPLETED' ? chalk.green :
                           manifest.status === 'FAILED' ? chalk.red :
                           manifest.status === 'STOPPED_RATE_LIMIT' ? chalk.yellow :
                           chalk.white;

        console.log(chalk.white(`  ${manifest.jobName || dir}`));
        console.log(chalk.gray(`    Path: ${path.join(runsDir, dir)}`));
        console.log(statusColor(`    Status: ${manifest.status}`));
        console.log(chalk.gray(`    Progress: ${completedCount}/${manifest.batchSize}`));
        console.log(chalk.gray(`    Created: ${new Date(manifest.createdAt).toLocaleString()}`));
        console.log('');
      });

    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(chalk.yellow('\nNo runs found.\n'));
        return;
      }
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

program.parse();
