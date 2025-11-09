const { validateEnvironment } = require('../../scripts/validate-env');

class Config {
  constructor() {
    this.env = validateEnvironment();
    this._initializeConfig();
  }

  _initializeConfig() {
    this.telegram = {
      token: this.env.TELEGRAM_BOT_TOKEN,
      webhookUrl: this.env.WEBHOOK_URL,
      botUsername: this.env.TELEGRAM_BOT_USERNAME || 'arc_pay_bot'
    };

    this.auth0 = {
      domain: this.env.AUTH0_DOMAIN,
      clientId: this.env.AUTH0_CLIENT_ID,
      clientSecret: this.env.AUTH0_CLIENT_SECRET,
      managementToken: this.env.AUTH0_MANAGEMENT_TOKEN
    };

    this.server = {
      port: this.env.PORT,
      nodeEnv: this.env.NODE_ENV
    };


    this.arc = {
      rpcUrl: this.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network',
      chainId: this.env.ARC_CHAIN_ID || '5042002',
      explorerUrl: this.env.ARC_EXPLORER_URL || 'https://testnet.arcscan.app'
    };

    this.security = {
      encryptionKey: this.env.ENCRYPTION_KEY,
      jwtSecret: this.env.JWT_SECRET
    };

    this.rateLimit = {
      windowMs: this.env.RATE_LIMIT_WINDOW_MS,
      maxRequests: this.env.RATE_LIMIT_MAX_REQUESTS
    };

    this.logging = {
      level: this.env.LOG_LEVEL
    };

    this.openai = {
      apiKey: this.env.OPENAI_API_KEY
    };

    this.database = {
      url: this.env.DATABASE_URL
    };
  }

  get isDevelopment() {
    return this.server.nodeEnv === 'development';
  }

  get isProduction() {
    return this.server.nodeEnv === 'production';
  }


  get isARCTestnet() {
    return this.arc.chainId === '5042002';
  }
}

module.exports = new Config();