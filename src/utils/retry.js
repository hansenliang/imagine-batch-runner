import config from '../config.js';

/**
 * Sleep utility
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff with jitter
 */
export function calculateBackoff(attempt, baseDelay = config.RETRY_DELAY_BASE, maxDelay = config.RETRY_DELAY_MAX) {
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
  return Math.floor(exponentialDelay + jitter);
}

/**
 * Retry a function with exponential backoff
 */
export async function retry(fn, options = {}) {
  const {
    maxRetries = config.MAX_RETRIES,
    onRetry = null,
    shouldRetry = () => true,
    retryableErrors = [],
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      const isRetryable = shouldRetry(error) ||
        retryableErrors.some(pattern =>
          error.message?.includes(pattern) ||
          error.name?.includes(pattern)
        );

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateBackoff(attempt);

      if (onRetry) {
        await onRetry(attempt + 1, maxRetries, delay, error);
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Retry a function with fixed cooldown (for content moderation retries)
 */
export async function retryWithCooldown(fn, options = {}) {
  const {
    maxRetries = config.MODERATION_RETRY_MAX,
    cooldown = config.MODERATION_RETRY_COOLDOWN,
    onRetry = null,
    errorPattern = 'CONTENT_MODERATED',
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if this is a retryable error
      const isRetryable = error.message?.includes(errorPattern);

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      // Notify retry callback
      if (onRetry) {
        await onRetry(attempt + 1, maxRetries, cooldown, error);
      }

      // Wait fixed cooldown period
      await sleep(cooldown);
    }
  }

  throw lastError;
}

export default { sleep, calculateBackoff, retry, retryWithCooldown };
