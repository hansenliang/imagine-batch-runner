import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

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
  RUNS_DIR: path.resolve(__dirname, '..', 'logs'),

  // Timeouts (milliseconds)
  VIDEO_GENERATION_TIMEOUT: 60000, // 60 seconds
  PAGE_LOAD_TIMEOUT: 30000,
  ELEMENT_WAIT_TIMEOUT: parseInt(process.env.ELEMENT_WAIT_TIMEOUT, 10) || 30000, // 30 seconds (configurable via env var)

  // Content moderation retry configuration
  MODERATION_RETRY_MAX: 100, // Max retries for content moderation errors
  MODERATION_RETRY_COOLDOWN: 1000, // 1 second cooldown between moderation retries

  // Generation settings
  DEFAULT_BATCH_SIZE: 10,

  // Parallel execution
  DEFAULT_PARALLELISM: 10,
  WORKER_SHUTDOWN_TIMEOUT: 60000, // 60s grace period for shutdown

  // Auto-run settings
  DEFAULT_AUTORUN_INTERVAL: 4 * 60 * 60 * 1000, // 4 hours in milliseconds
  DEFAULT_AUTORUN_CONFIG_DIR: './autorun-configs',
  AUTORUN_MIN_INTERVAL: 30 * 60 * 1000, // 30 minutes minimum

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
  MAKE_VIDEO_BUTTON: 'button:has-text("Make video"), button:has-text("make video"), button[aria-label*="make video" i], button[aria-label*="generate video" i], button[title*="make video" i], button[title*="generate video" i]',
  REDO_BUTTON: 'button:has-text("Redo"), button:has-text("redo"), button[aria-label*="redo" i], button[title*="redo" i]',

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
