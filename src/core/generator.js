import config, { selectors } from '../config.js';

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Video generator - handles the generation state machine
 */
export class VideoGenerator {
  /**
   * @param {import('playwright').Page} page - Playwright page instance
   * @param {import('../utils/logger.js').Logger} logger - Logger instance
   */
  constructor(page, logger) {
    this.page = page;
    this.logger = logger;
  }

  /**
   * Generate a single video from the current permalink (single attempt)
   * Returns: { success, rateLimited, attempted, error }
   *
   * See claude.md "Generation Outcome Classification" for outcome definitions and logging levels.
   */
  async generate(index, prompt) {
    let lastError = null;
    const startTime = Date.now();

    try {
      // Step 1: Ensure prompt is set correctly
      await this._enterPrompt(prompt, index);

      // Step 2: Click the generation button
      await this._clickGenerationButton(index);

      // Step 3: Wait for video generation to complete
      await this._waitForCompletion(index);

      const duration = Date.now() - startTime;
      return {
        success: true,
        rateLimited: false,
        attempted: true,
        contentModerated: false,
        durationMs: duration,
      };
    } catch (error) {
      // Rate limit detected before generation starts - doesn't count as attempt
      if (error.message?.includes('RATE_LIMIT')) {
        this.logger.warn(`[Attempt ${index + 1}] Rate limit detected (not attempted)`);
        return {
          success: false,
          rateLimited: true,
          attempted: false,
          contentModerated: false,
          error: error.message,
        };
      }

      // Content moderation is an expected failure mode - already logged as WARN
      if (error.message?.includes('CONTENT_MODERATED')) {
        return {
          success: false,
          rateLimited: false,
          attempted: true,
          contentModerated: true,
          error: error.message,
          durationMs: Date.now() - startTime,
        };
      }

      lastError = error;
    }

    // Non-rate-limit error = failed attempt
    const duration = Date.now() - startTime;
    this.logger.error(`[Attempt ${index + 1}] Failed: ${lastError?.message}`);

    return {
      success: false,
      rateLimited: false,
      attempted: true,
      contentModerated: false,
      error: lastError?.message || 'Unknown error',
      durationMs: duration,
    };
  }

  /**
   * Click the "Make video" or "Redo" button
   */
  async _clickGenerationButton(index) {
    this.logger.debug(`[Attempt ${index + 1}] Looking for generation button`);

    const waitTimeout = Math.max(3000, config.ELEMENT_WAIT_TIMEOUT);
    await Promise.race([
      this.page.waitForSelector(selectors.MAKE_VIDEO_BUTTON, { timeout: waitTimeout }),
      this.page.waitForSelector(selectors.REDO_BUTTON, { timeout: waitTimeout }),
      this.page.waitForSelector(selectors.PROMPT_INPUT, { timeout: waitTimeout }),
    ]).catch(() => null);

    const makeVideoBtn = await this.page.$(selectors.MAKE_VIDEO_BUTTON);
    const redoBtn = await this.page.$(selectors.REDO_BUTTON);

    let button = makeVideoBtn || redoBtn;
    let buttonLabel = null;

    if (!button) {
      const promptButton = await this._findGenerationButtonNearPrompt(index);
      if (promptButton) {
        button = promptButton;
      }
    }

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
        /submit/i,
        /send/i,
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
          `[Attempt ${index + 1}] Visible buttons: ${visibleLabels.join(' | ') || 'none'}`
        );
      }
    }

    if (!button) {
      throw new Error('Generation button not found');
    }

    const buttonText = buttonLabel || await button.textContent();
    this.logger.debug(`[Attempt ${index + 1}] Found button: "${buttonText}"`);

    // Check if button is disabled (might indicate rate limit)
    const isDisabled = await button.isDisabled();
    if (isDisabled) {
      throw new Error('RATE_LIMIT: Generation button is disabled');
    }

    await button.click();
    this.logger.debug(`[Attempt ${index + 1}] Clicked generation button`);

    // Wait for UI to respond
    await sleep(1000);
  }

  /**
   * Find the generation button near the prompt input field
   */
  async _findGenerationButtonNearPrompt(index) {
    try {
      const promptInput = await this.page.$(selectors.PROMPT_INPUT);
      if (!promptInput) return null;

      const containerHandle = await promptInput.evaluateHandle((el) => {
        return (
          el.closest('form') ||
          el.closest('[role="form"]') ||
          el.closest('[data-slot]') ||
          el.closest('[class*="composer"]') ||
          el.closest('[class*="prompt"]') ||
          el.closest('div') ||
          el.parentElement
        );
      });
      const container = containerHandle.asElement();
      if (!container) return null;

      const candidates = await container.$$('button, [role="button"]');
      if (candidates.length === 0) return null;

      const matchers = [
        /make\s+video/i,
        /generate\s+video/i,
        /create\s+video/i,
        /redo/i,
        /animate/i,
        /submit/i,
        /send/i,
      ];

      let best = null;
      let bestScore = -1;
      let bestLabel = null;

      for (const candidate of candidates) {
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        const isDisabled = await candidate.isDisabled().catch(() => false);
        if (isDisabled) continue;

        const text = await candidate.innerText().catch(() => '');
        const aria = await candidate.getAttribute('aria-label').catch(() => '');
        const title = await candidate.getAttribute('title').catch(() => '');
        const label = `${text} ${aria} ${title}`.trim().replace(/\s+/g, ' ');
        const hasSvg = Boolean(await candidate.$('svg'));

        let score = 0;
        if (label && matchers.some((pattern) => pattern.test(label))) score += 3;
        if (aria || title) score += 2;
        if (hasSvg) score += 1;

        if (score > bestScore) {
          best = candidate;
          bestScore = score;
          bestLabel = label;
        }
      }

      if (best) {
        this.logger.debug(
          `[Attempt ${index + 1}] Found prompt-adjacent button: "${bestLabel || 'icon-only'}" (score=${bestScore})`
        );
      }

      return best;
    } catch (error) {
      this.logger.debug(`[Attempt ${index + 1}] Prompt-adjacent button lookup failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Ensure prompt is set correctly in the text field
   */
  async _enterPrompt(prompt, index) {
    // Wait for prompt input to be available
    const waitTimeout = Math.max(5000, config.ELEMENT_WAIT_TIMEOUT);
    let promptInput;
    
    try {
      await this.page.waitForSelector(selectors.PROMPT_INPUT, { timeout: waitTimeout });
      promptInput = await this.page.$(selectors.PROMPT_INPUT);
    } catch (error) {
      throw new Error(`Prompt input not found after ${waitTimeout}ms`);
    }

    if (!promptInput) {
      throw new Error('Prompt input element not found');
    }

    // Read current value
    const currentValue = await promptInput.inputValue().catch(() => '');
    
    // Only fill if value doesn't match
    if (currentValue.trim() === prompt.trim()) {
      this.logger.debug(`[Attempt ${index + 1}] Prompt already set correctly`);
      return;
    }

    // Clear and fill with correct prompt
    await promptInput.click({ clickCount: 3 }); // Triple-click to select all
    await promptInput.fill(prompt);
    
    // Verify the value was set correctly
    const verifyValue = await promptInput.inputValue().catch(() => '');
    if (verifyValue.trim() !== prompt.trim()) {
      throw new Error(`Prompt verification failed: expected "${prompt.slice(0, 50)}..." but got "${verifyValue.slice(0, 50)}..."`);
    }
    
    this.logger.debug(`[Attempt ${index + 1}] Prompt entered and verified`);
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
   * Detect progress percentage in button text (e.g., "45%", "100%")
   * Grok shows generation progress as percentage text in the button area
   */
  async _detectProgressPercentage() {
    try {
      const candidates = await this.page.$$('button, [role="button"]');

      for (const candidate of candidates) {
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        const text = await candidate.innerText().catch(() => '');
        // Match patterns like "45%", "100%", "0%"
        const percentMatch = text.match(/(\d{1,3})%/);
        if (percentMatch) {
          return {
            detected: true,
            percentage: parseInt(percentMatch[1], 10),
            text: text.trim(),
          };
        }
      }
      return { detected: false, percentage: null, text: null };
    } catch (error) {
      return { detected: false, percentage: null, text: null };
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
    const startTime = Date.now();
    const checkInterval = 2000;
    let loggedStart = false;

    while (true) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      const video = await this.page.$(selectors.VIDEO_CONTAINER);
      const percentageProgress = await this._detectProgressPercentage();

      // % > 0 means generation is actively in progress
      const generationInProgress = percentageProgress.detected && percentageProgress.percentage > 0;

      // Log once when generation starts
      if (generationInProgress && !loggedStart) {
        this.logger.info(`[Attempt ${index + 1}] Generation started: ${percentageProgress.percentage}%`);
        loggedStart = true;
      }

      // 1. Always check for video completion
      if (video) {
        const isPlayable = await this._verifyVideoPlayable(video);
        if (isPlayable) {
          this.logger.success(`[Attempt ${index + 1}] Video ready and verified`);
          return { success: true };
        }
      }

      // 2. Always check for timeout
      if (elapsed > config.VIDEO_GENERATION_TIMEOUT / 1000) {
        this.logger.error(`[Attempt ${index + 1}] Generation timeout after ${elapsed}s`);
        throw new Error(`TIMEOUT: Video generation exceeded ${config.VIDEO_GENERATION_TIMEOUT / 1000}s`);
      }

      // 3. Only check for errors when % is 0 or not visible
      // This prevents false positives from stale toasts while generation is in progress
      if (!generationInProgress) {
        const rateLimit = await this._detectRateLimit();
        if (rateLimit.detected) {
          this.logger.warn(`[Attempt ${index + 1}] Rate limit detected: ${rateLimit.message}`);
          throw new Error(`RATE_LIMIT: ${rateLimit.message}`);
        }

        const moderation = await this._detectContentModeration();
        if (moderation.detected) {
          this.logger.warn(`[Attempt ${index + 1}] Content moderation detected: ${moderation.message}`);
          throw new Error(`CONTENT_MODERATED: ${moderation.message}`);
        }

        const networkError = await this._detectNetworkError();
        if (networkError.detected) {
          this.logger.warn(`[Attempt ${index + 1}] Network error detected: ${networkError.message}`);
          throw new Error(`NETWORK_ERROR: ${networkError.message}`);
        }

        const genError = await this._detectGenerationError();
        if (genError.detected) {
          this.logger.warn(`[Attempt ${index + 1}] Generation error detected: ${genError.message}`);
          throw new Error(`GENERATION_ERROR: ${genError.message}`);
        }
      }

      await sleep(checkInterval);
    }
  }
}

export default VideoGenerator;
