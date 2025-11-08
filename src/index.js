#!/usr/bin/env node

const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const { errorHandler } = require('./utils/errors');

// Import services
const telegramService = require('./services/telegramService');
const arcService = require('./services/arcService');
const auth0Service = require('./services/auth0Service');

// Import middleware
const {
  validateTelegramWebhook,
  generalRateLimit,
  securityHeaders,
  sanitizeInput,
  requestLogger,
  blockSuspiciousRequests
} = require('./middleware/security');

// Import controllers
const botController = require('./controllers/botController');

class ARCTelegramBot {
  constructor() {
    this.app = express();
    this.bot = null;
    this.isShuttingDown = false;
  }

  async initialize() {
    try {
      logger.info('Starting ARC Telegram Bot', {
        version: require('../package.json').version,
        nodeEnv: config.server.nodeEnv,
        arcChainId: config.arc.chainId
      });

      // Setup Express middleware
      this.setupMiddleware();

      // Initialize services
      await this.initializeServices();

      // Setup routes
      this.setupRoutes();

      // Setup error handling
      this.setupErrorHandling();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      return true;
    } catch (error) {
      logger.error('Failed to initialize bot', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  setupMiddleware() {
    // Security headers
    this.app.use(securityHeaders);

    // Request parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Security middleware
    this.app.use(blockSuspiciousRequests);
    this.app.use(sanitizeInput);

    // Rate limiting
    this.app.use(generalRateLimit);

    // Request logging
    this.app.use(requestLogger);

    // Trust proxy if behind reverse proxy
    if (config.isProduction) {
      this.app.set('trust proxy', 1);
    }
  }

  async initializeServices() {
    logger.info('Initializing services...');

    try {
      // Initialize Telegram service
      this.bot = telegramService.initialize();
      logger.info('Telegram service initialized');

      // Connect to ARC Network
      await arcService.connect();
      logger.info('ARC Network service connected');

      // Test Auth0 connection
      const auth0Health = await auth0Service.healthCheck();
      if (auth0Health.status === 'healthy') {
        logger.info('Auth0 service healthy');
      } else {
        logger.warn('Auth0 service unhealthy', auth0Health);
      }

      // Set webhook for Telegram
      if (config.telegram.webhookUrl && !config.isDevelopment) {
        await telegramService.setWebhook();
        logger.info('Telegram webhook configured');
      }

    } catch (error) {
      logger.error('Service initialization failed', {
        error: error.message
      });
      throw error;
    }
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', async (req, res) => {
      try {
        const health = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: require('../package.json').version,
          services: {
            telegram: { status: 'healthy' },
            arc: await arcService.healthCheck(),
            auth0: await auth0Service.healthCheck()
          }
        };

        const overallHealthy = Object.values(health.services)
          .every(service => service.status === 'healthy');

        res.status(overallHealthy ? 200 : 503).json(health);
      } catch (error) {
        logger.error('Health check failed', { error: error.message });
        res.status(503).json({
          status: 'unhealthy',
          error: error.message
        });
      }
    });

    // Telegram webhook endpoint
    this.app.post(
      `/bot${config.telegram.token}`,
      validateTelegramWebhook,
      async (req, res) => {
        try {
          await telegramService.processUpdate(req.body);
          res.sendStatus(200);
        } catch (error) {
          logger.error('Webhook processing failed', {
            error: error.message,
            updateId: req.body.update_id
          });
          res.sendStatus(200); // Always return 200 to Telegram
        }
      }
    );

    // Stats endpoint (basic)
    this.app.get('/stats', async (req, res) => {
      try {
        const stats = await auth0Service.getUserStats();
        res.json({
          users: stats.totalUsers,
          network: `arc-${config.arc.chainId}`,
          timestamp: stats.timestamp
        });
      } catch (error) {
        logger.error('Stats endpoint failed', { error: error.message });
        res.status(500).json({ error: 'Failed to get stats' });
      }
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      logger.warn('Route not found', {
        method: req.method,
        path: req.path,
        ip: req.ip
      });
      res.status(404).json({
        error: 'Not found',
        message: 'The requested endpoint does not exist'
      });
    });
  }

  setupErrorHandling() {
    // Global error handler
    this.app.use(errorHandler(logger));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack
      });
      
      if (!config.isDevelopment) {
        this.gracefulShutdown('uncaughtException');
      }
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled promise rejection', {
        reason: reason?.message || reason,
        stack: reason?.stack
      });
      
      if (!config.isDevelopment) {
        this.gracefulShutdown('unhandledRejection');
      }
    });
  }

  setupGracefulShutdown() {
    const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
    
    signals.forEach(signal => {
      process.on(signal, () => {
        logger.info(`Received ${signal}, starting graceful shutdown`);
        this.gracefulShutdown(signal);
      });
    });
  }

  async gracefulShutdown(reason) {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    logger.info('Starting graceful shutdown', { reason });

    // Set a timeout for forced shutdown
    const forceShutdownTimeout = setTimeout(() => {
      logger.error('Forced shutdown due to timeout');
      process.exit(1);
    }, 30000); // 30 seconds

    try {
      // Stop accepting new requests
      if (this.server) {
        this.server.close(() => {
          logger.info('HTTP server closed');
        });
      }

      // Disconnect from services
      await arcService.disconnect();
      logger.info('ARC Network disconnected');

      clearTimeout(forceShutdownTimeout);
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown', {
        error: error.message
      });
      clearTimeout(forceShutdownTimeout);
      process.exit(1);
    }
  }

  async start() {
    try {
      await this.initialize();
      
      this.server = this.app.listen(config.server.port, () => {
        logger.info('ARC Telegram Bot started successfully', {
          port: config.server.port,
          environment: config.server.nodeEnv,
          network: `arc-${config.arc.chainId}`
        });
      });

      return this.server;
    } catch (error) {
      logger.error('Failed to start bot', {
        error: error.message,
        stack: error.stack
      });
      process.exit(1);
    }
  }
}

// Start the bot if this file is run directly
if (require.main === module) {
  const bot = new ARCTelegramBot();
  bot.start().catch(error => {
    console.error('Fatal error starting bot:', error);
    process.exit(1);
  });
}

module.exports = ARCTelegramBot;