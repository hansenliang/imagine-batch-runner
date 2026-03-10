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
    this._logLabel = 'Attempt'; // Default label; overridden per generate() call
  }

  /**
   * Format the log prefix for the current attempt (e.g. "[Attempt 4]" or "[Extend 4]")
   * @param {number} index - Zero-based attempt index
   * @returns {string}
   */
  _tag(index) {
    return `[${this._logLabel} ${index + 1}]`;
  }

  /**
   * Generate a single video from the current permalink (single attempt)
   * Returns: { success, rateLimited, attempted, error }
   *
   * See claude.md "Generation Outcome Classification" for outcome definitions and logging levels.
   * @param {number} index - Attempt index for logging
   * @param {string} prompt - The prompt to use
   * @param {Object} [options] - Optional settings
   * @param {string} [options.logLabel] - Label prefix for log messages (e.g. "Extend" vs default "Attempt")
   */
  async generate(index, prompt, options = {}) {
    // Store label on instance so inner methods (_waitForCompletion etc.) can use it
    this._logLabel = options.logLabel || 'Attempt';
    let lastError = null;
    const startTime = Date.now();

    try {
      // Step 1: Ensure prompt is set correctly
      await this._enterPrompt(prompt, index);

      // Step 2: Click the generation button
      await this._clickGenerationButton(index);

      // Step 3: Wait for video generation to complete
      const completionResult = await this._waitForCompletion(index);

      const duration = Date.now() - startTime;
      return {
        success: true,
        rateLimited: false,
        attempted: true,
        contentModerated: false,
        durationMs: duration,
        actualResolution: completionResult?.actualResolution || null,
        abTestDetected: completionResult?.abTestDetected || false,
      };
    } catch (error) {
      // Rate limit detected before generation starts - doesn't count as attempt
      if (error.message?.includes('RATE_LIMIT')) {
        this.logger.warn(`${this._tag(index)} Rate limit detected (not attempted)`);
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
    this.logger.error(`${this._tag(index)} Failed: ${lastError?.message}`);

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
   * Dismiss any announcement banners that may block UI elements
   * @private
   */
  async _dismissBanners() {
    try {
      const dismissButton = await this.page.$(selectors.ANNOUNCEMENT_BANNER_DISMISS);
      if (dismissButton) {
        const isVisible = await dismissButton.isVisible().catch(() => false);
        if (isVisible) {
          await dismissButton.click();
          this.logger.debug('Dismissed announcement banner');
          await sleep(config.UI_ACTION_DELAY);
        }
      }
    } catch (error) {
      // Silently ignore - banner dismissal is best-effort
    }
  }

  /**
   * Click the generation submit button.
   * New UI: button[aria-label="Make video"] wrapping an arrow SVG.
   * Old UI: button with text "Make video" or "Redo".
   */
  async _clickGenerationButton(index) {
    await this._dismissBanners();
    this.logger.debug(`${this._tag(index)} Looking for generation button`);

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
      const promptResult = await this._findGenerationButtonNearPrompt(index);
      if (promptResult.element) {
        button = promptResult.element;
        buttonLabel = promptResult.label;
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
          `${this._tag(index)} Visible buttons: ${visibleLabels.join(' | ') || 'none'}`
        );
      }
    }

    if (!button) {
      throw new Error('Generation button not found');
    }

    const buttonText = buttonLabel || await button.textContent().catch(() => '(unknown)');
    this.logger.debug(`${this._tag(index)} Found button: "${buttonText}"`);

    // Check if button is disabled (might indicate rate limit)
    const isDisabled = await button.isDisabled().catch(() => false);
    if (isDisabled) {
      throw new Error('RATE_LIMIT: Generation button is disabled');
    }

    await button.click();
    this.logger.debug(`${this._tag(index)} Clicked generation button`);

    // Wait for UI to respond
    await sleep(config.UI_ACTION_DELAY);
  }

  /**
   * Find the generation button near the prompt input field.
   * Returns: { element, label } or { element: null }
   */
  async _findGenerationButtonNearPrompt(index) {
    const empty = { element: null, label: null };
    try {
      const promptInput = await this.page.$(selectors.PROMPT_INPUT);
      if (!promptInput) return empty;

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
      if (!container) return empty;

      const candidates = await container.$$('button, [role="button"]');
      if (candidates.length === 0) return empty;

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
          `${this._tag(index)} Found prompt-adjacent button: "${bestLabel || 'icon-only'}" (score=${bestScore})`
        );
      }

      return { element: best, label: bestLabel };
    } catch (error) {
      this.logger.debug(`${this._tag(index)} Prompt-adjacent button lookup failed: ${error.message}`);
      return empty;
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
      const currentPath = this.page.url().replace(/https?:\/\/[^/]+/, '');
      throw new Error(`Prompt input not found after ${waitTimeout}ms (page: ${currentPath})`);
    }

    if (!promptInput) {
      throw new Error('Prompt input element not found');
    }

    // Detect if this is a contenteditable element (TipTap/ProseMirror) vs native input/textarea
    const isContentEditable = await promptInput.evaluate(
      (el) => el.getAttribute('contenteditable') === 'true'
    ).catch(() => false);

    // Read current value (different API for contenteditable vs native input)
    const currentValue = isContentEditable
      ? await promptInput.innerText().catch(() => '')
      : await promptInput.inputValue().catch(() => '');

    // Only fill if value doesn't match
    if (currentValue.trim() === prompt.trim()) {
      this.logger.debug(`${this._tag(index)} Prompt already set correctly`);
      return;
    }

    // Playwright's fill() supports both native inputs and contenteditable elements.
    // Click to focus first, then fill. Fall back to pressSequentially if fill() fails.
    await promptInput.click();
    try {
      await promptInput.fill(prompt);
    } catch (fillError) {
      this.logger.debug(`${this._tag(index)} fill() failed (${fillError.message}), falling back to pressSequentially`);
      await this.page.keyboard.press('Control+a');
      await this.page.keyboard.press('Backspace');
      await promptInput.pressSequentially(prompt, { delay: 10 });
    }

    // Verify the value was set correctly
    const verifyValue = isContentEditable
      ? await promptInput.innerText().catch(() => '')
      : await promptInput.inputValue().catch(() => '');

    if (verifyValue.trim() !== prompt.trim()) {
      throw new Error(`Prompt verification failed: expected "${prompt.slice(0, 50)}..." but got "${verifyValue.slice(0, 50)}..."`);
    }

    this.logger.debug(`${this._tag(index)} Prompt entered and verified`);
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
   * Detect rate limit from UI (requires Upgrade button to be visible)
   */
  async _detectRateLimit() {
    try {
      const upgradeButton = await this.page.$(selectors.RATE_LIMIT_TOAST);
      if (upgradeButton) {
        const isVisible = await upgradeButton.isVisible().catch(() => false);
        if (isVisible) {
          return { detected: true, message: 'Rate limit reached (Upgrade button visible)' };
        }
      }
      return { detected: false, message: null };
    } catch (error) {
      return { detected: false, message: null };
    }
  }

  /**
   * Detect resolution downgrade toast and extract actual resolution
   * Returns: { detected: boolean, actualResolution: string | null, message: string | null }
   */
  async _detectResolutionDowngrade() {
    try {
      const downgradeMsg = await this.page.$(selectors.RESOLUTION_DOWNGRADE_TOAST);
      if (downgradeMsg) {
        const text = await downgradeMsg.textContent().catch(() => '');
        // Extract resolution from "switched to 480p" pattern
        const match = text.match(/switched.*?(\d+p)/i);
        const actualResolution = match ? match[1] : null;
        return { detected: true, actualResolution, message: text };
      }
      return { detected: false, actualResolution: null, message: null };
    } catch (error) {
      return { detected: false, actualResolution: null, message: null };
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
   * Detect A/B test state (two playable videos shown for comparison)
   * Uses structural detection (counting playable videos) rather than button text for robustness
   * @returns {{ detected: boolean, videoCount: number }}
   */
  async _detectABTest() {
    try {
      const videos = await this.page.$$(selectors.VIDEO_CONTAINER);
      let playableCount = 0;

      for (const video of videos) {
        const isVisible = await video.isVisible().catch(() => false);
        if (!isVisible) continue;

        const src = await video.evaluate(v => v.currentSrc || v.src || '').catch(() => '');
        const duration = await video.evaluate(v => v.duration).catch(() => 0);

        if (src && duration > 0) {
          playableCount++;
        }
      }

      return { detected: playableCount === 2, videoCount: playableCount };
    } catch (error) {
      this.logger.debug(`A/B test detection error: ${error.message}`);
      return { detected: false, videoCount: 0 };
    }
  }

  /**
   * Dismiss A/B test by clicking the first preference button
   * Finds buttons near video elements and clicks the first one found
   * @param {number} index - Current attempt index for logging
   * @returns {Promise<boolean>} - Whether dismissal was successful
   */
  async _dismissABTest(index) {
    try {
      const videos = await this.page.$$(selectors.VIDEO_CONTAINER);

      for (const video of videos) {
        const isVisible = await video.isVisible().catch(() => false);
        if (!isVisible) continue;

        // Find parent container that holds both video and button
        // Walk up the DOM tree to find a container with a button
        const container = await video.evaluateHandle(el => {
          let parent = el.parentElement;
          for (let i = 0; i < 6 && parent; i++) {
            if (parent.querySelector('button')) return parent;
            parent = parent.parentElement;
          }
          return el.parentElement;
        });

        const containerElement = container.asElement();
        if (!containerElement) continue;

        const button = await containerElement.$('button');
        if (button) {
          const isButtonVisible = await button.isVisible().catch(() => false);
          if (isButtonVisible) {
            this.logger.info(`${this._tag(index)} A/B test detected, selecting first variation`);
            await button.click();
            await sleep(2000); // Wait for UI transition
            return true;
          }
        }
      }

      this.logger.warn(`${this._tag(index)} A/B test detected but could not find dismiss button`);
      return false;
    } catch (error) {
      this.logger.warn(`${this._tag(index)} A/B test dismissal error: ${error.message}`);
      return false;
    }
  }

  /**
   * Trigger extend mode by clicking "..." menu → "Extend video".
   * After this, the UI transitions to extend mode where generate() can be called
   * with the same prompt to extend the video.
   * @param {number} index - Current attempt index for logging
   * @returns {Promise<boolean>} - Whether extend mode was triggered successfully
   */
  async triggerExtendMode(index) {
    try {
      await this._dismissBanners();

      // Step 1: Click the Settings button (same button used for mode selection).
      // When a video is already generated, its menu includes "Extend video".
      const settingsButton = await this.page.$(selectors.SETTINGS_BUTTON);
      if (!settingsButton) {
        this.logger.debug(`${this._tag(index)} Settings button not found for extend`);
        return false;
      }

      const isVisible = await settingsButton.isVisible().catch(() => false);
      if (!isVisible) {
        this.logger.debug(`${this._tag(index)} Settings button not visible for extend`);
        return false;
      }

      await settingsButton.click();
      await sleep(config.UI_ACTION_DELAY);

      // Step 2: Click "Extend video" menu item
      let extendItem = await this.page.$(selectors.EXTEND_MENU_ITEM);

      // Fallback: scan menu items for extend text
      if (!extendItem) {
        const menuItems = await this.page.$$('[role="menuitem"]');
        for (const item of menuItems) {
          const itemVisible = await item.isVisible().catch(() => false);
          if (!itemVisible) continue;
          const text = await item.innerText().catch(() => '');
          if (/extend\s+video/i.test(text)) {
            extendItem = item;
            break;
          }
        }
      }

      if (!extendItem) {
        this.logger.debug(`${this._tag(index)} Extend video menu item not found in Settings menu`);
        await this.page.keyboard.press('Escape');
        return false;
      }

      const itemVisible = await extendItem.isVisible().catch(() => false);
      if (!itemVisible) {
        this.logger.debug(`${this._tag(index)} Extend video menu item not visible`);
        await this.page.keyboard.press('Escape');
        return false;
      }

      await extendItem.click();
      await sleep(config.UI_ACTION_DELAY);

      this.logger.debug(`${this._tag(index)} Extend mode triggered via Settings menu`);
      return true;
    } catch (error) {
      this.logger.debug(`${this._tag(index)} Extend mode trigger failed: ${error.message}`);
      try { await this.page.keyboard.press('Escape'); } catch { /* ignore */ }
      return false;
    }
  }

  /**
   * Trigger "extend from frame" mode by seeking the video to a specific time,
   * hovering over the progress bar to reveal the button, and clicking it.
   *
   * After this, the UI transitions to extend mode (same as triggerExtendMode)
   * where generate() can be called with a prompt.
   *
   * @param {number} timeSeconds - Time in seconds to seek to before extending
   * @param {number} index - Current attempt index for logging
   * @returns {Promise<boolean>} - Whether extend-from-frame was triggered successfully
   */
  async triggerExtendFromFrame(timeSeconds, index) {
    try {
      await this._dismissBanners();

      // Step 1: Find the video element, seek to target time, and pause
      const videoEl = await this.page.$(selectors.VIDEO_CONTAINER);
      if (!videoEl) {
        this.logger.debug(`${this._tag(index)} No video element found for extend-from-frame`);
        return false;
      }

      const seeked = await this.page.evaluate(
        ({ sel, targetTime }) => {
          const videos = document.querySelectorAll(sel);
          for (const v of videos) {
            if ((v.currentSrc || v.src) && v.duration > 0) {
              v.currentTime = Math.min(targetTime, v.duration - 0.1);
              v.pause();
              return { seeked: true, duration: v.duration, currentTime: v.currentTime };
            }
          }
          return { seeked: false };
        },
        { sel: selectors.VIDEO_CONTAINER, targetTime: timeSeconds }
      );

      if (!seeked.seeked) {
        this.logger.debug(`${this._tag(index)} Could not seek video for extend-from-frame`);
        return false;
      }

      this.logger.debug(
        `${this._tag(index)} Video seeked to ${seeked.currentTime.toFixed(1)}s / ${seeked.duration.toFixed(1)}s`
      );
      await sleep(500); // Let the seek settle

      // Step 2: Hover over the video area to reveal player controls
      const videoVisible = await videoEl.isVisible().catch(() => false);
      if (videoVisible) {
        await videoEl.hover();
        await sleep(500);
      }

      // Step 3: Find the progress bar and hover over it.
      // The progress bar has a distinctive class pattern: opacity-0, cursor-pointer,
      // rounded-full, with a child div that shows progress width.
      // We try multiple strategies to locate and hover it.
      let extendButton = null;

      // Strategy A: Hover the video area and look for the progress bar by class pattern
      extendButton = await this._hoverProgressBarAndFindButton(index);

      // Strategy B: Force-reveal via JS if hover didn't work
      if (!extendButton) {
        this.logger.debug(`${this._tag(index)} Hover strategy failed, trying JS force-reveal`);
        extendButton = await this._forceRevealExtendFromFrame(index);
      }

      if (!extendButton) {
        this.logger.debug(`${this._tag(index)} "Extend from frame" button not found after all strategies`);
        return false;
      }

      // Step 4: Click the button
      await extendButton.click();
      await sleep(config.UI_ACTION_DELAY);

      this.logger.debug(
        `${this._tag(index)} Extend-from-frame triggered at ${timeSeconds}s`
      );
      return true;
    } catch (error) {
      this.logger.debug(`${this._tag(index)} Extend-from-frame failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Hover over the video progress bar to reveal the "extend from frame" button.
   * The progress bar is an opacity-0 div with cursor-pointer that becomes visible on hover.
   * @param {number} index - Attempt index for logging
   * @returns {Promise<import('playwright').ElementHandle|null>}
   * @private
   */
  async _hoverProgressBarAndFindButton(index) {
    try {
      // Find candidate progress bar elements: div with cursor-pointer and rounded-full
      // that contains a child div (the fill bar)
      const progressBar = await this.page.evaluateHandle(() => {
        const candidates = document.querySelectorAll('div.cursor-pointer.rounded-full');
        for (const el of candidates) {
          // Must have a child div (the progress fill) and be within the video player area
          if (el.querySelector('div') && el.closest('video, [class*="video"], [class*="player"]')?.parentElement) {
            return el;
          }
        }
        // Broader fallback: any cursor-pointer rounded-full with opacity-0
        for (const el of candidates) {
          if (el.querySelector('div')) {
            const style = window.getComputedStyle(el);
            if (style.opacity === '0' || el.classList.contains('opacity-0')) {
              return el;
            }
          }
        }
        return null;
      });

      const progressBarEl = progressBar.asElement();
      if (!progressBarEl) {
        this.logger.debug(`${this._tag(index)} Progress bar element not found`);
        return null;
      }

      // Hover to reveal the bar and its controls
      await progressBarEl.hover();
      await sleep(800); // Give CSS transitions time (duration-300 = 300ms)

      // Now look for the "extend from frame" button
      const button = await this._findExtendFromFrameButton();
      return button;
    } catch (error) {
      this.logger.debug(`${this._tag(index)} Progress bar hover failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Force-reveal the "extend from frame" button via JavaScript.
   * Sets opacity on hidden overlay elements and dispatches mouseover events.
   * @param {number} index - Attempt index for logging
   * @returns {Promise<import('playwright').ElementHandle|null>}
   * @private
   */
  async _forceRevealExtendFromFrame(index) {
    try {
      // Force all opacity-0 elements near the video to become visible
      await this.page.evaluate(() => {
        // Reveal all opacity-0 elements that are children of the video player area
        const hiddenEls = document.querySelectorAll('.opacity-0');
        for (const el of hiddenEls) {
          el.style.opacity = '1';
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }
        // Also dispatch hover on video elements to trigger any React hover state
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
          let parent = v.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            parent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            parent = parent.parentElement;
          }
        }
      });

      await sleep(800);

      const button = await this._findExtendFromFrameButton();
      return button;
    } catch (error) {
      this.logger.debug(`${this._tag(index)} Force-reveal failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Find the "extend from frame" button on the page (case-insensitive text search).
   * @returns {Promise<import('playwright').ElementHandle|null>}
   * @private
   */
  async _findExtendFromFrameButton() {
    // Try the selector from config first
    let button = await this.page.$(selectors.EXTEND_FROM_FRAME_BUTTON);
    if (button) {
      const isVisible = await button.isVisible().catch(() => false);
      if (isVisible) return button;
    }

    // Fallback: scan all buttons for case-insensitive text match
    const buttons = await this.page.$$('button');
    for (const btn of buttons) {
      const isVisible = await btn.isVisible().catch(() => false);
      if (!isVisible) continue;
      const text = await btn.innerText().catch(() => '');
      if (/extend\s+from\s+frame/i.test(text)) {
        return btn;
      }
    }

    return null;
  }

  /**
   * Detect progress percentage anywhere on screen (e.g., "Generating 16%", "45%")
   * New UI shows progress as overlay text on the video area, not inside a button.
   * Uses DOM tree walker for efficient full-page scan.
   */
  async _detectProgressPercentage() {
    try {
      const result = await this.page.evaluate(() => {
        // Strategy 1: Look for the tabular-nums span (new UI progress indicator)
        const tabularSpans = document.querySelectorAll('span.tabular-nums');
        for (const span of tabularSpans) {
          const match = span.textContent.match(/(\d{1,3})%/);
          if (match) {
            const rect = span.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { percentage: parseInt(match[1], 10), text: span.textContent.trim() };
            }
          }
        }

        // Strategy 2: TreeWalker fallback for any visible percentage text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const match = walker.currentNode.textContent.match(/(\d{1,3})%/);
          if (match) {
            const el = walker.currentNode.parentElement;
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { percentage: parseInt(match[1], 10), text: el.innerText.trim() };
              }
            }
          }
        }
        return null;
      });

      if (result) {
        return { detected: true, percentage: result.percentage, text: result.text };
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
      // 1. Check if video has a source (currentSrc works regardless of whether
      // src is on the <video> tag, via <source> children, or set programmatically)
      const src = await videoElement.evaluate(v => v.currentSrc || v.src || '');
      if (!src) {
        this.logger.debug('Video verification failed: no src/currentSrc');
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
    let actualResolution = null; // Track if resolution was downgraded

    while (true) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      const video = await this.page.$(selectors.VIDEO_CONTAINER);
      const percentageProgress = await this._detectProgressPercentage();

      // % > 0 means generation is actively in progress
      const generationInProgress = percentageProgress.detected && percentageProgress.percentage > 0;

      // Check for resolution downgrade once, early in generation (before loggedStart)
      if (!actualResolution && !loggedStart) {
        const downgrade = await this._detectResolutionDowngrade();
        if (downgrade.detected) {
          actualResolution = downgrade.actualResolution;
          this.logger.info(`${this._tag(index)} Resolution downgraded: ${downgrade.message}`);
        }
      }

      // Log once when generation starts
      if (generationInProgress && !loggedStart) {
        this.logger.info(`${this._tag(index)} Generation started: ${percentageProgress.percentage}%`);
        loggedStart = true;
      }

      // 1. Check for video completion - only if we saw generation start
      // This prevents false positives from pre-existing videos on the page
      if (video && loggedStart) {
        const isPlayable = await this._verifyVideoPlayable(video);
        if (isPlayable) {
          // Check for A/B test state (two playable videos shown for comparison)
          const abTest = await this._detectABTest();
          if (abTest.detected) {
            const dismissed = await this._dismissABTest(index);
            if (dismissed) {
              // Wait for UI to settle after dismissal
              await sleep(2000);
              // Verify we're back to normal state (single video)
              const recheck = await this._detectABTest();
              if (recheck.detected) {
                this.logger.warn(`${this._tag(index)} A/B test still present after dismiss attempt`);
              }
            }
            this.logger.success(`${this._tag(index)} Video ready and verified (A/B test dismissed)`);
            return { success: true, actualResolution, abTestDetected: true };
          }

          this.logger.success(`${this._tag(index)} Video ready and verified`);
          return { success: true, actualResolution, abTestDetected: false };
        }
      }

      // 2. Always check for timeout
      if (elapsed > config.VIDEO_GENERATION_TIMEOUT / 1000) {
        this.logger.error(`${this._tag(index)} Generation timeout after ${elapsed}s`);
        throw new Error(`TIMEOUT: Video generation exceeded ${config.VIDEO_GENERATION_TIMEOUT / 1000}s`);
      }

      // 3. Check if page drifted away from Imagine post page (e.g. error → /imagine home)
      if (!this.page.url().includes('/imagine/post/')) {
        const driftUrl = this.page.url();
        this.logger.warn(`${this._tag(index)} Page navigated away to ${driftUrl}`);
        throw new Error(`PAGE_DRIFTED: Page navigated to ${driftUrl}`);
      }

      // 4. Only check for errors when % is 0 or not visible
      // This prevents false positives from stale toasts while generation is in progress
      if (!generationInProgress) {
        // Only check rate limit if generation was never observed in progress.
        // Once progress was seen (loggedStart), the generation was accepted by the
        // server — progress disappearing means "video loading", not "rate limited".
        // Account-wide rate limit toasts from other workers would cause false positives here.
        if (!loggedStart) {
          const rateLimit = await this._detectRateLimit();
          if (rateLimit.detected) {
            this.logger.warn(`${this._tag(index)} Rate limit detected: ${rateLimit.message}`);
            throw new Error(`RATE_LIMIT: ${rateLimit.message}`);
          }
        }

        const moderation = await this._detectContentModeration();
        if (moderation.detected) {
          this.logger.warn(`${this._tag(index)} Content moderation detected: ${moderation.message}`);
          throw new Error(`CONTENT_MODERATED: ${moderation.message}`);
        }

        const networkError = await this._detectNetworkError();
        if (networkError.detected) {
          this.logger.warn(`${this._tag(index)} Network error detected: ${networkError.message}`);
          throw new Error(`NETWORK_ERROR: ${networkError.message}`);
        }

        const genError = await this._detectGenerationError();
        if (genError.detected) {
          this.logger.warn(`${this._tag(index)} Generation error detected: ${genError.message}`);
          throw new Error(`GENERATION_ERROR: ${genError.message}`);
        }
      }

      await sleep(checkInterval);
    }
  }
}

export default VideoGenerator;
