import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * Manifest manager for tracking run state
 */
export class ManifestManager {
  constructor(runDir) {
    this.runDir = runDir;
    this.manifestPath = path.join(runDir, 'manifest.json');
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
   * Save manifest to disk
   */
  async save() {
    if (!this.manifest) {
      throw new Error('No manifest to save');
    }

    this.manifest.updatedAt = new Date().toISOString();
    await fs.writeFile(
      this.manifestPath,
      JSON.stringify(this.manifest, null, 2),
      'utf-8'
    );
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

    Object.assign(item, updates);

    // Update counters
    if (updates.status === 'COMPLETED') {
      this.manifest.completedCount++;
      item.completedAt = new Date().toISOString();
    } else if (updates.status === 'FAILED') {
      this.manifest.failedCount++;
    }

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
    const { batchSize, completedCount, failedCount, status, stopReason } = this.manifest;
    return {
      total: batchSize,
      completed: completedCount,
      failed: failedCount,
      remaining: batchSize - completedCount - failedCount,
      status,
      stopReason,
    };
  }
}

export default ManifestManager;
