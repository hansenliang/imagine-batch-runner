import config, { selectors } from '../config.js';
import { retry, sleep } from '../utils/retry.js';
import path from 'path';

/**
 * Video generator - handles the generation state machine
 */
export class VideoGenerator {
  constructor(browser, logger) {
    this.browser = browser;
    this.logger = logger;
    this.page = browser.page;
  }

  /**
   * Generate a single video from the current permalink
   */
  async generate(index, prompt, debugDir) {
    this.logger.info(`[Video ${index + 1}] Starting generation`);
    this.logger.debug(`Prompt: "${prompt}"`);

    try {
      // Step 1: Find and click the generation button
      await this._clickGenerationButton(index);

      // Step 2: Enter prompt (if needed)
      await this._enterPrompt(prompt, index);

      // Step 3: Wait for video generation to complete
      await this._waitForCompletion(index);

      this.logger.success(`[Video ${index + 1}] Generation completed`);
      return { success: true };

    } catch (error) {
      this.logger.error(`[Video ${index + 1}] Generation failed`, error);

      // Save debug artifacts
      await this._saveDebugArtifacts(index, debugDir, error);

      throw error;
    }
  }

  /**
   * Click the "Make video" or "Redo" button
   */
  async _clickGenerationButton(index) {
    this.logger.debug(`[Video ${index + 1}] Looking for generation button`);

    const makeVideoBtn = await this.page.$(selectors.MAKE_VIDEO_BUTTON);
    const redoBtn = await this.page.$(selectors.REDO_BUTTON);

    let button = makeVideoBtn || redoBtn;
    let buttonLabel = null;

    if (!button) {
      // Fallback: scan visible buttons for likely labels
      const candidates = await this.page.$$('button, [role="button"]');
      const matchers = [
        /make\s+video/i,
        /create\s+video/i,
        /generate\s+video/i,
        /redo/i,
        /animate/i,
        /remake\s+video/i,
      ];

      for (const candidate of candidates) {
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        const text = await candidate.innerText().catch(() => '');
        const aria = await candidate.getAttribute('aria-label').catch(() => '');
        const label = `${text} ${aria}`.trim().replace(/\s+/g, ' ');
        if (!label) continue;

        if (matchers.some((pattern) => pattern.test(label))) {
          button = candidate;
          buttonLabel = label;
          break;
        }
      }

      if (!button) {
        const visibleLabels = [];
        for (const candidate of candidates) {
          const isVisible = await candidate.isVisible().catch(() => false);
          if (!isVisible) continue;

          const text = await candidate.innerText().catch(() => '');
          const aria = await candidate.getAttribute('aria-label').catch(() => '');
          const label = `${text} ${aria}`.trim().replace(/\s+/g, ' ');
          if (label) visibleLabels.push(label.slice(0, 80));
          if (visibleLabels.length >= 10) break;
        }

        this.logger.debug(
          `[Video ${index + 1}] Visible buttons: ${visibleLabels.join(' | ') || 'none'}`
        );
      }
    }

    if (!button) {
      throw new Error('Generation button not found (neither "Make video" nor "Redo")');
    }

    const buttonText = buttonLabel || await button.textContent();
    this.logger.debug(`[Video ${index + 1}] Found button: "${buttonText}"`);

    // Check if button is disabled (might indicate rate limit)
    const isDisabled = await button.isDisabled();
    if (isDisabled) {
      throw new Error('RATE_LIMIT: Generation button is disabled');
    }

    await button.click();
    this.logger.debug(`[Video ${index + 1}] Clicked generation button`);

    // Wait for UI to respond
    await sleep(1000);
  }

  /**
   * Enter prompt in the text field
   */
  async _enterPrompt(prompt, index) {
    try {
      // Try to find prompt input field
      const promptInput = await this.page.$(selectors.PROMPT_INPUT);

      if (promptInput) {
        // Clear existing text
        await promptInput.click({ clickCount: 3 }); // Triple-click to select all
        await promptInput.fill(prompt);
        this.logger.debug(`[Video ${index + 1}] Entered prompt`);

        // Submit the prompt (usually Enter key or a submit button)
        await promptInput.press('Enter');
        await sleep(1000);
      } else {
        // Prompt might be pre-filled from previous generation (Redo case)
        this.logger.debug(`[Video ${index + 1}] No prompt input found (might be pre-filled)`);
      }
    } catch (error) {
      this.logger.warn(`[Video ${index + 1}] Could not enter prompt: ${error.message}`);
      // Continue anyway - prompt might already be set
    }
  }

  /**
   * Wait for video generation to complete
   */
  async _waitForCompletion(index) {
    this.logger.debug(`[Video ${index + 1}] Waiting for generation to complete`);

    const startTime = Date.now();

    // Wait for the video element to appear and stabilize
    await retry(
      async () => {
        // Check for loading indicators first
        const loading = await this.page.$(selectors.LOADING_INDICATOR);
        if (loading) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          this.logger.debug(`[Video ${index + 1}] Still generating... (${elapsed}s)`);
          throw new Error('RETRY: Still generating');
        }

        // Look for video element
        const video = await this.page.$(selectors.VIDEO_CONTAINER);
        if (!video) {
          throw new Error('RETRY: Video not yet rendered');
        }

        // Video found - wait a bit to ensure it's stable
        await sleep(2000);

        // Check if it's the new video (not cached)
        const videoSrc = await video.getAttribute('src');
        if (!videoSrc) {
          throw new Error('RETRY: Video not loaded');
        }

        this.logger.debug(`[Video ${index + 1}] Video rendered`);
        return true;
      },
      {
        maxRetries: Math.floor(config.VIDEO_GENERATION_TIMEOUT / 3000), // Check every ~3 seconds
        onRetry: async (attempt, maxRetries) => {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          if (elapsed > config.VIDEO_GENERATION_TIMEOUT / 1000) {
            throw new Error(`TIMEOUT: Video generation exceeded ${config.VIDEO_GENERATION_TIMEOUT / 1000}s`);
          }
          await sleep(3000);
        },
        shouldRetry: (error) => error.message?.includes('RETRY'),
      }
    );

    const duration = Math.floor((Date.now() - startTime) / 1000);
    this.logger.success(`[Video ${index + 1}] Video ready (took ${duration}s)`);
  }

  /**
   * Save debug artifacts on failure
   */
  async _saveDebugArtifacts(index, debugDir, error) {
    try {
      const timestamp = Date.now();
      const screenshotPath = path.join(debugDir, `error_${index}_${timestamp}.png`);
      const htmlPath = path.join(debugDir, `error_${index}_${timestamp}.html`);

      await this.browser.screenshot(screenshotPath);
      await this.browser.saveHTML(htmlPath);

      this.logger.debug(`Debug artifacts saved for video ${index}`);
    } catch (saveError) {
      this.logger.warn(`Failed to save debug artifacts: ${saveError.message}`);
    }
  }

  /**
   * Reload the permalink page to reset state
   */
  async reloadPermalink(permalink) {
    this.logger.debug('Reloading permalink to reset state');
    await this.page.goto(permalink, { waitUntil: 'networkidle' });
    await sleep(2000);
  }
}

export default VideoGenerator;
