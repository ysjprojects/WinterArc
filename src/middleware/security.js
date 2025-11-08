const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const config = require('../config');
const logger = require('../utils/logger');
const { RateLimitError, AuthenticationError } = require('../utils/errors');

// Webhook signature validation
const validateTelegramWebhook = (req, res, next) => {
  try {
    const token = config.telegram.token;
    const secretPath = `/bot${token}`;
    
    if (req.path !== secretPath) {
      logger.security('Invalid webhook path accessed', {
        requestedPath: req.path,
        expectedPath: secretPath,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      throw new AuthenticationError('Invalid webhook path');
    }
    
    // Validate Telegram signature if present
    const telegramSignature = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (telegramSignature) {
      // You should set a secret token in your webhook configuration
      const expectedSignature = crypto
        .createHmac('sha256', config.security.jwtSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      
      if (telegramSignature !== expectedSignature) {
        logger.security('Invalid Telegram webhook signature', {
          ip: req.ip,
          userAgent: req.get('User-Agent')
        });
        throw new AuthenticationError('Invalid signature');
      }
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

// Rate limiting configuration
const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.security('Rate limit exceeded', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.path
      });
      throw new RateLimitError(message);
    }
  });
};

// General rate limiter
const generalRateLimit = createRateLimiter(
  config.rateLimit.windowMs,
  config.rateLimit.maxRequests,
  'Too many requests, please try again later'
);

// Strict rate limiter for sensitive operations
const strictRateLimit = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  10, // 10 requests
  'Too many sensitive operations, please wait before trying again'
);

// Payment-specific rate limiter
const paymentRateLimit = createRateLimiter(
  60 * 1000, // 1 minute
  5, // 5 payments per minute
  'Too many payment requests, please wait before sending another payment'
);

// Security headers middleware
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false
});

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      // Remove potentially dangerous characters
      return obj.replace(/[<>'"]/g, '');
    }
    if (typeof obj === 'object' && obj !== null) {
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        sanitized[key] = sanitize(value);
      }
      return sanitized;
    }
    return obj;
  };

  if (req.body) {
    req.body = sanitize(req.body);
  }
  if (req.query) {
    req.query = sanitize(req.query);
  }
  if (req.params) {
    req.params = sanitize(req.params);
  }

  next();
};

// Request logging middleware
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    };
    
    if (res.statusCode >= 400) {
      logger.warn('HTTP request failed', logData);
    } else {
      logger.info('HTTP request completed', logData);
    }
  });
  
  next();
};

// Block suspicious requests
const blockSuspiciousRequests = (req, res, next) => {
  const suspiciousPatterns = [
    /\.\.\//,  // Path traversal
    /<script/i, // XSS attempts
    /union.*select/i, // SQL injection
    /javascript:/i, // JavaScript protocol
    /vbscript:/i, // VBScript protocol
  ];
  
  const checkString = `${req.url}${JSON.stringify(req.body)}${JSON.stringify(req.query)}`;
  
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(checkString)) {
      logger.security('Suspicious request blocked', {
        pattern: pattern.toString(),
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      throw new AuthenticationError('Suspicious request detected');
    }
  }
  
  next();
};

module.exports = {
  validateTelegramWebhook,
  generalRateLimit,
  strictRateLimit,
  paymentRateLimit,
  securityHeaders,
  sanitizeInput,
  requestLogger,
  blockSuspiciousRequests
};