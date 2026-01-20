import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import config, { selectors } from '../config.js';

/**
 * Browser manager with persistent profiles
 */
export class BrowserManager {
  constructor(accountAlias, logger) {
    this.accountAlias = accountAlias;
    this.logger = logger;
    this.profileDir = path.join(config.PROFILES_DIR, accountAlias);
    this.chromeProfileName = config.CHROME_PROFILE_NAME || 'Default';
    this.userDataDir = config.CHROME_USER_DATA_DIR
      ? path.join(config.PROFILES_DIR, `${accountAlias}-chrome`)
      : this.profileDir;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Ensure profile directory exists
   */
  async ensureProfile() {
    if (!config.CHROME_USER_DATA_DIR) {
      await fs.mkdir(this.profileDir, { recursive: true });
      return;
    }

    await fs.mkdir(this.userDataDir, { recursive: true });

    const sourceUserDataDir = config.CHROME_USER_DATA_DIR;
    const sourceProfileDir = path.join(sourceUserDataDir, this.chromeProfileName);
    const destProfileDir = path.join(this.userDataDir, this.chromeProfileName);
    const sourceLocalState = path.join(sourceUserDataDir, 'Local State');
    const destLocalState = path.join(this.userDataDir, 'Local State');

    try {
      await fs.access(sourceProfileDir);
    } catch {
      this.logger.warn(`Chrome profile not found at ${sourceProfileDir}`);
      return;
    }

    try {
      await fs.access(destProfileDir);
    } catch {
      this.logger.info('Copying Chrome profile data (one-time)...');
      await fs.cp(sourceProfileDir, destProfileDir, { recursive: true });
    }

    try {
      await fs.access(destLocalState);
    } catch {
      try {
        await fs.copyFile(sourceLocalState, destLocalState);
      } catch {
        this.logger.warn('Could not copy Chrome Local State file.');
      }
    }
  }

  /**
   * Launch browser with persistent context
   */
  async launch() {
    await this.ensureProfile();

    this.logger.info(`Launching browser for account: ${this.accountAlias}`);

    const userDataDir = this.userDataDir;
    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
    ];
    if (this.chromeProfileName) {
      launchArgs.push(`--profile-directory=${this.chromeProfileName}`);
    }

    this.context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: !config.HEADED_MODE,
      viewport: config.VIEWPORT,
      args: launchArgs,
    });

    this.browser = this.context.browser();
    this.page = this.context.pages()[0] || await this.context.newPage();

    // Set default timeouts
    this.page.setDefaultTimeout(config.ELEMENT_WAIT_TIMEOUT);
    this.page.setDefaultNavigationTimeout(config.PAGE_LOAD_TIMEOUT);

    return this.page;
  }

  /**
   * Close browser
   */
  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
      this.browser = null;
    }
  }

  /**
   * Take screenshot for debugging
   */
  async screenshot(filepath) {
    if (!this.page) return;

    try {
      await this.page.screenshot({
        path: filepath,
        fullPage: true,
      });
      this.logger.debug(`Screenshot saved: ${filepath}`);
    } catch (error) {
      this.logger.warn(`Failed to take screenshot: ${error.message}`);
    }
  }

  /**
   * Save HTML snapshot
   */
  async saveHTML(filepath) {
    if (!this.page) return;

    try {
      const html = await this.page.content();
      await fs.writeFile(filepath, html, 'utf-8');
      this.logger.debug(`HTML saved: ${filepath}`);
    } catch (error) {
      this.logger.warn(`Failed to save HTML: ${error.message}`);
    }
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated() {
    try {
      // If we see a login button, we're not authenticated
      const loginButton = await this.page.$(selectors.LOGIN_BUTTON);
      return !loginButton;
    } catch {
      return false;
    }
  }

  /**
   * Navigate to permalink and validate
   */
  async navigateToPermalink(permalink) {
    this.logger.info(`Navigating to permalink: ${permalink}`);

    await this.page.goto(permalink, {
      waitUntil: 'networkidle',
      timeout: config.PAGE_LOAD_TIMEOUT,
    });

    // Wait a bit for dynamic content
    await this.page.waitForTimeout(2000);

    // Check authentication
    const authenticated = await this.isAuthenticated();
    if (!authenticated) {
      throw new Error('AUTH_REQUIRED: Not authenticated. Please run account setup.');
    }

    // Validate we're on an Imagine page
    const url = this.page.url();
    if (!url.includes('grok.com/imagine')) {
      throw new Error(`Invalid permalink: not a Grok Imagine URL (${url})`);
    }

    this.logger.success('Permalink loaded and validated');
    return true;
  }

  /**
   * Detect if we're rate limited
   */
  async detectRateLimit() {
    try {
      // Check for rate limit toast/message
      const rateLimitElement = await this.page.$(selectors.RATE_LIMIT_TOAST);
      if (rateLimitElement) {
        const text = await rateLimitElement.textContent();
        this.logger.warn(`Rate limit detected: ${text}`);
        return { limited: true, message: text };
      }

      // Check for disabled buttons with rate limit messaging
      const makeVideoBtn = await this.page.$(selectors.MAKE_VIDEO_BUTTON);
      const redoBtn = await this.page.$(selectors.REDO_BUTTON);

      const button = makeVideoBtn || redoBtn;
      if (button) {
        const isDisabled = await button.isDisabled();
        if (isDisabled) {
          // Try to get any error/tooltip text
          const parent = await button.evaluateHandle(el => el.closest('[role="group"], div'));
          const text = await parent.textContent();
          if (text && /rate|limit|try again/i.test(text)) {
            this.logger.warn(`Rate limit detected from disabled button: ${text}`);
            return { limited: true, message: text };
          }
        }
      }

      return { limited: false, message: null };
    } catch (error) {
      this.logger.debug('Error checking rate limit', { error: error.message });
      return { limited: false, message: null };
    }
  }
}

export default BrowserManager;
