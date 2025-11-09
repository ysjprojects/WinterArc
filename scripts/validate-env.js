#!/usr/bin/env node

const Joi = require('joi');
require('dotenv').config();

const envSchema = Joi.object({
  TELEGRAM_BOT_TOKEN: Joi.string().required().description('Telegram Bot Token'),
  AUTH0_DOMAIN: Joi.string().required().description('Auth0 Domain'),
  AUTH0_CLIENT_ID: Joi.string().required().description('Auth0 Client ID'),
  AUTH0_CLIENT_SECRET: Joi.string().required().description('Auth0 Client Secret'),
  AUTH0_MANAGEMENT_TOKEN: Joi.string().required().description('Auth0 Management Token'),
  WEBHOOK_URL: Joi.string().uri().required().description('Webhook URL'),
  PORT: Joi.number().port().default(3000).description('Server Port'),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  ARC_RPC_URL: Joi.string().uri().default('https://rpc.testnet.arc.network').description('ARC Network RPC URL'),
  ARC_CHAIN_ID: Joi.string().default('5042002').description('ARC Chain ID'),
  ARC_EXPLORER_URL: Joi.string().uri().default('https://testnet.arcscan.app').description('ARC Explorer URL'),
  ENCRYPTION_KEY: Joi.string().length(32).required().description('32-character encryption key'),
  JWT_SECRET: Joi.string().min(32).required().description('JWT Secret'),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(900000).description('Rate limit window in milliseconds'),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100).description('Max requests per window'),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  OPENAI_API_KEY: Joi.string().optional().description('OpenAI API Key for agent functionality'),
  DATABASE_URL: Joi.string().optional().description('Database URL (optional)')
}).unknown();

function validateEnvironment() {
  const { error, value } = envSchema.validate(process.env);
  
  if (error) {
    console.error('❌ Environment validation failed:');
    error.details.forEach(detail => {
      console.error(`  - ${detail.message}`);
    });
    process.exit(1);
  }
  
  console.log('✅ Environment validation passed');
  
  // Check for security warnings
  const warnings = [];
  
  if (value.NODE_ENV === 'production') {
    if (value.ARC_CHAIN_ID === '5042002') {
      warnings.push('Using testnet in production environment');
    }
    if (value.LOG_LEVEL === 'debug') {
      warnings.push('Debug logging enabled in production');
    }
  }
  
  if (warnings.length > 0) {
    console.warn('⚠️  Security warnings:');
    warnings.forEach(warning => {
      console.warn(`  - ${warning}`);
    });
  }
  
  return value;
}

if (require.main === module) {
  validateEnvironment();
}

module.exports = { validateEnvironment };