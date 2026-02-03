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
  RUNS_DIR: path.resolve(__dirname, '..', 'logs'),
  AUTORUN_LOGS_DIR: path.resolve(__dirname, '..', 'logs', 'autorun'),
  SINGLE_RUN_LOGS_DIR: path.resolve(__dirname, '..', 'logs', 'runs'),
  CACHE_DIR: path.resolve(__dirname, '..', 'cache'),

  // Timeouts (milliseconds)
  VIDEO_GENERATION_TIMEOUT: 60000, // 60 seconds
  PAGE_LOAD_TIMEOUT: 30000,
  ELEMENT_WAIT_TIMEOUT: parseInt(process.env.ELEMENT_WAIT_TIMEOUT, 10) || 30000, // 30 seconds (configurable via env var)
  UI_ACTION_DELAY: 1000, // 1 second delay after UI actions (menu open/close, button clicks)

  // Content moderation retry configuration
  MODERATION_RETRY_MAX: 100, // Max retries for content moderation errors
  MODERATION_RETRY_COOLDOWN: 1000, // 1 second cooldown between moderation retries

  // Generation settings
  DEFAULT_BATCH_SIZE: 10,

  // Parallel execution
  DEFAULT_PARALLELISM: 10,
  WORKER_SHUTDOWN_TIMEOUT: 60000, // 60s grace period for shutdown

  // Auto-run settings
  DEFAULT_AUTORUN_INTERVAL: 2 * 60 * 60 * 1000, // 2 hours in milliseconds
  DEFAULT_AUTORUN_CONFIG_DIR: './autorun-configs',
  AUTORUN_MIN_INTERVAL: 30 * 60 * 1000, // 30 minutes minimum

  // Download/delete/upscale settings
  DEFAULT_DOWNLOAD_ENABLED: true,
  DEFAULT_UPSCALE_ENABLED: true,
  DEFAULT_DELETE_ENABLED: false,
  DOWNLOAD_DIR: path.resolve(__dirname, '..', 'downloads'),
  DOWNLOAD_TIMEOUT: 60000, // 60 seconds
  DOWNLOAD_RETRY_MAX: 3,
  DOWNLOAD_RETRY_DELAY: 2000, // 2 seconds between retries
  POST_GENERATION_DELAY: 1000, // 1s delay after generation before download
  POST_DOWNLOAD_DELAY: 1000, // 1s delay after download before delete/upscale

  // Upscale settings
  UPSCALE_TIMEOUT: 30000, // 30 seconds max wait for upscale
  UPSCALE_POST_COMPLETION_DELAY: 3000, // 3 seconds after HD badge appears
  UPSCALE_RETRY_MAX: 3,
  UPSCALE_RETRY_DELAY: 2000, // 2 seconds between retries

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

  // Error detection
  CONTENT_MODERATED_MESSAGE: 'text=/try a different idea|content moderated|moderated|blocked/i',
  NETWORK_ERROR_MESSAGE: 'text=/network error|connection lost|failed to load/i',
  GENERATION_ERROR_MESSAGE: 'text=/generation failed|error generating|something went wrong/i',

  // Rate limit indicators
  RATE_LIMIT_TOAST: 'text=/try again later|rate limit|too many requests|usage limit|video limit|limit reached|daily limit|hourly limit|quota exceeded|maximum.*reached/i',

  // Success indicators
  VIDEO_DOWNLOAD_BUTTON: 'button:has-text("Download"), button:has-text("Save"), a[download]',

  // Authentication
  LOGIN_BUTTON: 'button:has-text("Log in"), button:has-text("Sign in")',

  // Options and quality
  OPTIONS_BUTTON: 'button:has-text("Options")',
  HD_BUTTON: 'button:has-text("HD")',

  // Download button (aria-label="Download")
  DOWNLOAD_BUTTON: 'button[aria-label*="download" i], button[aria-label*="Download"]',

  // Delete flow - "More options" button (aria-label="More options")
  VIDEO_MENU_BUTTON: 'button[aria-label*="more options" i], button[aria-label*="More options"]',

  // Delete menu item (role="menuitem" containing "Delete")
  DELETE_MENU_ITEM: '[role="menuitem"]:has-text("Delete"), [role="menuitem"]:has-text("delete")',

  // Delete confirmation modal
  DELETE_CONFIRM_BUTTON: '[role="dialog"] button:has-text("Delete"), [role="alertdialog"] button:has-text("Delete"), button:has-text("Confirm")',
  DELETE_MODAL: '[role="dialog"], [role="alertdialog"]',

  // Upscale flow
  UPSCALE_MENU_ITEM: '[role="menuitem"]:has-text("Upscale"), [role="menuitem"]:has-text("upscale")',
  UPSCALING_INDICATOR: 'text=/upscaling/i',
  HD_BADGE: 'text=/^HD$/i',

  // Video duration selection
  VIDEO_OPTIONS_BUTTON: 'button[aria-label="Video Options"]',

  // Announcement banner dismiss button (X button inside z-[9999] banner)
  ANNOUNCEMENT_BANNER_DISMISS: 'div.absolute[class*="z-[9999]"] button:has(svg.lucide-x)',
};

export default config;
