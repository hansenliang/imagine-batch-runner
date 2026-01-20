import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import config from '../config.js';
import chalk from 'chalk';

/**
 * Account manager for setting up persistent browser profiles
 */
export class AccountManager {
  constructor() {
    this.accountsFile = path.join(config.PROFILES_DIR, 'accounts.json');
  }

  /**
   * Load accounts list
   */
  async loadAccounts() {
    try {
      const data = await fs.readFile(this.accountsFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  /**
   * Save accounts list
   */
  async saveAccounts(accounts) {
    await fs.mkdir(config.PROFILES_DIR, { recursive: true });
    await fs.writeFile(this.accountsFile, JSON.stringify(accounts, null, 2));
  }

  /**
   * Add a new account by opening a headed browser for login
   */
  async addAccount(alias) {
    console.log(chalk.blue(`\nSetting up account: ${alias}`));
    console.log(chalk.gray('A browser window will open. Please log in to Grok.'));
    console.log(chalk.gray('Once logged in, close the browser window to complete setup.\n'));

    const profileDir = path.join(config.PROFILES_DIR, alias);
    await fs.mkdir(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: config.VIEWPORT,
    });

    const page = context.pages()[0] || await context.newPage();

    // Navigate to Grok Imagine
    await page.goto('https://grok.com/imagine', { waitUntil: 'networkidle' });

    console.log(chalk.yellow('\nWaiting for you to log in...'));
    console.log(chalk.gray('Press Ctrl+C if you want to cancel.\n'));

    // Wait for user to close the browser
    await new Promise((resolve) => {
      context.on('close', resolve);
    });

    // Save account to list
    const accounts = await this.loadAccounts();
    accounts[alias] = {
      alias,
      profileDir,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };
    await this.saveAccounts(accounts);

    console.log(chalk.green(`\n✓ Account "${alias}" setup complete!\n`));
  }

  /**
   * List all configured accounts
   */
  async listAccounts() {
    const accounts = await this.loadAccounts();
    const aliases = Object.keys(accounts);

    if (aliases.length === 0) {
      console.log(chalk.yellow('\nNo accounts configured yet.'));
      console.log(chalk.gray('Use "grok-batch accounts:add <alias>" to add an account.\n'));
      return;
    }

    console.log(chalk.blue('\nConfigured accounts:\n'));
    aliases.forEach((alias) => {
      const account = accounts[alias];
      console.log(chalk.white(`  • ${alias}`));
      console.log(chalk.gray(`    Created: ${new Date(account.createdAt).toLocaleString()}`));
      if (account.lastUsed) {
        console.log(chalk.gray(`    Last used: ${new Date(account.lastUsed).toLocaleString()}`));
      }
      console.log('');
    });
  }

  /**
   * Check if account exists
   */
  async accountExists(alias) {
    const accounts = await this.loadAccounts();
    return alias in accounts;
  }

  /**
   * Update last used timestamp
   */
  async updateLastUsed(alias) {
    const accounts = await this.loadAccounts();
    if (accounts[alias]) {
      accounts[alias].lastUsed = new Date().toISOString();
      await this.saveAccounts(accounts);
    }
  }
}

export default AccountManager;
