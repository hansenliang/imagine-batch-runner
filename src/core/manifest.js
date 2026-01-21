import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { FileLock } from '../utils/lock.js';

/**
 * Manifest manager for tracking run state
 * Thread-safe with file locking for parallel execution
 */
export class ManifestManager {
  constructor(runDir) {
    this.runDir = runDir;
    this.manifestPath = path.join(runDir, 'manifest.json');
    this.lockPath = path.join(runDir, 'manifest.lock');
    this.lock = new FileLock(this.lockPath);
    this.manifest = null;
  }

  /**
   * Create a new manifest
   */
  static createManifest(options) {
    const {
      accountAlias,
      permalink,
      prompt,
      batchSize,
      jobName = `job_${Date.now()}`,
    } = options;

    return {
      id: uuidv4(),
      jobName,
      accountAlias,
      permalink,
      prompt,
      batchSize,
      status: 'PENDING', // PENDING, IN_PROGRESS, COMPLETED, STOPPED_RATE_LIMIT, FAILED
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextIndex: 0,
      completedCount: 0,
      failedCount: 0,
      items: Array.from({ length: batchSize }, (_, i) => ({
        index: i,
        status: 'PENDING', // PENDING, IN_PROGRESS, COMPLETED, FAILED
        attempts: 0,
        createdAt: null,
        completedAt: null,
        error: null,
      })),
      lastError: null,
      stopReason: null,
    };
  }

  /**
   * Load existing manifest
   */
  async load() {
    try {
      const data = await fs.readFile(this.manifestPath, 'utf-8');
      this.manifest = JSON.parse(data);
      return this.manifest;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Save manifest to disk (with locking for thread safety)
   */
  async save() {
    if (!this.manifest) {
      throw new Error('No manifest to save');
    }

    await this.lock.withLock(async () => {
      this.manifest.updatedAt = new Date().toISOString();
      await fs.writeFile(
        this.manifestPath,
        JSON.stringify(this.manifest, null, 2),
        'utf-8'
      );
    });
  }

  /**
   * Reload manifest from disk (used within locked sections)
   * @private
   */
  async _reloadFromDisk() {
    const data = await fs.readFile(this.manifestPath, 'utf-8');
    this.manifest = JSON.parse(data);
  }

  /**
   * Write to file without acquiring lock (used within withLock)
   * @private
   */
  async _writeToFile() {
    this.manifest.updatedAt = new Date().toISOString();
    await fs.writeFile(
      this.manifestPath,
      JSON.stringify(this.manifest, null, 2),
      'utf-8'
    );
  }

  /**
   * Apply status transition and maintain counters.
   * @private
   */
  _applyStatusTransition(item, prevStatus, nextStatus) {
    if (!nextStatus || nextStatus === prevStatus) {
      return;
    }

    if (prevStatus === 'COMPLETED') {
      this.manifest.completedCount = Math.max(0, this.manifest.completedCount - 1);
    } else if (prevStatus === 'FAILED') {
      this.manifest.failedCount = Math.max(0, this.manifest.failedCount - 1);
    }

    if (nextStatus === 'COMPLETED') {
      this.manifest.completedCount++;
      item.completedAt = new Date().toISOString();
    } else if (nextStatus === 'FAILED') {
      this.manifest.failedCount++;
    }
  }

  /**
   * Initialize a new run
   */
  async init(options) {
    // Ensure run directory exists
    await fs.mkdir(this.runDir, { recursive: true });
    await fs.mkdir(path.join(this.runDir, 'debug'), { recursive: true });

    // Create manifest
    this.manifest = ManifestManager.createManifest(options);
    await this.save();

    return this.manifest;
  }

  /**
   * Update run status
   */
  async updateStatus(status, stopReason = null) {
    this.manifest.status = status;
    if (stopReason) {
      this.manifest.stopReason = stopReason;
    }
    await this.save();
  }

  /**
   * Update item status
   */
  async updateItem(index, updates) {
    const item = this.manifest.items[index];
    if (!item) {
      throw new Error(`Item ${index} not found in manifest`);
    }

    const prevStatus = item.status;
    Object.assign(item, updates);
    this._applyStatusTransition(item, prevStatus, updates.status);

    await this.save();
  }

  /**
   * Mark item as in progress
   */
  async startItem(index) {
    await this.updateItem(index, {
      status: 'IN_PROGRESS',
      attempts: this.manifest.items[index].attempts + 1,
      createdAt: this.manifest.items[index].createdAt || new Date().toISOString(),
    });
    this.manifest.nextIndex = index + 1;
    await this.save();
  }

  /**
   * Get next pending item
   */
  getNextPending() {
    return this.manifest.items.find(item =>
      item.status === 'PENDING' || item.status === 'FAILED'
    );
  }

  /**
   * Get summary
   */
  getSummary() {
    const { batchSize, status, stopReason, items } = this.manifest;
    const completedCount = items.filter(item => item.status === 'COMPLETED').length;
    const failedCount = items.filter(item => item.status === 'FAILED').length;
    return {
      total: batchSize,
      completed: completedCount,
      failed: failedCount,
      remaining: batchSize - completedCount - failedCount,
      status,
      stopReason,
    };
  }

  /**
   * Atomically claim the next pending item for a worker
   * Thread-safe for parallel execution
   * @param {string|number} workerId - Unique worker identifier
   * @returns {Promise<Object|null>} The claimed item or null if no work available
   */
  async claimNextItem(workerId) {
    return await this.lock.withLock(async () => {
      // Reload latest state from disk (another worker may have updated)
      await this._reloadFromDisk();

      if (this.manifest.status === 'STOPPED_RATE_LIMIT') {
        return null;
      }

      // Find first PENDING or FAILED item (retry failed items)
      const item = this.manifest.items.find(
        i => i.status === 'PENDING' || (i.status === 'FAILED' && i.attempts < 3)
      );

      if (!item) {
        return null; // No work available
      }

      const prevStatus = item.status;

      // Mark as IN_PROGRESS and assign to worker
      item.status = 'IN_PROGRESS';
      item.workerId = workerId;
      item.claimedAt = new Date().toISOString();
      item.attempts = (item.attempts || 0) + 1;
      if (!item.createdAt) {
        item.createdAt = new Date().toISOString();
      }

      this._applyStatusTransition(item, prevStatus, item.status);

      // Write immediately
      await this._writeToFile();

      return item;
    });
  }

  /**
   * Update an item atomically (thread-safe)
   * @param {number} index - Item index
   * @param {Object} updates - Fields to update
   * @param {string|number} workerId - Worker that owns this item
   */
  async updateItemAtomic(index, updates, workerId = null) {
    await this.lock.withLock(async () => {
      // Reload to get latest state
      await this._reloadFromDisk();

      const item = this.manifest.items[index];
      if (!item) {
        throw new Error(`Item ${index} not found in manifest`);
      }

      // Verify worker ownership if specified
      if (workerId && item.workerId !== workerId) {
        throw new Error(`Worker ${workerId} does not own item ${index}`);
      }

      const prevStatus = item.status;

      // Apply updates
      Object.assign(item, updates);
      this._applyStatusTransition(item, prevStatus, updates.status);

      await this._writeToFile();
    });
  }

  /**
   * Update run status atomically
   * @param {string} status - New status
   * @param {string} stopReason - Optional reason for stopping
   */
  async updateStatusAtomic(status, stopReason = null) {
    await this.lock.withLock(async () => {
      await this._reloadFromDisk();
      this.manifest.status = status;
      if (stopReason) {
        this.manifest.stopReason = stopReason;
      }
      await this._writeToFile();
    });
  }
}

export default ManifestManager;
