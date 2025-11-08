// Cloudflare Workers Bot Implementation

import { Router } from 'itty-router';
import { TelegramAPI } from './services/telegram.js';
import { Auth0Service } from './services/auth0.js';
import { ARCService } from './services/arc.js';
import { BotController } from './controllers/bot.js';
import { validateEnvironment } from './utils/validation.js';
import { Logger } from './utils/logger.js';

export class WorkerBot {
  constructor(env) {
    this.env = env;
    this.logger = new Logger(env.LOG_LEVEL || 'info');
    
    // Validate environment
    this.config = validateEnvironment(env);
    
    // Initialize services
    this.telegram = new TelegramAPI(this.config.TELEGRAM_BOT_TOKEN, this.logger);
    this.auth0 = new Auth0Service(this.config, this.logger);
    this.arc = new ARCService(this.config, this.logger);
    
    // Initialize controller
    this.controller = new BotController({
      telegram: this.telegram,
      auth0: this.auth0,
      arc: this.arc,
      logger: this.logger,
      env: this.env
    });

    // Setup router
    this.router = Router();
    this.setupRoutes();
  }

  setupRoutes() {
    // Health check
    this.router.get('/health', () => this.handleHealth());
    
    // Stats endpoint
    this.router.get('/stats', () => this.handleStats());
    
    // Telegram webhook
    this.router.post('/bot:token', (request) => this.handleWebhook(request));
    
    // Catch all
    this.router.all('*', () => new Response('Not Found', { status: 404 }));
  }

  async handleRequest(request, ctx) {
    try {
      // Add CORS headers
      const response = await this.router.handle(request);
      
      if (response) {
        response.headers.set('Access-Control-Allow-Origin', '*');
        response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
      }
      
      return response;
    } catch (error) {
      this.logger.error('Request handling error', { 
        error: error.message,
        stack: error.stack,
        url: request.url 
      });
      
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async handleHealth() {
    try {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        services: {
          telegram: { status: 'healthy' },
          auth0: await this.auth0.healthCheck(),
          arc: await this.arc.healthCheck()
        }
      };

      const overallHealthy = Object.values(health.services)
        .every(service => service.status === 'healthy');

      return new Response(JSON.stringify(health), {
        status: overallHealthy ? 200 : 503,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      this.logger.error('Health check failed', { error: error.message });
      
      return new Response(JSON.stringify({
        status: 'unhealthy',
        error: error.message
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async handleStats() {
    try {
      const stats = await this.auth0.getUserStats();
      
      return new Response(JSON.stringify({
        users: stats.totalUsers,
        network: `arc-${this.config.ARC_CHAIN_ID}`,
        timestamp: stats.timestamp
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      this.logger.error('Stats endpoint failed', { error: error.message });
      
      return new Response(JSON.stringify({
        error: 'Failed to get stats'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async handleWebhook(request) {
    try {
      // Validate webhook path
      const url = new URL(request.url);
      const token = url.pathname.split('/bot')[1];
      
      if (token !== this.config.TELEGRAM_BOT_TOKEN) {
        this.logger.security('Invalid webhook token', {
          requestedToken: token?.substring(0, 10) + '...',
          ip: request.headers.get('CF-Connecting-IP')
        });
        return new Response('Unauthorized', { status: 401 });
      }

      // Rate limiting check
      const rateLimitResult = await this.checkRateLimit(request);
      if (rateLimitResult) {
        return rateLimitResult;
      }

      // Process update
      const update = await request.json();
      await this.controller.processUpdate(update);
      
      return new Response('OK', { status: 200 });
    } catch (error) {
      this.logger.error('Webhook processing failed', {
        error: error.message,
        stack: error.stack
      });
      
      // Always return 200 to Telegram to avoid retries
      return new Response('OK', { status: 200 });
    }
  }

  async checkRateLimit(request) {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = `rate_limit:${ip}`;
      
      // Simple rate limiting using KV store
      if (this.env.SESSIONS) {
        const current = await this.env.SESSIONS.get(key);
        const requests = current ? parseInt(current) : 0;
        
        if (requests >= (this.config.RATE_LIMIT_MAX_REQUESTS || 100)) {
          this.logger.security('Rate limit exceeded', { ip, requests });
          return new Response('Rate limit exceeded', { status: 429 });
        }
        
        // Increment counter with TTL
        await this.env.SESSIONS.put(key, (requests + 1).toString(), {
          expirationTtl: Math.floor((this.config.RATE_LIMIT_WINDOW_MS || 900000) / 1000)
        });
      }
      
      return null;
    } catch (error) {
      this.logger.error('Rate limit check failed', { error: error.message });
      return null; // Don't block on rate limit errors
    }
  }

  async handleScheduled(controller, ctx) {
    try {
      this.logger.info('Running scheduled cleanup tasks');
      
      // Cleanup expired sessions, rate limits, etc.
      if (this.env.SESSIONS) {
        // KV automatically handles TTL cleanup
        this.logger.info('Session cleanup completed');
      }
      
      // Health check all services
      await this.handleHealth();
      
    } catch (error) {
      this.logger.error('Scheduled task failed', { error: error.message });
    }
  }
}