#!/usr/bin/env node

/**
 * Quick test to validate all imports work
 */

import { AccountManager } from './core/accounts.js';
import { BrowserManager } from './core/browser.js';
import { VideoGenerator } from './core/generator.js';
import { ManifestManager } from './core/manifest.js';
import { BatchRunner } from './core/runner.js';
import { Logger } from './utils/logger.js';
import { retry, sleep, calculateBackoff } from './utils/retry.js';
import config, { selectors } from './config.js';

console.log('✓ All imports successful');
console.log('✓ Config loaded:', {
  profilesDir: config.PROFILES_DIR,
  runsDir: config.RUNS_DIR,
  defaultBatchSize: config.DEFAULT_BATCH_SIZE,
});
console.log('✓ Selectors loaded:', Object.keys(selectors).length, 'selectors');
console.log('\n✅ Code structure is valid!\n');
