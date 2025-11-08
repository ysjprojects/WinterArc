// Environment validation for Cloudflare Workers

export function validateEnvironment(env) {
  const required = [
    'TELEGRAM_BOT_TOKEN',
    'AUTH0_DOMAIN',
    'AUTH0_CLIENT_ID', 
    'AUTH0_CLIENT_SECRET',
    'AUTH0_MANAGEMENT_TOKEN',
    'ENCRYPTION_KEY',
    'JWT_SECRET'
  ];

  const missing = required.filter(key => !env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate encryption key length
  if (env.ENCRYPTION_KEY.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 characters');
  }

  // Validate JWT secret length
  if (env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }

  return {
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    AUTH0_DOMAIN: env.AUTH0_DOMAIN,
    AUTH0_CLIENT_ID: env.AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET: env.AUTH0_CLIENT_SECRET,
    AUTH0_MANAGEMENT_TOKEN: env.AUTH0_MANAGEMENT_TOKEN,
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    JWT_SECRET: env.JWT_SECRET,
    ARC_RPC_URL: env.ARC_RPC_URL || 'https://rpc.testnet.arc.network',
    ARC_CHAIN_ID: env.ARC_CHAIN_ID || '5042002',
    ARC_EXPLORER_URL: env.ARC_EXPLORER_URL || 'https://testnet.arcscan.app',
    RATE_LIMIT_WINDOW_MS: parseInt(env.RATE_LIMIT_WINDOW_MS || '900000'),
    RATE_LIMIT_MAX_REQUESTS: parseInt(env.RATE_LIMIT_MAX_REQUESTS || '100'),
    LOG_LEVEL: env.LOG_LEVEL || 'info'
  };
}

// Input validation helpers
export function validateEVMAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function validateAmount(amount) {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0 && num <= 1000000000000;
}

export function validateTelegramUsername(username) {
  const clean = username.replace('@', '');
  return /^[a-zA-Z0-9_]{5,32}$/.test(clean);
}

export function parseRecipient(recipient) {
  if (!recipient || typeof recipient !== 'string') {
    throw new Error('Recipient is required');
  }

  const trimmed = recipient.trim();

  // EVM address
  if (trimmed.startsWith('0x') && trimmed.length === 42) {
    if (validateEVMAddress(trimmed)) {
      return { type: 'address', value: trimmed };
    }
    throw new Error('Invalid EVM address format');
  }

  // Telegram username
  if (trimmed.startsWith('@')) {
    const username = trimmed.substring(1);
    if (validateTelegramUsername(username)) {
      return { type: 'username', value: username };
    }
    throw new Error('Invalid Telegram username format');
  }

  // Telegram user ID
  if (/^\d+$/.test(trimmed)) {
    const userId = parseInt(trimmed);
    if (userId > 0) {
      return { type: 'userId', value: userId };
    }
    throw new Error('Invalid Telegram user ID');
  }

  throw new Error('Invalid recipient format');
}

export function sanitizeInput(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  return text
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/vbscript:/gi, '')
    .trim()
    .substring(0, 4096);
}