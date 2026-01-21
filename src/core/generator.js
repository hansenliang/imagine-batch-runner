import config, { selectors } from '../config.js';
import path from 'path';

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
  constructor(browser, logger) {
    this.browser = browser;
    this.logger = logger;
    this.page = browser.page;
  }

  /**
   * Generate a single video from the current permalink (single attempt)
   * Returns: { success, rateLimited, attempted, error }
   */
  async generate(index, prompt, debugDir) {
    let lastError = null;
    const startTime = Date.now();

    try {
      // Step 1: Find and click the generation button
      await this._clickGenerationButton(index);

      // Step 2: Enter prompt (if needed)
      await this._enterPrompt(prompt, index);

      // Step 3: Wait for video generation to complete
      await this._waitForCompletion(index);

      const duration = Date.now() - startTime;
      return {
        success: true,
        rateLimited: false,
        attempted: true,
        durationMs: duration,
      };
    } catch (error) {
      // Rate limit detected before generation starts - doesn't count as attempt
      if (error.message?.includes('RATE_LIMIT')) {
        this.logger.warn(`[Attempt ${index + 1}] Rate limit detected (not attempted)`);
        await this._saveDebugArtifacts(index, debugDir, error);
        return {
          success: false,
          rateLimited: true,
          attempted: false,
          error: error.message,
        };
      }

      lastError = error;
    }

    // Non-rate-limit error = failed attempt
    const duration = Date.now() - startTime;
    this.logger.error(`[Attempt ${index + 1}] Failed: ${lastError?.message}`);
    await this._saveDebugArtifacts(index, debugDir, lastError);

    return {
      success: false,
      rateLimited: false,
      attempted: true,
      error: lastError?.message || 'Unknown error',
      durationMs: duration,
    };
  }

  /**
   * Click the "Make video" or "Redo" button
   */
  async _clickGenerationButton(index) {
    this.logger.debug(`[Attempt ${index + 1}] Looking for generation button`);

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
        this.logger.debug(`[Attempt ${index + 1}] Entered prompt`);

        // Submit the prompt (usually Enter key or a submit button)
        await promptInput.press('Enter');
        await sleep(1000);
      } else {
        // Prompt might be pre-filled from previous generation (Redo case)
        this.logger.debug(`[Attempt ${index + 1}] No prompt input found (might be pre-filled)`);
      }
    } catch (error) {
      this.logger.warn(`[Attempt ${index + 1}] Could not enter prompt: ${error.message}`);
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
    this.logger.debug(`[Attempt ${index + 1}] Waiting for generation to complete`);

    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds
    let lastProgressLog = 0;
    let sawGenerationSignal = false;

    while (true) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      // 1. Check for failures FIRST (highest priority)

      const loading = await this.page.$(selectors.LOADING_INDICATOR);
      const progress = await this.page.$(selectors.VIDEO_PROGRESS_BAR);
      const video = await this.page.$(selectors.VIDEO_CONTAINER);
      if (loading || progress || video) {
        sawGenerationSignal = true;
      }

      // Rate limit check (if before generation starts, stop immediately)
      const rateLimit = await this._detectRateLimit();
      if (rateLimit.detected) {
        if (!sawGenerationSignal) {
          this.logger.warn(`[Attempt ${index + 1}] Rate limit detected before generation started: ${rateLimit.message}`);
          throw new Error(`RATE_LIMIT: ${rateLimit.message}`);
        }

        if (!this.rateLimitAfterStart) {
          this.logger.debug(
            `[Attempt ${index + 1}] Rate limit detected after generation started; will stop after current attempt`
          );
        }
        this.rateLimitAfterStart = true;
      }

      // Content moderation check
      const moderation = await this._detectContentModeration();
      if (moderation.detected) {
        this.logger.warn(`[Attempt ${index + 1}] Content moderation detected: ${moderation.message}`);
        throw new Error(`CONTENT_MODERATED: ${moderation.message}`);
      }

      // Network error check
      const networkError = await this._detectNetworkError();
      if (networkError.detected) {
        this.logger.warn(`[Attempt ${index + 1}] Network error detected: ${networkError.message}`);
        throw new Error(`NETWORK_ERROR: ${networkError.message}`);
      }

      // General generation error check
      const genError = await this._detectGenerationError();
      if (genError.detected) {
        this.logger.warn(`[Attempt ${index + 1}] Generation error detected: ${genError.message}`);
        throw new Error(`GENERATION_ERROR: ${genError.message}`);
      }

      // 2. Check for success
      if (video) {
        // Video element found, verify it's actually playable
        const isPlayable = await this._verifyVideoPlayable(video);
        if (isPlayable) {
          this.logger.success(`[Attempt ${index + 1}] Video ready and verified`);
          return { success: true };
        }
      }

      // 3. Check for timeout
      if (elapsed > config.VIDEO_GENERATION_TIMEOUT / 1000) {
        this.logger.error(`[Attempt ${index + 1}] Generation timeout after ${elapsed}s`);
        throw new Error(`TIMEOUT: Video generation exceeded ${config.VIDEO_GENERATION_TIMEOUT / 1000}s`);
      }

      // 4. Log progress periodically
      if (elapsed - lastProgressLog >= 10) {
        if (loading) {
          this.logger.debug(`[Attempt ${index + 1}] Still generating... (${elapsed}s)`);
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

      this.logger.debug(`Debug artifacts saved for attempt ${index}`);
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
