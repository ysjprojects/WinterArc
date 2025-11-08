const Joi = require('joi');
const { ValidationError } = require('./errors');

// EVM address validation
const evmAddressSchema = Joi.string()
  .pattern(/^0x[a-fA-F0-9]{40}$/)
  .required()
  .messages({
    'string.pattern.base': 'Invalid EVM address format'
  });

// Telegram username validation
const telegramUsernameSchema = Joi.string()
  .pattern(/^@?[a-zA-Z0-9_]{5,32}$/)
  .required()
  .messages({
    'string.pattern.base': 'Invalid Telegram username format'
  });

// Amount validation
const amountSchema = Joi.number()
  .positive()
  .precision(6) // USDC supports up to 6 decimal places
  .max(1000000000000) // 1 trillion USDC max for safety
  .required()
  .messages({
    'number.positive': 'Amount must be positive',
    'number.max': 'Amount exceeds maximum allowed value'
  });

// Payment request validation
const paymentRequestSchema = Joi.object({
  recipient: Joi.alternatives().try(
    evmAddressSchema,
    telegramUsernameSchema,
    Joi.number().integer().positive() // Telegram user ID
  ).required(),
  amount: amountSchema,
  memo: Joi.string().max(500).optional()
});

// QR code generation validation
const qrRequestSchema = Joi.object({
  amount: amountSchema.optional(),
  destinationTag: Joi.number().integer().min(0).max(4294967295).optional()
});

// User registration validation
const userRegistrationSchema = Joi.object({
  telegramId: Joi.number().integer().positive().required(),
  username: Joi.string().alphanum().min(3).max(32).optional(),
  firstName: Joi.string().max(100).optional(),
  lastName: Joi.string().max(100).optional()
});

// Friend alias validation
const friendAliasSchema = Joi.string()
  .pattern(/^[^@][a-zA-Z0-9_-]{0,15}$/)
  .min(1)
  .max(16)
  .invalid('me', 'Me', 'ME') // Prevent "me" as alias
  .required()
  .messages({
    'string.pattern.base': 'Alias must not start with @ and can only contain letters, numbers, underscores, and hyphens',
    'string.min': 'Alias must be at least 1 character',
    'string.max': 'Alias must be at most 16 characters',
    'any.invalid': 'Cannot use "me" as an alias - it\'s reserved'
  });

// Generic validation middleware factory
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    try {
      const { error, value } = schema.validate(req[property], {
        abortEarly: false,
        stripUnknown: true
      });

      if (error) {
        const details = error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message,
          value: detail.context?.value
        }));

        throw new ValidationError('Validation failed', details);
      }

      req[property] = value;
      next();
    } catch (err) {
      next(err);
    }
  };
};

// Specific validators
const validatePayment = validate(paymentRequestSchema);
const validateQR = validate(qrRequestSchema);
const validateUserRegistration = validate(userRegistrationSchema);

// Manual validation functions
const isValidEVMAddress = (address) => {
  try {
    evmAddressSchema.validate(address);
    return true;
  } catch {
    return false;
  }
};

const isValidTelegramUsername = (username) => {
  try {
    telegramUsernameSchema.validate(username);
    return true;
  } catch {
    return false;
  }
};

const isValidAmount = (amount) => {
  try {
    amountSchema.validate(amount);
    return true;
  } catch {
    return false;
  }
};

const isValidFriendAlias = (alias) => {
  try {
    friendAliasSchema.validate(alias);
    return true;
  } catch {
    return false;
  }
};

// Sanitize Telegram message content
const sanitizeTelegramMessage = (text) => {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  // Remove potentially harmful characters but keep basic formatting
  return text
    .replace(/[<>]/g, '') // Remove HTML-like tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/vbscript:/gi, '') // Remove vbscript: protocol
    .trim()
    .substring(0, 4096); // Telegram message limit
};

// Parse recipient from various formats
const parseRecipient = (recipient) => {
  if (!recipient || typeof recipient !== 'string') {
    throw new ValidationError('Recipient is required');
  }

  const trimmed = recipient.trim();

  // EVM address
  if (trimmed.startsWith('0x') && trimmed.length === 42) {
    if (isValidEVMAddress(trimmed)) {
      return { type: 'address', value: trimmed };
    }
    throw new ValidationError('Invalid EVM address format');
  }

  // Telegram username
  if (trimmed.startsWith('@')) {
    const username = trimmed.substring(1);
    if (isValidTelegramUsername(username)) {
      return { type: 'username', value: username };
    }
    throw new ValidationError('Invalid Telegram username format');
  }

  // Telegram user ID
  if (/^\d+$/.test(trimmed)) {
    const userId = parseInt(trimmed);
    if (userId > 0) {
      return { type: 'userId', value: userId };
    }
    throw new ValidationError('Invalid Telegram user ID');
  }

  // Friend alias (must not start with @, max 16 chars)
  if (trimmed.length <= 16 && !trimmed.startsWith('@')) {
    if (isValidFriendAlias(trimmed)) {
      return { type: 'alias', value: trimmed };
    }
    throw new ValidationError('Invalid friend alias format');
  }

  throw new ValidationError('Invalid recipient format');
};

// Validate command arguments
const validateCommandArgs = (args, expectedCount, commandName) => {
  if (!Array.isArray(args)) {
    throw new ValidationError(`Invalid arguments for /${commandName}`);
  }

  if (args.length < expectedCount) {
    throw new ValidationError(`Insufficient arguments for /${commandName}. Expected ${expectedCount}, got ${args.length}`);
  }

  return args.slice(0, expectedCount);
};

module.exports = {
  validate,
  validatePayment,
  validateQR,
  validateUserRegistration,
  isValidEVMAddress,
  isValidTelegramUsername,
  isValidAmount,
  isValidFriendAlias,
  sanitizeTelegramMessage,
  parseRecipient,
  validateCommandArgs,
  schemas: {
    evmAddress: evmAddressSchema,
    telegramUsername: telegramUsernameSchema,
    amount: amountSchema,
    paymentRequest: paymentRequestSchema,
    qrRequest: qrRequestSchema,
    userRegistration: userRegistrationSchema,
    friendAlias: friendAliasSchema
  }
};