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
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Ensure profile directory exists
   */
  async ensureProfile() {
    await fs.mkdir(this.profileDir, { recursive: true });
  }

  /**
   * Launch browser with persistent context
   */
  async launch() {
    await this.ensureProfile();

    this.logger.info(`Launching browser for account: ${this.accountAlias}`);

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: !config.HEADED_MODE,
      viewport: config.VIEWPORT,
      args: [
        '--disable-blink-features=AutomationControlled',
      ],
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
