import config, { selectors } from '../config.js';
import { retry, retryWithCooldown, sleep } from '../utils/retry.js';
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
   * Generate a single video from the current permalink with internal retry for content moderation
   */
  async generate(index, prompt, debugDir) {
    this.logger.info(`[Video ${index + 1}] Starting generation`);
    this.logger.debug(`Prompt: "${prompt}"`);

    try {
      // Wrap the entire generation process with retry logic for content moderation
      await retryWithCooldown(
        async () => {
          // Step 1: Find and click the generation button
          await this._clickGenerationButton(index);

          // Step 2: Enter prompt (if needed)
          await this._enterPrompt(prompt, index);

          // Step 3: Wait for video generation to complete (with real-time failure detection)
          await this._waitForCompletion(index);

          return { success: true };
        },
        {
          maxRetries: config.MODERATION_RETRY_MAX,
          cooldown: config.MODERATION_RETRY_COOLDOWN,
          errorPattern: 'CONTENT_MODERATED',
          onRetry: async (attempt, maxRetries, cooldown, error) => {
            this.logger.warn(
              `[Video ${index + 1}] Content moderated (attempt ${attempt}/${maxRetries}). Retrying in ${cooldown / 1000}s...`
            );
            // Reload the page to reset state for retry
            await this.reloadPermalink(this.browser.page.url());
          },
        }
      );

      this.logger.success(`[Video ${index + 1}] Generation completed`);
      return { success: true };

    } catch (error) {
      this.logger.error(`[Video ${index + 1}] Generation failed: ${error.message}`);

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
   * Detect if content was moderated
   */
  async _detectContentModeration() {
    try {
      const moderationMsg = await this.page.$(selectors.CONTENT_MODERATED_MESSAGE);
      if (moderationMsg) {
        const text = await moderationMsg.textContent().catch(() => '');
        return { detected: true, message: text };
      }
      return { detected: false, message: null };
    } catch (error) {
      return { detected: false, message: null };
    }
  }

  /**
   * Detect rate limit from UI
   */
  async _detectRateLimit() {
    try {
      const rateLimitMsg = await this.page.$(selectors.RATE_LIMIT_TOAST);
      if (rateLimitMsg) {
        const text = await rateLimitMsg.textContent().catch(() => '');
        return { detected: true, message: text };
      }
      return { detected: false, message: null };
    } catch (error) {
      return { detected: false, message: null };
    }
  }

  /**
   * Detect network errors
   */
  async _detectNetworkError() {
    try {
      const networkError = await this.page.$(selectors.NETWORK_ERROR_MESSAGE);
      if (networkError) {
        const text = await networkError.textContent().catch(() => '');
        return { detected: true, message: text };
      }
      return { detected: false, message: null };
    } catch (error) {
      return { detected: false, message: null };
    }
  }

  /**
   * Detect general generation errors
   */
  async _detectGenerationError() {
    try {
      const genError = await this.page.$(selectors.GENERATION_ERROR_MESSAGE);
      if (genError) {
        const text = await genError.textContent().catch(() => '');
        return { detected: true, message: text };
      }
      return { detected: false, message: null };
    } catch (error) {
      return { detected: false, message: null };
    }
  }

  /**
   * Verify video is actually playable
   */
  async _verifyVideoPlayable(videoElement) {
    try {
      // 1. Check if video has src attribute
      const src = await videoElement.getAttribute('src');
      if (!src) {
        this.logger.debug('Video verification failed: no src attribute');
        return false;
      }

      // 2. Wait briefly for video to load metadata
      await sleep(1000);

      // 3. Check if video has duration > 0
      const duration = await videoElement.evaluate(v => v.duration).catch(() => 0);
      if (!duration || duration === 0 || isNaN(duration)) {
        this.logger.debug(`Video verification failed: invalid duration (${duration})`);
        return false;
      }

      // 4. Ensure no error messages are present
      const moderation = await this._detectContentModeration();
      if (moderation.detected) {
        this.logger.debug('Video verification failed: moderation message present');
        return false;
      }

      this.logger.debug(`Video verified: duration=${duration.toFixed(2)}s, src=${src.substring(0, 50)}...`);
      return true;
    } catch (error) {
      this.logger.debug(`Video verification error: ${error.message}`);
      return false;
    }
  }

  /**
   * Wait for video generation to complete with real-time failure detection
   */
  async _waitForCompletion(index) {
    this.logger.debug(`[Video ${index + 1}] Waiting for generation to complete`);

    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds
    let lastProgressLog = 0;

    while (true) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      // 1. Check for failures FIRST (highest priority)

      // Rate limit check (highest priority - stops all work)
      const rateLimit = await this._detectRateLimit();
      if (rateLimit.detected) {
        this.logger.warn(`[Video ${index + 1}] Rate limit detected: ${rateLimit.message}`);
        throw new Error(`RATE_LIMIT: ${rateLimit.message}`);
      }

      // Content moderation check
      const moderation = await this._detectContentModeration();
      if (moderation.detected) {
        this.logger.warn(`[Video ${index + 1}] Content moderation detected: ${moderation.message}`);
        throw new Error(`CONTENT_MODERATED: ${moderation.message}`);
      }

      // Network error check
      const networkError = await this._detectNetworkError();
      if (networkError.detected) {
        this.logger.warn(`[Video ${index + 1}] Network error detected: ${networkError.message}`);
        throw new Error(`NETWORK_ERROR: ${networkError.message}`);
      }

      // General generation error check
      const genError = await this._detectGenerationError();
      if (genError.detected) {
        this.logger.warn(`[Video ${index + 1}] Generation error detected: ${genError.message}`);
        throw new Error(`GENERATION_ERROR: ${genError.message}`);
      }

      // 2. Check for success
      const video = await this.page.$(selectors.VIDEO_CONTAINER);
      if (video) {
        // Video element found, verify it's actually playable
        const isPlayable = await this._verifyVideoPlayable(video);
        if (isPlayable) {
          const duration = Math.floor((Date.now() - startTime) / 1000);
          this.logger.success(`[Video ${index + 1}] Video ready and verified (took ${duration}s)`);
          return { success: true };
        }
      }

      // 3. Check for timeout
      if (elapsed > config.VIDEO_GENERATION_TIMEOUT / 1000) {
        this.logger.error(`[Video ${index + 1}] Generation timeout after ${elapsed}s`);
        throw new Error(`TIMEOUT: Video generation exceeded ${config.VIDEO_GENERATION_TIMEOUT / 1000}s`);
      }

      // 4. Log progress periodically
      if (elapsed - lastProgressLog >= 10) {
        const loading = await this.page.$(selectors.LOADING_INDICATOR);
        if (loading) {
          this.logger.debug(`[Video ${index + 1}] Still generating... (${elapsed}s)`);
        }
        lastProgressLog = elapsed;
      }

      // 5. Wait before next check
      await sleep(checkInterval);
    }
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
