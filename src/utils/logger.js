const winston = require('winston');
const path = require('path');
const config = require('../config');

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      log += `\n${JSON.stringify(meta, null, 2)}`;
    }
    return log;
  })
);

const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  defaultMeta: { service: 'arc-telegram-bot' },
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    })
  ]
});

if (!config.isProduction) {
  logger.add(new winston.transports.Console({
    format: consoleFormat
  }));
}

// Sanitize sensitive data from logs
const sanitizeLogData = (data) => {
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
      sanitized[key] = sanitizeLogData(value);
    }
  }
  
  return sanitized;
};

// Override logger methods to sanitize data
const originalMethods = ['error', 'warn', 'info', 'debug'];
originalMethods.forEach(method => {
  const original = logger[method];
  logger[method] = function(message, meta = {}) {
    const sanitizedMeta = sanitizeLogData(meta);
    return original.call(this, message, sanitizedMeta);
  };
});

// Add custom methods
logger.security = (message, meta = {}) => {
  logger.warn(`[SECURITY] ${message}`, sanitizeLogData(meta));
};

logger.audit = (action, userId, meta = {}) => {
  logger.info(`[AUDIT] ${action}`, {
    userId,
    timestamp: new Date().toISOString(),
    ...sanitizeLogData(meta)
  });
};

logger.transaction = (txHash, userId, amount, meta = {}) => {
  logger.info(`[TRANSACTION] ${txHash}`, {
    userId,
    amount,
    timestamp: new Date().toISOString(),
    ...sanitizeLogData(meta)
  });
};

module.exports = logger;