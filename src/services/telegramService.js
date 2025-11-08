const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const config = require('../config');
const logger = require('../utils/logger');
const { validateCommandArgs, parseRecipient, sanitizeTelegramMessage } = require('../utils/validation');
const { ValidationError, RateLimitError } = require('../utils/errors');

class TelegramService {
  constructor() {
    this.bot = null;
    this.userSessions = new Map();
    this.commandHandlers = new Map();
    this.callbackHandlers = new Map();
    this.setupCommandHandlers();
  }

  initialize() {
    try {
      // Use polling in development, webhook in production
      const usePolling = config.isDevelopment;
      
      this.bot = new TelegramBot(config.telegram.token, { 
        polling: usePolling,
        webhook: !usePolling
      });
      
      // Set up message handlers for polling mode
      if (usePolling) {
        this.setupPollingHandlers();
      }
      
      logger.info('Telegram bot initialized', {
        mode: usePolling ? 'polling' : 'webhook',
        webhookUrl: usePolling ? null : config.telegram.webhookUrl
      });

      return this.bot;
    } catch (error) {
      logger.error('Failed to initialize Telegram bot', {
        error: error.message
      });
      throw error;
    }
  }

  setupCommandHandlers() {
    // Command handlers will be set by the main bot controller
    this.commandHandlers.set('start', this.handleStart.bind(this));
    this.commandHandlers.set('help', this.handleHelp.bind(this));
    this.commandHandlers.set('balance', this.handleBalance.bind(this));
    this.commandHandlers.set('pay', this.handlePay.bind(this));
    this.commandHandlers.set('request', this.handleRequest.bind(this));
    this.commandHandlers.set('qr', this.handleQR.bind(this));
    this.commandHandlers.set('myqr', this.handleMyQR.bind(this));
    this.commandHandlers.set('history', this.handleHistory.bind(this));
  }

  setupPollingHandlers() {
    // Handle all messages in polling mode
    this.bot.on('message', async (msg) => {
      try {
        await this.processUpdate({ message: msg });
      } catch (error) {
        logger.error('Error processing polling message', {
          error: error.message,
          messageId: msg.message_id
        });
      }
    });

    // Handle callback queries
    this.bot.on('callback_query', async (query) => {
      try {
        await this.processUpdate({ callback_query: query });
      } catch (error) {
        logger.error('Error processing polling callback', {
          error: error.message,
          queryId: query.id
        });
      }
    });
  }

  async setWebhook() {
    try {
      const webhookUrl = `${config.telegram.webhookUrl}/bot${config.telegram.token}`;
      await this.bot.setWebHook(webhookUrl, {
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
        secret_token: config.security.jwtSecret
      });
      
      logger.info('Telegram webhook set successfully', {
        webhookUrl: webhookUrl
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to set Telegram webhook', {
        error: error.message,
        webhookUrl: config.telegram.webhookUrl
      });
      throw error;
    }
  }

  async processUpdate(update) {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      logger.error('Error processing Telegram update', {
        updateId: update.update_id,
        error: error.message
      });
    }
  }

  async handleMessage(message) {
    try {
      const chatId = message.chat.id;
      const userId = message.from.id;
      const text = sanitizeTelegramMessage(message.text);

      logger.audit('message_received', userId, {
        chatId,
        messageId: message.message_id,
        command: text?.split(' ')[0]
      });

      // Check if it's a command
      if (text && text.startsWith('/')) {
        await this.handleCommand(message, text);
      } else {
        // Handle non-command messages based on user session state
        await this.handleTextMessage(message, text);
      }
    } catch (error) {
      logger.error('Error handling message', {
        messageId: message.message_id,
        error: error.message
      });
      
      await this.sendErrorMessage(
        message.chat.id,
        'Sorry, something went wrong. Please try again or use /help for assistance.'
      );
    }
  }

  async handleCommand(message, text) {
    const parts = text.split(' ');
    const command = parts[0].substring(1).toLowerCase(); // Remove '/' prefix
    const args = parts.slice(1);

    const handler = this.commandHandlers.get(command);
    if (handler) {
      await handler(message, args);
    } else {
      await this.sendMessage(
        message.chat.id,
        '❓ Unknown command. Use /help to see available commands.'
      );
    }
  }

  async handleTextMessage(message, text) {
    const userId = message.from.id;
    const session = this.userSessions.get(userId);

    if (session && session.waitingFor) {
      // Handle context-specific input
      switch (session.waitingFor) {
        case 'qr_amount':
          await this.handleQRAmountInput(message, text);
          break;
        case 'payment_amount':
          await this.handlePaymentAmountInput(message, text);
          break;
        default:
          await this.sendMessage(
            message.chat.id,
            'I\'m not sure what you\'re trying to do. Use /help for available commands.'
          );
      }
    } else {
      await this.handleDefaultText(message, text);
    }
  }

  async handleDefaultText(message, text) {
    // This is the default behavior if the controller doesn't override it.
    await this.sendMessage(
      message.chat.id,
      "I'm not sure what you're trying to do. Use /help for available commands."
    );
  }

  async handleCallbackQuery(query) {
    try {
      const data = query.data;
      const userId = query.from.id;

      logger.audit('callback_query_received', userId, {
        callbackData: data,
        messageId: query.message?.message_id
      });

      // Find and execute callback handler
      for (const [pattern, handler] of this.callbackHandlers.entries()) {
        if (data.startsWith(pattern)) {
          await handler(query, data);
          return;
        }
      }

      await this.answerCallbackQuery(query.id, {
        text: 'This action is no longer available.',
        show_alert: false
      });
    } catch (error) {
      logger.error('Error handling callback query', {
        callbackData: query.data,
        error: error.message
      });
      
      await this.answerCallbackQuery(query.id, {
        text: 'Something went wrong. Please try again.',
        show_alert: true
      });
    }
  }

  // Command handlers (to be implemented by main bot)
  async handleStart(message, args) {
    throw new Error('Start handler not implemented');
  }

  async handleHelp(message, args) {
    const helpText = `🤖 *USDC Payment Bot Commands*

/start - Create account with ARC wallet
/balance - Check your USDC balance

💸 *Payments:*
/pay \\[recipient\\] \\[amount\\] - Send USDC
  Examples:
  • /pay @alice 10
  • /pay alice 25 (using friend alias)
  • /pay 0x1234... 15
/request \\[user\\] \\[amount\\] - Request payment
  Examples:
  • /request @alice 10
  • /request bob 25 (using friend alias)

👥 *Friends:*
/addfriend \\[alias\\] \\[target\\] - Add friend alias
  Examples:
  • /addfriend alice @alice\\_crypto
  • /addfriend bob 123456789
  • /addfriend charlie 0x1234...
/removefriend \\[alias\\] - Remove friend alias
/friends - List all your friend aliases

📱 *QR Codes:*
/myqr - Interactive QR code generator
/qr \\[amount\\] - Quick QR code generation
  Examples:
  • /qr 10
  • /qr 25
/history - View recent transactions
/network - Show network information
/help - Show this message

💡 *Tips:*
• All amounts are in USDC
• Friend aliases must not start with @ and max 16 characters
• This bot uses ARC Testnet (Chain ID: ${config.arc.chainId})
• Keep your wallet secure and never share your private keys`;

    await this.sendMessage(message.chat.id, helpText, { parse_mode: 'Markdown' });
  }

  async handleBalance(message, args) {
    throw new Error('Balance handler not implemented');
  }

  async handlePay(message, args) {
    throw new Error('Pay handler not implemented');
  }

  async handleRequest(message, args) {
    throw new Error('Request handler not implemented');
  }

  async handleQR(message, args) {
    throw new Error('QR handler not implemented');
  }

  async handleMyQR(message, args) {
    throw new Error('MyQR handler not implemented');
  }

  async handleHistory(message, args) {
    throw new Error('History handler not implemented');
  }

  async handleQRAmountInput(message, text) {
    throw new Error('QR amount input handler not implemented');
  }

  async handlePaymentAmountInput(message, text) {
    throw new Error('Payment amount input handler not implemented');
  }

  // Utility methods
  async sendMessage(chatId, text, options = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...options
      });
    } catch (error) {
      logger.error('Failed to send message', {
        chatId,
        error: error.message
      });
      throw error;
    }
  }

  async sendPhoto(chatId, photo, options = {}) {
    try {
      return await this.bot.sendPhoto(chatId, photo, {
        parse_mode: 'Markdown',
        ...options
      });
    } catch (error) {
      logger.error('Failed to send photo', {
        chatId,
        error: error.message
      });
      throw error;
    }
  }

  async editMessage(chatId, messageId, text, options = {}) {
    try {
      return await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...options
      });
    } catch (error) {
      logger.error('Failed to edit message', {
        chatId,
        messageId,
        error: error.message
      });
      throw error;
    }
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    try {
      return await this.bot.answerCallbackQuery(callbackQueryId, options);
    } catch (error) {
      // Don't throw on timeout errors - these are expected with slow operations
      if (error.message.includes('query is too old') || error.message.includes('response timeout expired')) {
        logger.warn('Callback query timeout (expected for slow operations)', {
          callbackQueryId,
          error: error.message
        });
        return;
      }
      
      logger.error('Failed to answer callback query', {
        callbackQueryId,
        error: error.message
      });
      throw error;
    }
  }

  async sendErrorMessage(chatId, message) {
    try {
      await this.sendMessage(chatId, `❌ ${message}`);
    } catch (error) {
      logger.error('Failed to send error message', {
        chatId,
        error: error.message
      });
    }
  }

  async generatePaymentQRCode(address, amount = null, currency = 'USDC', type = 'wallet', destinationTag = null) {
    try {
      let uri;
      
      if (type === 'bot') {
        // Bot-specific QR code - links to Telegram bot
        const botUsername = config.telegram.botUsername;
        uri = `https://t.me/${botUsername}?start=pay_${address}`;
        if (amount && currency) {
          uri += `_${amount}_${currency.toLowerCase()}`;
        }
      } else {
        // Standard wallet QR code - compatible with any EVM wallet
        // Using EIP-681 standard for Ethereum payment requests
        uri = `ethereum:${address}`;
        
        if (amount) {
          // For USDC transfers, we need to specify the USDC contract
          const usdcContract = '0x3600000000000000000000000000000000000000'; // ARC USDC contract
          uri = `ethereum:${usdcContract}/transfer?address=${address}&uint256=${amount * 1000000}`; // Convert to 6 decimal places
        }
      }

      const qrBuffer = await QRCode.toBuffer(uri, {
        errorCorrectionLevel: 'H',
        type: 'png',
        width: 512,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      return {
        buffer: qrBuffer,
        uri,
        type
      };
    } catch (error) {
      logger.error('Failed to generate QR code', {
        address,
        amount,
        error: error.message
      });
      throw error;
    }
  }

  async generateBothQRCodes(address, amount = null, currency = 'USDC') {
    try {
      const [walletQR, botQR] = await Promise.all([
        this.generatePaymentQRCode(address, amount, currency, 'wallet'),
        this.generatePaymentQRCode(address, amount, currency, 'bot')
      ]);

      return {
        wallet: walletQR,
        bot: botQR
      };
    } catch (error) {
      logger.error('Failed to generate both QR codes', {
        address,
        amount,
        currency,
        error: error.message
      });
      throw error;
    }
  }

  // Session management
  setUserSession(userId, sessionData) {
    this.userSessions.set(userId, {
      ...sessionData,
      lastActivity: Date.now()
    });
  }

  getUserSession(userId) {
    return this.userSessions.get(userId);
  }

  clearUserSession(userId) {
    this.userSessions.delete(userId);
  }

  // Callback handler registration
  registerCallbackHandler(pattern, handler) {
    this.callbackHandlers.set(pattern, handler);
  }

  // Command handler override
  setCommandHandler(command, handler) {
    this.commandHandlers.set(command, handler);
  }
}

module.exports = new TelegramService();