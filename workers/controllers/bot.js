// Bot controller for Cloudflare Workers

import { parseRecipient, validateAmount, sanitizeInput } from '../utils/validation.js';

export class BotController {
  constructor({ telegram, auth0, arc, logger, env }) {
    this.telegram = telegram;
    this.auth0 = auth0;
    this.arc = arc;
    this.logger = logger;
    this.env = env;
    this.pendingPayments = new Map();
  }

  async processUpdate(update) {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      this.logger.error('Error processing update', {
        updateId: update.update_id,
        error: error.message
      });
    }
  }

  async handleMessage(message) {
    try {
      const chatId = message.chat.id;
      const userId = message.from.id;
      const text = sanitizeInput(message.text);

      this.logger.audit('message_received', userId, {
        chatId,
        messageId: message.message_id,
        command: text?.split(' ')[0]
      });

      if (text && text.startsWith('/')) {
        await this.handleCommand(message, text);
      }
    } catch (error) {
      this.logger.error('Error handling message', {
        messageId: message.message_id,
        error: error.message
      });
      
      await this.telegram.sendMessage(
        message.chat.id,
        '❌ Sorry, something went wrong. Please try again or use /help for assistance.'
      );
    }
  }

  async handleCommand(message, text) {
    const parts = text.split(' ');
    const command = parts[0].substring(1).toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case 'start':
        await this.handleStart(message);
        break;
      case 'help':
        await this.handleHelp(message);
        break;
      case 'balance':
        await this.handleBalance(message);
        break;
      case 'pay':
        await this.handlePay(message, args);
        break;
      case 'request':
        await this.handleRequest(message, args);
        break;
      case 'qr':
        await this.handleQR(message, args);
        break;
      case 'myqr':
        await this.handleMyQR(message);
        break;
      case 'history':
        await this.handleHistory(message);
        break;
      default:
        await this.telegram.sendMessage(
          message.chat.id,
          '❓ Unknown command. Use /help to see available commands.'
        );
    }
  }

  async handleStart(message) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;
      const username = message.from.username || 'user';

      let user = await this.auth0.getUserByTelegramId(telegramId);

      if (!user) {
        await this.telegram.sendMessage(chatId, '🔐 Creating your account...');
        
        try {
          const evmWallet = this.arc.generateWallet();
          const result = await this.auth0.createUser(telegramId, username, {
            address: evmWallet.address,
            privateKey: evmWallet.privateKey
          });
          
          const networkInfo = this.env.ARC_CHAIN_ID === '5042002'
            ? `⚠️ Note: This is a testnet address. Fund it at: https://faucet.circle.com`
            : `⚠️ Note: This is a mainnet address. Use real USDC with caution.`;

          await this.telegram.sendMessage(
            chatId,
            `✅ Account created successfully!

💼 Your ARC Address:
\`${result.arc_address}\`

${networkInfo}

Use /balance to check your balance
Use /pay to send USDC to others
Use /help for all commands`
          );

          this.logger.audit('account_created', telegramId, {
            arcAddress: result.arc_address,
            username
          });
        } catch (error) {
          this.logger.error('Account creation failed', {
            telegramId,
            username,
            error: error.message
          });
          await this.telegram.sendMessage(chatId, '❌ Failed to create account. Please try again.');
        }
      } else {
        await this.telegram.sendMessage(
          chatId,
          `👋 Welcome back, ${username}!

💼 Your ARC Address:
\`${user.user_metadata.arc_address}\`

Use /balance to check your balance
Use /pay to send USDC to others
Use /help for all commands`
        );

        this.logger.audit('user_returned', telegramId, {
          username: user.user_metadata.telegram_username
        });
      }
    } catch (error) {
      this.logger.error('Start command failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await this.telegram.sendMessage(message.chat.id, '❌ Something went wrong. Please try again.');
    }
  }

  async handleHelp(message) {
    const helpText = `🤖 *ARC Payment Bot Commands*

/start - Create account with ARC wallet
/balance - Check your USDC balance
/pay <recipient> <amount> - Send USDC
  Recipients can be:
  • @username - /pay @alice 10
  • User ID - /pay 123456789 10
  • EVM address - /pay 0x1234... 10
/request <user> <amount> - Request payment
  Example: /request @alice 5
/myqr - Generate QR code for receiving payments
/qr [amount] - Quick QR code generation
  Example: /qr or /qr 10
/history - View recent transactions
/help - Show this message

💡 *Tips:*
• All amounts are in USDC
• This bot uses ARC Testnet (Chain ID: ${this.env.ARC_CHAIN_ID})
• Keep your wallet secure and never share your private keys`;

    await this.telegram.sendMessage(message.chat.id, helpText);
  }

  async handleBalance(message) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await this.auth0.getUserByTelegramId(telegramId);
      if (!user) {
        await this.telegram.sendMessage(chatId, '❌ Please create an account first with /start');
        return;
      }

      const balance = await this.arc.getUSDCBalance(user.user_metadata.arc_address);
      
      await this.telegram.sendMessage(
        chatId,
        `💰 Your Balance: ${balance} USDC

Address: \`${user.user_metadata.arc_address}\`
Network: ARC Testnet (Chain ID: ${this.env.ARC_CHAIN_ID})

Use /history to see recent transactions`
      );

      this.logger.audit('balance_checked', telegramId, {
        balance,
        address: user.user_metadata.arc_address
      });
    } catch (error) {
      this.logger.error('Balance check failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await this.telegram.sendMessage(message.chat.id, '❌ Failed to get balance. Please try again.');
    }
  }

  async handlePay(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      if (args.length < 2) {
        await this.telegram.sendMessage(
          chatId,
          `❓ Usage: /pay <recipient> <amount>

Examples:
• /pay @username 10
• /pay 123456789 5.5
• /pay 0x1234... 25

Recipients can be:
• @username (Telegram username)
• User ID (Telegram user ID)
• EVM address (starts with '0x')`
        );
        return;
      }

      const [recipientInput, amountInput] = args;
      
      if (!validateAmount(parseFloat(amountInput))) {
        await this.telegram.sendMessage(chatId, '❌ Invalid amount. Must be a positive number.');
        return;
      }

      const amount = parseFloat(amountInput);
      const sender = await this.auth0.getUserByTelegramId(telegramId);
      
      if (!sender) {
        await this.telegram.sendMessage(chatId, '❌ Please create an account first with /start');
        return;
      }

      await this.telegram.sendMessage(chatId, '🔄 Processing payment...');

      const resolved = await this.resolveRecipient(recipientInput);
      if (!resolved) {
        await this.telegram.sendMessage(
          chatId,
          `❌ Recipient not found. Make sure:
• The user has created an account with /start
• You're using the correct @username or user ID
• Or provide a valid EVM address (starts with '0x')`
        );
        return;
      }

      const result = await this.arc.sendUSDCPayment(
        sender.app_metadata.arc_private_key,
        resolved.address,
        amount
      );

      if (result.success) {
        let recipientInfo = '';
        if (resolved.type === 'username') {
          recipientInfo = `To: @${resolved.username}`;
        } else if (resolved.type === 'userId') {
          recipientInfo = `To: User ${resolved.telegramId}`;
        } else {
          recipientInfo = `To: ${resolved.address}`;
        }

        await this.telegram.sendMessage(
          chatId,
          `✅ Payment sent successfully!

Amount: ${amount} USDC
${recipientInfo}
Transaction: \`${result.hash}\`
Gas Used: ${result.gasUsed} units`
        );

        // Notify recipient if they're a bot user
        if (resolved.telegramId) {
          try {
            await this.telegram.sendMessage(
              resolved.telegramId,
              `💰 You received ${amount} USDC from @${message.from.username || 'someone'}!

Transaction: \`${result.hash}\`
Use /balance to check your balance`
            );
          } catch (error) {
            this.logger.warn('Could not notify recipient', {
              recipientId: resolved.telegramId,
              error: error.message
            });
          }
        }

        this.logger.audit('payment_sent', telegramId, {
          amount,
          currency: 'USDC',
          recipient: resolved.address,
          txHash: result.hash,
          gasUsed: result.gasUsed
        });
      }
    } catch (error) {
      this.logger.error('Payment failed', {
        telegramId: message.from.id,
        args,
        error: error.message
      });
      await this.telegram.sendMessage(message.chat.id, '❌ Payment failed. Please try again.');
    }
  }

  async handleQR(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;
      
      const user = await this.auth0.getUserByTelegramId(telegramId);
      if (!user) {
        await this.telegram.sendMessage(chatId, '❌ Please create an account first with /start');
        return;
      }

      let amount = null;
      if (args.length > 0) {
        amount = parseFloat(args[0]);
        if (!validateAmount(amount)) {
          await this.telegram.sendMessage(chatId, '❌ Invalid amount. Usage: /qr or /qr 10');
          return;
        }
      }

      await this.telegram.sendMessage(chatId, '🎨 Generating QR code...');

      const qrData = await this.telegram.generatePaymentQRCode(
        user.user_metadata.arc_address,
        amount,
        'USDC'
      );

      let caption = `📱 Scan to Pay

Address: \`${user.user_metadata.arc_address}\`
`;
      
      if (amount) {
        caption += `Amount: ${amount} USDC\n`;
      } else {
        caption += `Amount: Not specified (payer chooses)\n`;
      }
      
      caption += `\n💡 Scan this QR code with any EVM wallet app`;

      await this.telegram.sendPhoto(chatId, qrData.url, { caption });

      this.logger.audit('qr_generated', telegramId, {
        amount,
        currency: 'USDC',
        address: user.user_metadata.arc_address
      });
    } catch (error) {
      this.logger.error('QR generation failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await this.telegram.sendMessage(message.chat.id, '❌ Failed to generate QR code. Please try again.');
    }
  }

  async handleMyQR(message) {
    // For Workers, we'll use inline keyboards with callback data
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📱 Generate QR Code', callback_data: 'qr_no_amount' }
        ],
        [
          { text: '💵 5 USDC', callback_data: 'qr_5' },
          { text: '💵 10 USDC', callback_data: 'qr_10' },
          { text: '💵 25 USDC', callback_data: 'qr_25' }
        ]
      ]
    };

    const user = await this.auth0.getUserByTelegramId(message.from.id);
    if (!user) {
      await this.telegram.sendMessage(message.chat.id, '❌ Please create an account first with /start');
      return;
    }

    await this.telegram.sendMessage(
      message.chat.id,
      `📱 *QR Code Generator*

Your ARC Address:
\`${user.user_metadata.arc_address}\`

Choose an amount:`,
      { reply_markup: keyboard }
    );
  }

  async handleHistory(message) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await this.auth0.getUserByTelegramId(telegramId);
      if (!user) {
        await this.telegram.sendMessage(chatId, '❌ Please create an account first with /start');
        return;
      }

      const transactions = await this.arc.getTransactionHistory(user.user_metadata.arc_address, 5);

      if (transactions.length === 0) {
        await this.telegram.sendMessage(
          chatId,
          `📊 Transaction History

No transactions found for your address.

Address: \`${user.user_metadata.arc_address}\``
        );
        return;
      }

      let historyText = `📊 *Recent Transactions*\n\n`;
      
      transactions.forEach((tx, index) => {
        const direction = tx.from.toLowerCase() === user.user_metadata.arc_address.toLowerCase() ? '📤 Sent' : '📥 Received';
        const amount = tx.amount ? `${tx.amount} ${tx.currency}` : 'N/A';
        
        historyText += `${index + 1}. ${direction} ${amount}\n`;
        historyText += `   Hash: \`${tx.hash.substring(0, 16)}...\`\n\n`;
      });

      await this.telegram.sendMessage(chatId, historyText);

      this.logger.audit('history_viewed', telegramId, {
        transactionCount: transactions.length
      });
    } catch (error) {
      this.logger.error('History command failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await this.telegram.sendMessage(message.chat.id, '❌ Failed to get transaction history.');
    }
  }

  async handleCallbackQuery(query) {
    try {
      const data = query.data;
      const userId = query.from.id;

      if (data.startsWith('qr_')) {
        await this.handleQRCallback(query, data);
      }
    } catch (error) {
      this.logger.error('Callback query failed', {
        callbackData: query.data,
        error: error.message
      });
      
      await this.telegram.answerCallbackQuery(query.id, {
        text: 'Something went wrong. Please try again.',
        show_alert: true
      });
    }
  }

  async handleQRCallback(query, data) {
    try {
      const userId = query.from.id;
      const user = await this.auth0.getUserByTelegramId(userId);
      
      if (!user) {
        await this.telegram.answerCallbackQuery(query.id, {
          text: '❌ Please create an account first with /start',
          show_alert: true
        });
        return;
      }

      let amount = null;
      if (data !== 'qr_no_amount') {
        amount = parseFloat(data.replace('qr_', ''));
      }

      await this.telegram.answerCallbackQuery(query.id, { text: '🎨 Generating QR code...' });

      const qrData = await this.telegram.generatePaymentQRCode(
        user.user_metadata.arc_address,
        amount,
        'USDC'
      );

      let caption = `📱 Scan to Pay ${query.from.first_name || 'User'}

Address: \`${user.user_metadata.arc_address}\`
Amount: ${amount ? `${amount} USDC` : 'Not specified (payer chooses)'}

💡 Scan this QR code with any EVM wallet app`;

      await this.telegram.sendPhoto(query.message.chat.id, qrData.url, { caption });
    } catch (error) {
      this.logger.error('QR callback failed', {
        userId: query.from.id,
        data,
        error: error.message
      });
      await this.telegram.answerCallbackQuery(query.id, {
        text: `❌ Error: ${error.message}`,
        show_alert: true
      });
    }
  }

  async resolveRecipient(recipient) {
    try {
      const parsed = parseRecipient(recipient);

      switch (parsed.type) {
        case 'address':
          return {
            type: 'address',
            address: parsed.value
          };

        case 'username':
          const userByUsername = await this.auth0.getUserByTelegramUsername(parsed.value);
          if (userByUsername && userByUsername.user_metadata.arc_address) {
            return {
              type: 'username',
              address: userByUsername.user_metadata.arc_address,
              username: userByUsername.user_metadata.telegram_username,
              telegramId: userByUsername.user_metadata.telegram_id
            };
          }
          break;

        case 'userId':
          const userById = await this.auth0.getUserByTelegramId(parsed.value);
          if (userById && userById.user_metadata.arc_address) {
            return {
              type: 'userId',
              address: userById.user_metadata.arc_address,
              username: userById.user_metadata.telegram_username,
              telegramId: userById.user_metadata.telegram_id
            };
          }
          break;
      }

      return null;
    } catch (error) {
      this.logger.error('Failed to resolve recipient', {
        recipient,
        error: error.message
      });
      return null;
    }
  }
}