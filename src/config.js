import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  // Rate limiting
  DEFAULT_RATE_LIMIT: 100, // videos per period
  DEFAULT_RATE_PERIOD: 4 * 60 * 60 * 1000, // 4 hours in milliseconds
  RATE_LIMIT_COOLDOWN: 5 * 60 * 1000, // 5 minutes wait on rate limit

  // Generation settings
  DEFAULT_BATCH_SIZE: 10,
  MAX_BATCH_SIZE: 100,

  // Browser settings
  HEADED_MODE: true, // Default to headed for debugging
  VIEWPORT: { width: 1280, height: 720 },

  // Optional: use real Chrome user profile to reduce bot checks
  // This will COPY the chosen profile into the tool's own user-data dir.
  // Example macOS path: /Users/<you>/Library/Application Support/Google/Chrome
  CHROME_USER_DATA_DIR: process.env.CHROME_USER_DATA_DIR || '',
  // Example: "Default", "Profile 1", "Profile 2"
  CHROME_PROFILE_NAME: process.env.CHROME_PROFILE_NAME || '',
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

  // Rate limit indicators
  RATE_LIMIT_TOAST: 'text=/try again later|rate limit|too many requests/i',
  ERROR_MESSAGE: '[role="alert"], .error, .toast',

  // Authentication
  LOGIN_BUTTON: 'button:has-text("Log in"), button:has-text("Sign in")',

  // Options and quality
  OPTIONS_BUTTON: 'button:has-text("Options")',
  HD_BUTTON: 'button:has-text("HD")',
};

export default config;
