#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { AccountManager } from './core/accounts.js';
import { BatchRunner } from './core/runner.js';
import config from './config.js';

const program = new Command();

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
  .requiredOption('--account <alias>', 'Account alias to use')
  .requiredOption('--permalink <url>', 'Grok image permalink URL')
  .requiredOption('--prompt <text>', 'Prompt for video generation')
  .option('--count <number>', 'Number of videos to generate', String(config.DEFAULT_BATCH_SIZE))
  .option('--job-name <name>', 'Custom job name (default: auto-generated)')
  .action(async (options) => {
    try {
      // Validate inputs
      const batchSize = parseInt(options.count, 10);
      if (isNaN(batchSize) || batchSize < 1 || batchSize > config.MAX_BATCH_SIZE) {
        throw new Error(`Count must be between 1 and ${config.MAX_BATCH_SIZE}`);
      }

      if (!options.permalink.includes('grok.com/imagine')) {
        throw new Error('Permalink must be a Grok Imagine URL');
      }

      // Check if account exists
      const accountManager = new AccountManager();
      const exists = await accountManager.accountExists(options.account);
      if (!exists) {
        throw new Error(`Account "${options.account}" not found. Run "grok-batch accounts:add ${options.account}" first.`);
      }

      console.log(chalk.blue('\n🚀 Starting batch run...\n'));
      console.log(chalk.gray(`Account: ${options.account}`));
      console.log(chalk.gray(`Permalink: ${options.permalink}`));
      console.log(chalk.gray(`Prompt: "${options.prompt}"`));
      console.log(chalk.gray(`Batch size: ${batchSize}`));
      console.log('');

      // Create and start runner
      const runner = new BatchRunner({
        accountAlias: options.account,
        permalink: options.permalink,
        prompt: options.prompt,
        batchSize,
        jobName: options.jobName,
      });

      await runner.init();
      const summary = await runner.start();

      // Print summary
      console.log(chalk.blue('\n📊 Run Summary:\n'));
      console.log(chalk.green(`  ✓ Completed: ${summary.completed}/${summary.total}`));
      if (summary.failed > 0) {
        console.log(chalk.red(`  ✗ Failed: ${summary.failed}`));
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
  .action(async (runDir) => {
    try {
      console.log(chalk.blue('\n🔄 Resuming run...\n'));

      const runner = new BatchRunner({});
      await runner.resume(runDir);

      const summary = await runner.start();

      // Print summary
      console.log(chalk.blue('\n📊 Run Summary:\n'));
      console.log(chalk.green(`  ✓ Completed: ${summary.completed}/${summary.total}`));
      if (summary.failed > 0) {
        console.log(chalk.red(`  ✗ Failed: ${summary.failed}`));
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

      console.log(chalk.blue('\n📊 Run Status:\n'));
      console.log(chalk.gray(`  Job ID: ${manifest.id}`));
      console.log(chalk.gray(`  Job Name: ${manifest.jobName}`));
      console.log(chalk.gray(`  Account: ${manifest.accountAlias}`));
      console.log(chalk.gray(`  Permalink: ${manifest.permalink}`));
      console.log(chalk.gray(`  Prompt: "${manifest.prompt}"`));
      console.log('');
      console.log(chalk.white(`  Status: ${manifest.status}`));
      console.log(chalk.green(`  Completed: ${manifest.completedCount}/${manifest.batchSize}`));
      console.log(chalk.red(`  Failed: ${manifest.failedCount}`));
      console.log(chalk.yellow(`  Remaining: ${manifest.batchSize - manifest.completedCount - manifest.failedCount}`));
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
        const statusColor = manifest.status === 'COMPLETED' ? chalk.green :
                           manifest.status === 'FAILED' ? chalk.red :
                           manifest.status === 'STOPPED_RATE_LIMIT' ? chalk.yellow :
                           chalk.white;

        console.log(chalk.white(`  ${manifest.jobName || dir}`));
        console.log(chalk.gray(`    Path: ${path.join(runsDir, dir)}`));
        console.log(statusColor(`    Status: ${manifest.status}`));
        console.log(chalk.gray(`    Progress: ${manifest.completedCount}/${manifest.batchSize}`));
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
