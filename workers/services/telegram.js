// Telegram API service for Cloudflare Workers

export class TelegramAPI {
  constructor(token, logger) {
    this.token = token;
    this.logger = logger;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async makeRequest(method, data = {}) {
    try {
      const url = `${this.baseUrl}/${method}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data)
      });

      const result = await response.json();
      
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description}`);
      }

      return result.result;
    } catch (error) {
      this.logger.error(`Telegram API request failed`, {
        method,
        error: error.message
      });
      throw error;
    }
  }

  async sendMessage(chatId, text, options = {}) {
    return await this.makeRequest('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...options
    });
  }

  async sendPhoto(chatId, photo, options = {}) {
    // For Workers, we need to handle photo as base64 or URL
    return await this.makeRequest('sendPhoto', {
      chat_id: chatId,
      photo,
      parse_mode: 'Markdown',
      ...options
    });
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    return await this.makeRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      ...options
    });
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return await this.makeRequest('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...options
    });
  }

  async setWebhook(url, options = {}) {
    return await this.makeRequest('setWebHook', {
      url,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      ...options
    });
  }

  async getWebhookInfo() {
    return await this.makeRequest('getWebhookInfo');
  }

  async generatePaymentQRCode(address, amount = null) {
    try {
      // EIP-681 standard for Ethereum payment requests
      let uri = `ethereum:${address}`;
      
      if (amount) {
        // For USDC transfers, we need to specify the USDC contract
        const usdcContract = '0x3600000000000000000000000000000000000000'; // ARC USDC contract
        uri = `ethereum:${usdcContract}/transfer?address=${address}&uint256=${amount * 1000000}`; // Convert to 6 decimal places
      }

      // Use QR code API service since Workers can't generate images directly
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(uri)}`;
      
      return {
        url: qrApiUrl,
        uri
      };
    } catch (error) {
      this.logger.error('QR code generation failed', {
        address,
        amount,
        error: error.message
      });
      throw error;
    }
  }

  sanitizeMessage(text) {
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
}