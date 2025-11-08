class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, field = null) {
    super(message, 400);
    this.field = field;
    this.type = 'ValidationError';
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401);
    this.type = 'AuthenticationError';
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403);
    this.type = 'AuthorizationError';
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
    this.type = 'NotFoundError';
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429);
    this.type = 'RateLimitError';
  }
}

class ExternalServiceError extends AppError {
  constructor(service, originalError) {
    super(`${service} service error: ${originalError.message}`, 502);
    this.service = service;
    this.originalError = originalError;
    this.type = 'ExternalServiceError';
  }
}


class ARCError extends AppError {
  constructor(message, txResult = null) {
    super(`ARC Error: ${message}`, 400);
    this.txResult = txResult;
    this.type = 'ARCError';
  }
}

class InsufficientFundsError extends AppError {
  constructor(required, available, currency = 'USDC') {
    super(`Insufficient ${currency} funds. Required: ${required}, Available: ${available}`, 400);
    this.required = required;
    this.available = available;
    this.currency = currency;
    this.type = 'InsufficientFundsError';
  }
}

// Error handler middleware
const errorHandler = (logger) => {
  return (error, req, res, next) => {
    // Default to 500 server error
    let { statusCode = 500, message } = error;
    
    if (!error.isOperational) {
      // Log unexpected errors
      logger.error('Unexpected error occurred', {
        error: error.message,
        stack: error.stack,
        url: req?.url,
        method: req?.method,
        userAgent: req?.get('User-Agent')
      });
      
      // Don't leak error details in production
      if (process.env.NODE_ENV === 'production') {
        message = 'Internal server error';
      }
    } else {
      // Log operational errors
      logger.warn('Operational error', {
        error: error.message,
        type: error.type,
        statusCode: error.statusCode,
        url: req?.url,
        method: req?.method
      });
    }
    
    // Send error response
    if (res && !res.headersSent) {
      res.status(statusCode).json({
        success: false,
        error: {
          message,
          type: error.type || 'Error',
          timestamp: error.timestamp || new Date().toISOString()
        }
      });
    }
    
    if (next) {
      next();
    }
  };
};

// Async wrapper to catch async errors
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ExternalServiceError,
  ARCError,
  InsufficientFundsError,
  errorHandler,
  asyncHandler
};