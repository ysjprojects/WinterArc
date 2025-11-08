// Simplified logger for Cloudflare Workers

export class Logger {
  constructor(level = 'info') {
    this.level = level;
    this.levels = {
      error: 0,
      warn: 1, 
      info: 2,
      debug: 3
    };
  }

  shouldLog(level) {
    return this.levels[level] <= this.levels[this.level];
  }

  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const sanitizedMeta = this.sanitizeLogData(meta);
    
    return JSON.stringify({
      timestamp,
      level: level.toUpperCase(),
      message,
      service: 'arc-telegram-bot',
      ...sanitizedMeta
    });
  }

  sanitizeLogData(data) {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    const sensitiveKeys = [
      'password', 'token', 'secret', 'key', 'seed', 'private',
      'auth', 'credential', 'api_key', 'access_token'
    ];

    const sanitized = { ...data };
    
    for (const [key, value] of Object.entries(sanitized)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeLogData(value);
      }
    }
    
    return sanitized;
  }

  error(message, meta = {}) {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, meta));
    }
  }

  warn(message, meta = {}) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  info(message, meta = {}) {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, meta));
    }
  }

  debug(message, meta = {}) {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }

  security(message, meta = {}) {
    this.warn(`[SECURITY] ${message}`, meta);
  }

  audit(action, userId, meta = {}) {
    this.info(`[AUDIT] ${action}`, {
      userId,
      timestamp: new Date().toISOString(),
      ...meta
    });
  }

  transaction(txHash, userId, amount, meta = {}) {
    this.info(`[TRANSACTION] ${txHash}`, {
      userId,
      amount,
      timestamp: new Date().toISOString(),
      ...meta
    });
  }
}