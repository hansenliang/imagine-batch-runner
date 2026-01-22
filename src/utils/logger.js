import fs from 'fs/promises';
import chalk from 'chalk';

export class Logger {
  constructor(runDir = null) {
    this.runDir = runDir;
    this.logFile = runDir ? path.join(runDir, 'run.log') : null;
  }

  async _writeToFile(message) {
    if (!this.logFile) return;

    try {
      const now = new Date();
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      await fs.appendFile(this.logFile, `[${timestamp}] ${message}\n`);
    } catch (error) {
      // Silent fail for logging errors
    }
  }

  _formatMessage(level, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    let formatted = `[${timestamp}] ${level}: ${message}`;
    if (data) {
      formatted += '\n' + JSON.stringify(data, null, 2);
    }
    return formatted;
  }

  async info(message, data = null) {
    const formatted = this._formatMessage('INFO', message, data);
    console.log(chalk.blue(formatted));
    await this._writeToFile(formatted);
  }

  async success(message, data = null) {
    const formatted = this._formatMessage('SUCCESS', message, data);
    console.log(chalk.green(formatted));
    await this._writeToFile(formatted);
  }

  async warn(message, data = null) {
    const formatted = this._formatMessage('WARN', message, data);
    console.log(chalk.yellow(formatted));
    await this._writeToFile(formatted);
  }

  async error(message, error = null, data = null) {
    const formatted = this._formatMessage('ERROR', message, {
      error: error?.message || error,
      stack: error?.stack,
      ...data
    });
    console.error(chalk.red(formatted));
    await this._writeToFile(formatted);
  }

  async debug(message, data = null) {
    if (process.env.DEBUG) {
      const formatted = this._formatMessage('DEBUG', message, data);
      console.log(chalk.gray(formatted));
      await this._writeToFile(formatted);
    }
  }

  async logToFileOnly(message) {
    await this._writeToFile(message);
  }
}

export default Logger;
