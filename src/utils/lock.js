import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * File-based locking utility for coordinating concurrent access
 * Uses atomic file creation to implement a mutex lock
 */
export class FileLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.lockDir = path.dirname(lockPath);
    this.locked = false;
    this.pollInterval = 100; // Check every 100ms
    this.staleTimeout = 60000; // Consider lock stale after 60s
  }

  /**
   * Acquire the lock, waiting up to timeout milliseconds
   * @param {number} timeout - Maximum time to wait in milliseconds
   * @returns {Promise<void>}
   * @throws {Error} If unable to acquire lock within timeout
   */
  async acquire(timeout = 30000) {
    const startTime = Date.now();

    // Ensure lock directory exists
    await fs.mkdir(this.lockDir, { recursive: true });

    while (Date.now() - startTime < timeout) {
      try {
        // Try to create lock file atomically with exclusive flag
        const lockData = {
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          hostname: os.hostname(),
        };

        await fs.writeFile(this.lockPath, JSON.stringify(lockData, null, 2), {
          flag: 'wx', // Write, fail if exists (atomic)
        });

        this.locked = true;
        return;
      } catch (error) {
        if (error.code === 'EEXIST') {
          // Lock file exists, check if it's stale
          try {
            const lockContent = await fs.readFile(this.lockPath, 'utf-8');
            const lockData = JSON.parse(lockContent);
            const lockAge = Date.now() - new Date(lockData.acquiredAt).getTime();

            if (lockAge > this.staleTimeout) {
              // Stale lock detected, try to remove it
              console.warn(`Removing stale lock file (age: ${lockAge}ms, holder: pid ${lockData.pid})`);
              await fs.unlink(this.lockPath).catch(() => {}); // Ignore errors
              // Try again immediately
              continue;
            }
          } catch (parseError) {
            // Corrupt lock file, try to remove it
            console.warn('Removing corrupt lock file');
            await fs.unlink(this.lockPath).catch(() => {});
            continue;
          }

          // Valid lock held by another process, wait
          await this._sleep(this.pollInterval);
        } else {
          throw error;
        }
      }
    }

    throw new Error(`Failed to acquire lock within ${timeout}ms: ${this.lockPath}`);
  }

  /**
   * Release the lock
   * @returns {Promise<void>}
   */
  async release() {
    if (!this.locked) {
      return;
    }

    try {
      await fs.unlink(this.lockPath);
      this.locked = false;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error releasing lock:', error);
      }
      this.locked = false;
    }
  }

  /**
   * Execute a function with the lock held
   * @param {Function} fn - Async function to execute
   * @param {number} timeout - Lock acquisition timeout
   * @returns {Promise<T>} Result of fn
   */
  async withLock(fn, timeout = 30000) {
    await this.acquire(timeout);
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  /**
   * Check if lock file exists (doesn't guarantee lock is held)
   * @returns {Promise<boolean>}
   */
  async isLocked() {
    try {
      await fs.access(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default FileLock;
