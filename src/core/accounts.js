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

    // Check if Chrome user data directory is available
    if (!config.CHROME_USER_DATA_DIR) {
      console.log(chalk.red('\n✗ Chrome user data directory not found!'));
      console.log(chalk.yellow('\nTo avoid bot detection, this tool needs to copy your Chrome profile.'));
      console.log(chalk.gray('Please install Google Chrome or set CHROME_USER_DATA_DIR environment variable.\n'));
      throw new Error('Chrome profile required for bot detection avoidance');
    }

    console.log(chalk.gray('A browser window will open with your Chrome profile.'));
    console.log(chalk.gray('Please log in to Grok, then close the browser to complete setup.\n'));

    // Always use Chrome profile with -chrome suffix
    const userDataDir = path.join(config.PROFILES_DIR, `${alias}-chrome`);
    const chromeProfileName = config.CHROME_PROFILE_NAME || 'Default';

    await fs.mkdir(userDataDir, { recursive: true });

    console.log(chalk.yellow(`Copying Chrome profile: ${chromeProfileName}`));
    console.log(chalk.gray('Make sure all Chrome windows are closed before continuing.\n'));

    const sourceUserDataDir = config.CHROME_USER_DATA_DIR;
    const sourceProfileDir = path.join(sourceUserDataDir, chromeProfileName);
    const destProfileDir = path.join(userDataDir, chromeProfileName);
    const sourceLocalState = path.join(sourceUserDataDir, 'Local State');
    const destLocalState = path.join(userDataDir, 'Local State');

    // Validate source profile exists
    try {
      await fs.access(sourceProfileDir);
    } catch {
      throw new Error(`Chrome profile "${chromeProfileName}" not found at ${sourceProfileDir}`);
    }

    // Copy profile directory if not already copied
    try {
      await fs.access(destProfileDir);
    } catch {
      console.log(chalk.gray('Copying Chrome profile data (one-time, may take a minute)...'));
      await fs.cp(sourceProfileDir, destProfileDir, { recursive: true });
    }

    // Copy Local State file if not already copied
    try {
      await fs.access(destLocalState);
    } catch {
      try {
        await fs.copyFile(sourceLocalState, destLocalState);
      } catch {
        console.log(chalk.yellow('Warning: Could not copy Chrome Local State file.'));
        console.log(chalk.gray('Session may not persist correctly.\n'));
      }
    }

    const launchArgs = ['--disable-blink-features=AutomationControlled'];
    if (chromeProfileName) {
      launchArgs.push(`--profile-directory=${chromeProfileName}`);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: false,
      viewport: config.VIEWPORT,
      args: launchArgs,
    });

    const page = context.pages()[0] || await context.newPage();

    // Navigate to Grok Imagine
    await page.goto('https://grok.com/imagine', { waitUntil: 'networkidle' });

    console.log(chalk.yellow('\nWaiting for you to log in...'));
    console.log(chalk.gray('Close the browser window when done.\n'));

    // Wait for user to close the browser
    await new Promise((resolve) => {
      context.on('close', resolve);
    });

    // Save account to list
    const accounts = await this.loadAccounts();
    accounts[alias] = {
      alias,
      profileDir: userDataDir,
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
