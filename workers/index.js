// Cloudflare Workers entry point for ARC Telegram Bot

import { WorkerBot } from './bot.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const bot = new WorkerBot(env);
      return await bot.handleRequest(request, ctx);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  },

  // Scheduled handler for cleanup tasks
  async scheduled(controller, env, ctx) {
    try {
      const bot = new WorkerBot(env);
      await bot.handleScheduled(controller, ctx);
    } catch (error) {
      console.error('Scheduled task error:', error);
    }
  }
};