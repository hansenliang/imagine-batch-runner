import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Auto-detect Chrome user data directory based on platform
 */
function getChromeUserDataDir() {
  // First, check if user set it via environment variable
  if (process.env.CHROME_USER_DATA_DIR) {
    return process.env.CHROME_USER_DATA_DIR;
  }

  // Auto-detect based on platform
  const platform = os.platform();
  const homeDir = os.homedir();

  let chromeDataDir;

  if (platform === 'darwin') {
    // macOS
    chromeDataDir = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
  } else if (platform === 'win32') {
    // Windows
    chromeDataDir = path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  } else if (platform === 'linux') {
    // Linux
    chromeDataDir = path.join(homeDir, '.config', 'google-chrome');
  } else {
    return ''; // Unsupported platform
  }

  // Verify directory exists
  try {
    fs.accessSync(chromeDataDir);
    return chromeDataDir;
  } catch {
    return ''; // Chrome not installed or path doesn't exist
  }
}

export const config = {
  // Paths
  PROJECT_ROOT: path.resolve(__dirname, '..'),
  PROFILES_DIR: path.resolve(__dirname, '..', 'profiles'),
  RUNS_DIR: path.join(os.homedir(), 'GrokBatchRuns'),

  // Timeouts (milliseconds)
  VIDEO_GENERATION_TIMEOUT: 60000, // 60 seconds (you mentioned 10-30s typical)
  PAGE_LOAD_TIMEOUT: 30000,
  ELEMENT_WAIT_TIMEOUT: 10000,

  // Retry configuration
  MAX_RETRIES: 3,
  RETRY_DELAY_BASE: 2000, // 2 seconds base delay
  RETRY_DELAY_MAX: 30000, // 30 seconds max delay

  // Content moderation retry configuration
  MODERATION_RETRY_MAX: 5, // Max retries for content moderation errors
  MODERATION_RETRY_COOLDOWN: 3000, // 3 seconds cooldown between moderation retries
  SUCCESS_VERIFICATION_TIMEOUT: 5000, // 5 seconds to verify video success

  // Rate limiting
  DEFAULT_RATE_LIMIT: 100, // videos per period
  DEFAULT_RATE_PERIOD: 4 * 60 * 60 * 1000, // 4 hours in milliseconds
  RATE_LIMIT_COOLDOWN: 5 * 60 * 1000, // 5 minutes wait on rate limit

  // Generation settings
  DEFAULT_BATCH_SIZE: 10,
  MAX_BATCH_SIZE: 100,

  // Parallel execution
  DEFAULT_PARALLELISM: 10,
  MAX_PARALLELISM: 100,
  WORKER_STARTUP_DELAY: 50, // 50ms stagger within batch (deprecated, now using batch launching)
  WORKER_SHUTDOWN_TIMEOUT: 60000, // 60s grace period for shutdown
  CLAIM_RETRY_INTERVAL: 2000, // 2s between work claim attempts
  WORKER_PROFILE_CLEANUP: true, // Delete worker profiles after run

  // Browser settings
  HEADED_MODE: true, // Default to headed for debugging
  VIEWPORT: { width: 1280, height: 720 },

  // Chrome profile settings (auto-detected or from environment variables)
  // Copying your real Chrome profile helps avoid bot detection
  CHROME_USER_DATA_DIR: getChromeUserDataDir(),
  CHROME_PROFILE_NAME: process.env.CHROME_PROFILE_NAME || 'Default',
};

// UI Selectors (centralized for easy updates)
export const selectors = {
  // Video generation buttons
  MAKE_VIDEO_BUTTON: 'button:has-text("Make video"), button:has-text("make video")',
  REDO_BUTTON: 'button:has-text("Redo"), button:has-text("redo")',

  // Prompt input
  PROMPT_INPUT: 'textarea[placeholder*="prompt"], input[placeholder*="prompt"], textarea, input[type="text"]',

  // Video generation states
  VIDEO_CONTAINER: 'video, [role="video"]',
  LOADING_INDICATOR: '[aria-busy="true"], .loading, .spinner',
  VIDEO_PROGRESS_BAR: '[role="progressbar"], .progress-bar, [aria-valuenow]',

  // Error detection
  CONTENT_MODERATED_MESSAGE: 'text=/try a different idea|content moderated|moderated|blocked/i',
  NETWORK_ERROR_MESSAGE: 'text=/network error|connection lost|failed to load/i',
  GENERATION_ERROR_MESSAGE: 'text=/generation failed|error generating|something went wrong/i',

  // Rate limit indicators
  RATE_LIMIT_TOAST: 'text=/try again later|rate limit|too many requests|usage limit|video limit|limit reached|daily limit|hourly limit|quota exceeded|maximum.*reached/i',
  ERROR_MESSAGE: '[role="alert"], .error, .toast',

  // Success indicators
  VIDEO_DOWNLOAD_BUTTON: 'button:has-text("Download"), button:has-text("Save"), a[download]',

  // Authentication
  LOGIN_BUTTON: 'button:has-text("Log in"), button:has-text("Sign in")',

  // Options and quality
  OPTIONS_BUTTON: 'button:has-text("Options")',
  HD_BUTTON: 'button:has-text("HD")',
};

export default config;
