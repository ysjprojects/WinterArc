const telegramService = require('../services/telegramService');
const auth0Service = require('../services/auth0Service');
const arcService = require('../services/arcService');
const { runAgent } = require('../services/agentService');
const config = require('../config');
const logger = require('../utils/logger');
const { validateCommandArgs, parseRecipient, isValidAmount, isValidFriendAlias } = require('../utils/validation');
const { ValidationError, NotFoundError, InsufficientFundsError } = require('../utils/errors');

class BotController {
  constructor() {
    this.pendingPayments = new Map();
    this.setupCommandHandlers();
    this.setupCallbackHandlers();
    this.startCleanupTimer();
  }

  setupCommandHandlers() {
    telegramService.setCommandHandler('start', this.handleStart.bind(this));
    telegramService.setCommandHandler('balance', this.handleBalance.bind(this));
    telegramService.setCommandHandler('pay', this.handlePay.bind(this));
    telegramService.setCommandHandler('request', this.handleRequest.bind(this));
    telegramService.setCommandHandler('qr', this.handleQR.bind(this));
    telegramService.setCommandHandler('myqr', this.handleMyQR.bind(this));
    telegramService.setCommandHandler('history', this.handleHistory.bind(this));
    telegramService.setCommandHandler('network', this.handleNetworkInfo.bind(this));
    
    // Friend management commands
    telegramService.setCommandHandler('addfriend', this.handleAddFriend.bind(this));
    telegramService.setCommandHandler('removefriend', this.handleRemoveFriend.bind(this));
    telegramService.setCommandHandler('friends', this.handleListFriends.bind(this));

    
    // Override amount input handlers
    telegramService.handlePaymentAmountInput = this.handlePaymentAmountInput.bind(this);
    telegramService.handleQRAmountInput = this.handleQRAmountInput.bind(this);
    telegramService.handleDefaultText = this.handleDefaultMessage.bind(this);
  }

  setupCallbackHandlers() {
    telegramService.registerCallbackHandler('qr_', this.handleQRCallback.bind(this));
    telegramService.registerCallbackHandler('pay_', this.handlePaymentCallback.bind(this));
    telegramService.registerCallbackHandler('decline_', this.handleDeclineCallback.bind(this));
    telegramService.registerCallbackHandler('confirm_pay_', this.handleConfirmPayCallback.bind(this));
    telegramService.registerCallbackHandler('cancel_payment', this.handleCancelPayCallback.bind(this));
  }

  async handleDefaultMessage(message) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;
      const text = message.text; // NEW: Get the text from the message

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }      

      // NEW: Send a "typing..." action for better UX
      // await telegramService.sendChatAction(chatId, 'typing'); // Assumes telegramService has sendChatAction

      // NEW: Call the agent
      const agentResult = await runAgent(text, user);

      // NEW: Process the agent's decision
      await this._handleAgentResult(message, user, agentResult);

    } catch (error) {
      logger.error('Default message failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Something went wrong. Please try again.');
    }
  }

  async handleStart(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;
      const username = message.from.username || 'user';

      // Check if this is a payment deep link
      if (args.length > 0 && args[0].startsWith('pay_')) {
        await this.handlePaymentDeepLink(message, args[0]);
        return;
      }

      let user = await auth0Service.getUserByTelegramId(telegramId);

      if (!user) {
        await telegramService.sendMessage(chatId, '🔐 Creating your account...');
        
        try {
          const evmWallet = arcService.generateWallet();
          const result = await auth0Service.createUser(telegramId, username, {
            address: evmWallet.address,
            privateKey: evmWallet.privateKey,
            mnemonic: evmWallet.mnemonic
          });
          
          const networkInfo = config.isARCTestnet 
            ? `⚠️ Note: This is a testnet address. Fund it at: https://faucet.circle.com`
            : `⚠️ Note: This is a mainnet address. Use real USDC with caution.`;

          await telegramService.sendMessage(
            chatId,
            `✅ Account created successfully!

💼 Your ARC Address:
\`${result.arc_address}\`

${networkInfo}

📋 **Next Steps:**
1. Fund your account with USDC from the faucet
2. Use /balance to check your balances
3. Start sending USDC payments!

Use /help for all commands`,
            { parse_mode: 'Markdown' }
          );

          logger.audit('account_created', telegramId, {
            arcAddress: result.arc_address,
            username
          });
        } catch (error) {
          logger.error('Account creation failed', {
            telegramId,
            username,
            error: error.message
          });
          await telegramService.sendErrorMessage(chatId, 'Failed to create account. Please try again.');
        }
      } else {
        // DEBUG: Log user data to see what fields exist
        logger.info('Existing user data debug', {
          telegramId,
          userMetadata: user.user_metadata,
          hasXrpAddress: !!user.user_metadata?.xrp_address,
          hasArcAddress: !!user.user_metadata?.arc_address
        });

        await telegramService.sendMessage(
          chatId,
          `👋 Welcome back, ${username}!

💼 Your ARC Address:
\`${user.user_metadata.arc_address || user.user_metadata.arc_address || 'Not found'}\`

Use /balance to check your balances
Use /pay to send USDC to others
Use /help for all commands`,
          { parse_mode: 'Markdown' }
        );

        logger.audit('user_returned', telegramId, {
          username: user.user_metadata.telegram_username
        });
      }
    } catch (error) {
      logger.error('Start command failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Something went wrong. Please try again.');
    }
  }

  async handleBalance(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      const balances = await arcService.getAllBalances(user.user_metadata.arc_address);
      
      let balanceMessage = `💰 Your Balance:

💵 USDC: ${balances.usdc} USDC`;

      balanceMessage += `\n\nAddress: \`${user.user_metadata.arc_address}\`
Network: ARC Testnet (Chain ID: ${config.arc.chainId})`;

      balanceMessage += `\n\nUse /pay to send USDC payments`;
      balanceMessage += `\nUse /history to see recent transactions`;

      await telegramService.sendMessage(chatId, balanceMessage, { parse_mode: 'Markdown' });

      logger.audit('balance_checked', telegramId, {
        native: balances.native,
        usdc: balances.usdc,
        address: user.user_metadata.arc_address
      });
    } catch (error) {
      logger.error('Balance check failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to get balance. Please try again.');
    }
  }

  async handlePay(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      if (args.length < 2) {
        await telegramService.sendMessage(
          chatId,
          `❓ Usage: /pay <recipient> <amount> [reason]

Examples:
• /pay @username 10
• /pay alice 5.5 (using friend alias)
• /pay 0x1234... 15 lunch money

Recipients can be:
• @username (Telegram username) 
• alias (Friend alias - use /friends to see list)
• User ID (Telegram user ID)
• EVM address (starts with '0x')

Currency: USDC (only supported currency)`
        );
        return;
      }

      const [recipientInput, amountInput, ...reasonParts] = args;
      const currency = 'USDC'; // Only USDC supported on ARC
      const reason = reasonParts.length > 0 ? reasonParts.join(' ') : null;
      
      if (!isValidAmount(parseFloat(amountInput))) {
        throw new ValidationError('Invalid amount. Must be a positive number.');
      }

      const amount = parseFloat(amountInput);
      const sender = await auth0Service.getUserByTelegramId(telegramId);
      
      if (!sender) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      await telegramService.sendMessage(chatId, '🔄 Processing payment...');

      // Resolve recipient with sender context for friend hierarchy
      logger.info('Resolving recipient', { recipientInput, telegramId });
      const resolved = await this.resolveRecipient(recipientInput, telegramId);
      logger.info('Resolution result', { resolved });
      if (!resolved) {
        await telegramService.sendMessage(
          chatId,
          `❌ Recipient not found. Make sure:
• The user has created an account with /start
• You're using the correct @username, user ID, or friend alias
• Or provide a valid EVM address (starts with '0x')

Use /friends to see your friend aliases.`
        );
        return;
      }

      // Send USDC payment
      const result = await arcService.sendUSDCPayment(
        sender.app_metadata.arc_private_key,
        resolved.address,
        amount,
        reason
      );

      if (result.success) {
        const recipientInfo = `To: ${resolved.displayName || resolved.address}`;

        await telegramService.sendMessage(
          chatId,
          `✅ USDC payment sent successfully!

Amount: ${amount} USDC
${recipientInfo}
Transaction: \`${result.hash}\`
Gas Used: ${result.gasUsed} units`,
          { parse_mode: 'Markdown' }
        );

        // Notify recipient if they're a bot user
        if (resolved.telegramId) {
          try {
            await telegramService.sendMessage(
              resolved.telegramId,
              `💰 You received ${amount} USDC from @${message.from.username || 'someone'}!

Transaction: \`${result.hash}\`
Use /balance to check your balance`,
              { parse_mode: 'Markdown' }
            );
          } catch (error) {
            logger.warn('Could not notify recipient', {
              recipientId: resolved.telegramId,
              error: error.message
            });
          }
        }

        logger.audit('payment_sent', telegramId, {
          amount,
          currency: 'USDC',
          recipient: resolved.address,
          txHash: result.hash,
          gasUsed: result.gasUsed
        });
      }
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        await telegramService.sendMessage(
          message.chat.id,
          `❌ Insufficient ${error.currency} funds. You need ${error.required} ${error.currency} but only have ${error.available} ${error.currency}.`
        );
      } else if (error.message && error.message.includes('Insufficient USDC for gas fees')) {
        await telegramService.sendMessage(
          message.chat.id,
          `❌ ${error.message}

You need USDC in your wallet to pay for gas fees.`
        );
      } else if (error instanceof ValidationError) {
        await telegramService.sendErrorMessage(message.chat.id, error.message);
      } else {
        logger.error('Payment failed', {
          telegramId: message.from.id,
          args,
          error: error.message
        });
        await telegramService.sendErrorMessage(message.chat.id, 'Payment failed. Please try again.');
      }
    }
  }

  async handleNetworkInfo(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      await telegramService.sendMessage(chatId, '🔄 Getting network information...');

      const networkInfo = await arcService.getNetworkInfo();
      
      await telegramService.sendMessage(
        chatId,
        `🌐 **ARC Network Information**

Chain ID: ${networkInfo.chainId}
Network: ${networkInfo.name}
RPC URL: ${networkInfo.rpcUrl}
Current Block: ${networkInfo.latestBlock}

⛽ **Gas Information**
Current Gas Price: ${networkInfo.gasPrice} wei

💵 **Your Address**
\`${user.user_metadata.arc_address}\`

🔗 **Explorer**
[View on ARC Testnet Explorer](${config.arc.explorerUrl})`,
        { parse_mode: 'Markdown' }
      );

      logger.audit('network_info_viewed', telegramId, {
        chainId: networkInfo.chainId,
        blockNumber: networkInfo.latestBlock
      });
    } catch (error) {
      logger.error('Network info failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to get network information. Please try again later.');
    }
  }

  async handleRequest(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      if (args.length < 2) {
        await telegramService.sendMessage(
          chatId,
          `❓ Usage: /request <user> <amount> [reason]

Examples:
• /request @alice 10
• /request bob 5.5 (using friend alias)
• /request 0x1234... 15 dinner split

Recipients can be:
• @username (Telegram username)
• alias (Friend alias - use /friends to see list)
• User ID (Telegram user ID)

Currency: USDC (only supported currency)

This will send a payment request to the specified user.`
        );
        return;
      }

      const [payerInput, amountInput, ...reasonParts] = args;
      const currency = 'USDC'; // Only USDC supported on ARC
      const reason = reasonParts.length > 0 ? reasonParts.join(' ') : null;
      
      if (!isValidAmount(parseFloat(amountInput))) {
        throw new ValidationError('Invalid amount. Must be a positive number.');
      }

      const amount = parseFloat(amountInput);
      const requester = await auth0Service.getUserByTelegramId(telegramId);
      
      if (!requester) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      // Resolve the payer with sender context for friend hierarchy
      const resolved = await this.resolveRecipient(payerInput, telegramId);
      if (!resolved || !resolved.telegramId) {
        await telegramService.sendMessage(
          chatId,
          `❌ User not found or hasn't created an account yet.
Make sure they've used /start on this bot first, or use /friends to see your friend aliases.`
        );
        return;
      }

      // Create payment request in Auth0
      const paymentRequest = await auth0Service.createPaymentRequest(
        telegramId,
        resolved.telegramId,
        amount,
        currency,
        reason
      );

      // Send request to payer
      try {
        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ Pay Now', callback_data: `pay_${paymentRequest.id}` },
              { text: '❌ Decline', callback_data: `decline_${paymentRequest.id}` }
            ]
          ]
        };

        await telegramService.sendMessage(
          resolved.telegramId,
          `💸 USDC Payment Request

From: @${message.from.username || 'user'}
Amount: ${amount} USDC${reason ? `\nReason: ${reason}` : ''}
To address: \`${requester.user_metadata.arc_address}\`

Do you want to pay?`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );

        await telegramService.sendMessage(
          chatId,
          `✅ Payment request sent to ${resolved.displayName || `@${resolved.username}` || resolved.telegramId}!

The request will expire in 30 minutes.`
        );

        logger.audit('payment_requested', telegramId, {
          amount,
          payer: resolved.telegramId,
          requestId
        });
      } catch (error) {
        await telegramService.sendErrorMessage(
          chatId,
          'Could not send request. The user may have blocked the bot.'
        );
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        await telegramService.sendErrorMessage(message.chat.id, error.message);
      } else {
        logger.error('Request command failed', {
          telegramId: message.from.id,
          args,
          error: error.message
        });
        await telegramService.sendErrorMessage(message.chat.id, 'Failed to send request. Please try again.');
      }
    }
  }

  async handleQR(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;
      
      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      if (args.length === 0) {
        await telegramService.sendMessage(
          chatId,
          `✏️ Usage: /qr <amount>

Examples:
• /qr 15.5
• /qr 25
• /qr 10

Currency: USDC (only supported currency)`
        );
        return;
      }

      const [amountInput] = args;
      const currency = 'USDC'; // Only USDC supported on ARC

      let amount = null;
      if (amountInput && amountInput !== '0') {
        amount = parseFloat(amountInput);
        if (!isValidAmount(amount)) {
          throw new ValidationError('Invalid amount. Must be a positive number.');
        }
      }

      await telegramService.sendMessage(chatId, `🎨 Generating USDC QR codes...`);

      // Generate both types of QR codes
      const qrCodes = await telegramService.generateBothQRCodes(
        user.user_metadata.arc_address,
        amount,
        currency
      );

      // Send wallet QR code
      let walletCaption = `📱 **Wallet QR Code** (USDC)

For any EVM wallet app
Address: \`${user.user_metadata.arc_address}\`
`;
      
      if (amount) {
        walletCaption += `Amount: ${amount} USDC\n`;
      } else {
        walletCaption += `Amount: Not specified (payer chooses)\n`;
      }
      
      walletCaption += `\n💡 Compatible with MetaMask, Trust Wallet, and other EVM wallets`;

      await telegramService.sendPhoto(chatId, qrCodes.wallet.buffer, {
        caption: walletCaption,
        parse_mode: 'Markdown'
      });

      // Send bot QR code
      let botCaption = `🤖 **Bot QR Code** (USDC)

For Telegram users only
Links to this bot for payment
`;
      
      if (amount) {
        botCaption += `Amount: ${amount} USDC\n`;
      } else {
        botCaption += `Amount: Not specified (payer chooses)\n`;
      }
      
      botCaption += `\n💡 Share this with other Telegram users`;

      await telegramService.sendPhoto(chatId, qrCodes.bot.buffer, {
        caption: botCaption,
        parse_mode: 'Markdown'
      });

      logger.audit('qr_generated', telegramId, {
        amount,
        currency: 'USDC',
        address: user.user_metadata.arc_address,
        types: ['wallet', 'bot']
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        await telegramService.sendErrorMessage(message.chat.id, error.message);
      } else {
        logger.error('QR generation failed', {
          telegramId: message.from.id,
          error: error.message
        });
        await telegramService.sendErrorMessage(message.chat.id, 'Failed to generate QR code. Please try again.');
      }
    }
  }

  async handleMyQR(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      const keyboard = {
        inline_keyboard: [
          [
            { text: '📱 Wallet QR (Any Amount)', callback_data: 'qr_wallet_usdc_no_amount' },
            { text: '🤖 Bot QR (Any Amount)', callback_data: 'qr_bot_usdc_no_amount' }
          ],
          [
            { text: '⚡ 5 USDC - Wallet', callback_data: 'qr_wallet_usdc_5' },
            { text: '🤖 5 USDC - Bot', callback_data: 'qr_bot_usdc_5' }
          ],
          [
            { text: '⚡ 10 USDC - Wallet', callback_data: 'qr_wallet_usdc_10' },
            { text: '🤖 10 USDC - Bot', callback_data: 'qr_bot_usdc_10' }
          ],
          [
            { text: '⚡ 25 USDC - Wallet', callback_data: 'qr_wallet_usdc_25' },
            { text: '🤖 25 USDC - Bot', callback_data: 'qr_bot_usdc_25' }
          ],
          [
            { text: '✏️ Custom USDC', callback_data: 'qr_wallet_usdc_custom' }
          ]
        ]
      };

      await telegramService.sendMessage(
        chatId,
        `📱 *QR Code Generator*

Your ARC Address:
\`${user.user_metadata.arc_address}\`

**Two QR Types Available:**
📱 **Wallet QR** - Compatible with any EVM wallet
🤖 **Bot QR** - Links to this Telegram bot

Choose your preferred type and amount:`,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        }
      );
    } catch (error) {
      logger.error('MyQR command failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to generate QR options. Please try again.');
    }
  }

  async handleHistory(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      await telegramService.sendMessage(chatId, '📊 Loading transaction history...');

      const transactions = await arcService.getTransactionHistory(user.user_metadata.arc_address, 10);
      const paymentRequests = await auth0Service.getPaymentRequests(telegramId);
      
      // MODIFIED: Use the new helper
      const historyText = await this._formatHistoryText(transactions, user.user_metadata.arc_address, telegramId);
      const requestsText = this._formatPaymentRequestsText(paymentRequests, telegramId);

      const fullText = historyText + (requestsText ? `\n\n${requestsText}` : '');
      await telegramService.sendMessage(chatId, fullText, { parse_mode: 'Markdown' });

      logger.audit('history_viewed', telegramId, {
        transactionCount: transactions.length
      });
    } catch (error) {
      logger.error('History command failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to get transaction history. Please try again.');
    }
  }


  /*
  async handleHistory(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      await telegramService.sendMessage(chatId, '📊 Loading transaction history...');

      const transactions = await arcService.getTransactionHistory(user.user_metadata.arc_address, 10);

      if (transactions.length === 0) {
        await telegramService.sendMessage(
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
        const date = new Date(tx.date).toLocaleDateString();
        
        historyText += `${index + 1}. ${direction}\n`;
        historyText += `   Amount: ${amount}\n`;
        historyText += `   Date: ${date}\n`;
        historyText += `   Hash: \`${tx.hash.substring(0, 16)}...\`\n\n`;
      });

      historyText += `Address: \`${user.user_metadata.arc_address}\``;

      await telegramService.sendMessage(chatId, historyText, { parse_mode: 'Markdown' });

      logger.audit('history_viewed', telegramId, {
        transactionCount: transactions.length
      });
    } catch (error) {
      logger.error('History command failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to get transaction history. Please try again.');
    }
  }
*/
  // Callback handlers
  async handleQRCallback(query, data) {
    try {
      const userId = query.from.id;
      const user = await auth0Service.getUserByTelegramId(userId);
      
      if (!user) {
        await telegramService.answerCallbackQuery(query.id, {
          text: '❌ Please create an account first with /start',
          show_alert: true
        });
        return;
      }

      // Parse type, currency and amount from callback data
      // Format: qr_[type]_[currency]_[amount] or qr_[currency]_[amount] (legacy)
      const parts = data.split('_');
      let qrType = 'wallet'; // default type
      let currency = 'USDC';
      let amount = null;
      
      if (parts.length >= 4 && (parts[1] === 'wallet' || parts[1] === 'bot')) {
        // New format: qr_wallet_usdc_5 or qr_bot_usdc_10
        qrType = parts[1];
        currency = parts[2].toUpperCase();
        
        if (parts[3] === 'custom') {
          await telegramService.answerCallbackQuery(query.id);
          await telegramService.sendMessage(
            query.message.chat.id,
            `✏️ Please enter the amount in ${currency}:\nExample: /qr 15.5 ${currency}`
          );
          return;
        } else if (parts[3] !== 'no' || parts.length < 5 || parts[4] !== 'amount') {
          amount = parseFloat(parts[3]);
        }
      } else if (parts.length >= 3) {
        // Legacy format: qr_usdc_5
        currency = parts[1].toUpperCase();
        
        if (parts[2] === 'custom') {
          await telegramService.answerCallbackQuery(query.id);
          await telegramService.sendMessage(
            query.message.chat.id,
            `✏️ Please enter the amount in ${currency}:\nExample: /qr 15.5 ${currency}`
          );
          return;
        } else if (parts[2] !== 'no' && parts[3] !== 'amount') {
          amount = parseFloat(parts[2]);
        }
      }

      const typeLabel = qrType === 'bot' ? '🤖 Bot' : '📱 Wallet';
      await telegramService.answerCallbackQuery(query.id, { text: `🎨 Generating ${typeLabel} ${currency} QR code...` });

      const qrData = await telegramService.generatePaymentQRCode(
        user.user_metadata.arc_address,
        amount,
        currency,
        qrType
      );

      let caption = `${typeLabel} QR Code (${currency})

${qrType === 'bot' ? 'For Telegram users only' : 'For any EVM wallet app'}
Address: \`${user.user_metadata.arc_address}\`
`;
      
      if (amount) {
        caption += `Amount: ${amount} ${currency}\n`;
      } else {
        caption += `Amount: Not specified (payer chooses)\n`;
      }
      
      if (qrType === 'bot') {
        caption += `\n💡 Share this with other Telegram users`;
      } else {
        caption += `\n💡 Compatible with XUMM, GateHub, and other EVM wallets`;
      }

      await telegramService.sendPhoto(query.message.chat.id, qrData.buffer, {
        caption,
        parse_mode: 'Markdown'
      });

      logger.audit('qr_callback_generated', userId, {
        amount,
        currency,
        type: qrType,
        address: user.user_metadata.arc_address
      });
    } catch (error) {
      logger.error('QR callback failed', {
        userId: query.from.id,
        data,
        error: error.message
      });
      await telegramService.answerCallbackQuery(query.id, {
        text: `❌ Error: ${error.message}`,
        show_alert: true
      });
    }
  }

  async handlePaymentCallback(query, data) {
    try {
      const requestId = data.replace('pay_', '');
      const request = this.pendingPayments.get(requestId);

      if (!request) {
        await telegramService.answerCallbackQuery(query.id, {
          text: '❌ Request expired or already processed',
          show_alert: true
        });
        return;
      }

      if (request.payer !== query.from.id) {
        await telegramService.answerCallbackQuery(query.id, {
          text: '❌ This request is not for you',
          show_alert: true
        });
        return;
      }

      const payer = await auth0Service.getUserByTelegramId(query.from.id);
      if (!payer) {
        await telegramService.answerCallbackQuery(query.id, {
          text: '❌ Please create an account first with /start',
          show_alert: true
        });
        return;
      }

      await telegramService.answerCallbackQuery(query.id, { text: '🔄 Processing payment...' });

      // Send USDC payment
      const result = await arcService.sendUSDCPayment(
        payer.app_metadata.arc_private_key,
        request.requesterAddress,
        request.amount
      );

      if (result.success) {
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `✅ USDC Payment Completed!

Amount: ${request.amount} USDC
Transaction: \`${result.hash}\`
Gas Used: ${result.gasUsed} units`,
          { parse_mode: 'Markdown' }
        );

        // Notify requester
        await telegramService.sendMessage(
          request.requester,
          `✅ USDC payment received from @${query.from.username || 'someone'}!

Amount: ${request.amount} USDC
Transaction: \`${result.hash}\``,
          { parse_mode: 'Markdown' }
        );

        this.pendingPayments.delete(requestId);

        logger.audit('payment_request_fulfilled', query.from.id, {
          amount: request.amount,
          requester: request.requester,
          txHash: result.hash
        });
      } else {
        await telegramService.answerCallbackQuery(query.id, {
          text: '❌ Payment failed. Check your balance.',
          show_alert: true
        });
      }
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        await telegramService.answerCallbackQuery(query.id, {
          text: `❌ Insufficient ${error.currency} funds. Need ${error.required} ${error.currency}.`,
          show_alert: true
        });
      } else {
        logger.error('Payment callback failed', {
          userId: query.from.id,
          data,
          error: error.message
        });
        await telegramService.answerCallbackQuery(query.id, {
          text: `❌ Error: ${error.message}`,
          show_alert: true
        });
      }
    }
  }

  async handleDeclineCallback(query, data) {
    try {
      const requestId = data.replace('decline_', '');
      const request = this.pendingPayments.get(requestId);

      if (request && request.payer === query.from.id) {
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `❌ Payment request declined`
        );

        await telegramService.sendMessage(
          request.requester,
          `❌ @${query.from.username || 'User'} declined your USDC payment request for ${request.amount} USDC`
        );

        this.pendingPayments.delete(requestId);
        await telegramService.answerCallbackQuery(query.id, { text: 'Request declined' });

        logger.audit('payment_request_declined', query.from.id, {
          amount: request.amount,
          requester: request.requester
        });
      }
    } catch (error) {
      logger.error('Decline callback failed', {
        userId: query.from.id,
        data,
        error: error.message
      });
    }
  }

  async handleConfirmPayCallback(query, data) {
    try {
      const userId = query.from.id;
      
      // Answer callback query immediately to prevent timeout
      await telegramService.answerCallbackQuery(query.id, { text: '🔄 Processing payment...' });
      
      // Immediately disable the button by editing the message
      await telegramService.editMessage(
        query.message.chat.id,
        query.message.message_id,
        `🔄 **Processing Payment...**

Please wait while we process your payment.
This may take a few seconds.`,
        { parse_mode: 'Markdown' }
      );
      
      // Parse payment data: confirm_pay_address_amount_currency
      const parts = data.split('_');
      if (parts.length < 5) {
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `❌ Invalid payment data. Please try again.`
        );
        return;
      }
      
      const targetAddress = parts[2];
      const amount = parseFloat(parts[3]) || null;
      const currency = parts[4].toUpperCase();
      
      logger.info('Processing payment callback', {
        userId,
        targetAddress,
        amount,
        currency
      });
      
      const user = await auth0Service.getUserByTelegramId(userId);
      if (!user) {
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `❌ Please create an account first with /start`
        );
        return;
      }
      
      // Validate amount (should already be validated at this point)
      if (!amount || amount <= 0) {
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `❌ Invalid payment amount. Please try again.`
        );
        return;
      }
      
      // Send payment based on currency
      let result;
      try {
        logger.info('About to send payment', { 
          userId, 
          currency, 
          amount, 
          targetAddress,
          hasUserSeed: !!user.app_metadata.arc_private_key 
        });
        
        if (currency === 'USDC') {
          logger.info('Calling arcService.sendUSDCPayment', { amount, targetAddress });
          result = await arcService.sendUSDCPayment(
            user.app_metadata.arc_private_key,
            targetAddress,
            amount
          );
          logger.info('USDC payment service returned', { result });
        } else {
          logger.info('Calling arcService.sendUSDCPayment', { amount, targetAddress });
          result = await arcService.sendUSDCPayment(
            user.app_metadata.arc_private_key,
            targetAddress,
            amount
          );
          logger.info('USDC payment service returned', { result });
        }
        
        logger.info('Payment service call completed', { 
          result: result ? {
            success: result.success,
            hash: result.hash,
            fee: result.fee
          } : 'null result'
        });
        
        if (result && result.success) {
          logger.info('Payment successful, updating UI');
          await telegramService.editMessage(
            query.message.chat.id,
            query.message.message_id,
            `✅ ${currency} Payment Sent Successfully!

Amount: ${amount} ${currency}
To: \`${targetAddress}\`
Transaction: \`${result.hash}\`
${currency === 'USDC' ? 'Fee' : 'Gas Fee'}: ${result.fee} USDC`,
            { parse_mode: 'Markdown' }
          );
          
          logger.audit('deeplink_payment_sent', userId, {
            amount,
            currency,
            recipient: targetAddress,
            txHash: result.hash,
            fee: result.fee
          });
        } else {
          logger.error('Payment failed - no success result', { 
            result,
            resultType: typeof result,
            resultKeys: result ? Object.keys(result) : 'null'
          });
          await telegramService.editMessage(
            query.message.chat.id,
            query.message.message_id,
            `❌ Payment failed. ${result?.error || 'Please check your balance and try again.'}`
          );
        }
      } catch (paymentError) {
        logger.error('Payment error occurred in try-catch', {
          error: paymentError.message,
          errorType: paymentError.constructor.name,
          stack: paymentError.stack,
          userId,
          amount,
          currency,
          targetAddress
        });
        
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `❌ Payment failed: ${paymentError.message}`
        );
      }
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `❌ Insufficient ${error.currency} funds. Need ${error.required} ${error.currency}.`
        );
      } else {
        logger.error('Confirm payment callback failed', {
          userId: query.from.id,
          data,
          error: error.message
        });
        await telegramService.editMessage(
          query.message.chat.id,
          query.message.message_id,
          `❌ Payment failed: ${error.message}`
        );
      }
    }
  }

  async handleCancelPayCallback(query, data) {
    try {
      // Answer callback query immediately to prevent timeout
      await telegramService.answerCallbackQuery(query.id, { text: 'Payment cancelled' });
      
      await telegramService.editMessage(
        query.message.chat.id,
        query.message.message_id,
        `❌ Payment cancelled`
      );
      
      logger.audit('deeplink_payment_cancelled', query.from.id);
    } catch (error) {
      logger.error('Cancel payment callback failed', {
        userId: query.from.id,
        error: error.message
      });
    }
  }

  // Amount input handlers
  async handlePaymentAmountInput(message, text) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;
      const session = telegramService.getUserSession(telegramId);
      
      if (!session || !session.paymentData) {
        await telegramService.sendErrorMessage(chatId, 'Session expired. Please try again.');
        telegramService.clearUserSession(telegramId);
        return;
      }
      
      // Validate amount
      const amount = parseFloat(text);
      if (!isValidAmount(amount)) {
        await telegramService.sendMessage(
          chatId,
          `❌ Invalid amount. Please enter a valid positive number.
          
Example: 10.5`
        );
        return;
      }
      
      const { targetAddress, currency } = session.paymentData;
      
      // Clear the session
      telegramService.clearUserSession(telegramId);
      
      // Show payment confirmation
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Confirm Payment', callback_data: `confirm_pay_${targetAddress}_${amount}_${currency}` },
            { text: '❌ Cancel', callback_data: 'cancel_payment' }
          ]
        ]
      };
      
      const user = await auth0Service.getUserByTelegramId(telegramId);
      let paymentText = `💸 **Payment Confirmation**

To: \`${targetAddress}\`
Amount: ${amount} ${currency}
From: Your account (\`${user.user_metadata.arc_address}\`)

${currency === 'USDC' ? '⚠️ Requires USDC for gas fees' : ''}

Do you want to proceed with this payment?`;

      await telegramService.sendMessage(chatId, paymentText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      
      logger.audit('payment_amount_entered', telegramId, {
        amount,
        currency,
        targetAddress
      });
    } catch (error) {
      logger.error('Payment amount input failed', {
        telegramId: message.from.id,
        text,
        error: error.message
      });
      
      telegramService.clearUserSession(message.from.id);
      await telegramService.sendErrorMessage(message.chat.id, 'Something went wrong. Please try again.');
    }
  }

  async handleQRAmountInput(message, text) {
    // Placeholder for QR amount input (existing functionality)
    await telegramService.sendMessage(
      message.chat.id,
      'QR amount input not implemented yet. Use /qr <amount> [currency] instead.'
    );
    telegramService.clearUserSession(message.from.id);
  }

  // Friend management commands
  async handleAddFriend(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      if (args.length < 2) {
        await telegramService.sendMessage(
          chatId,
          `❓ Usage: /addfriend <alias> <@username|userID|address>

Examples:
• /addfriend alice @alice_crypto
• /addfriend bob 123456789
• /addfriend charlie rN7n7otEqM1o2ArvLq2JdX5q...

Rules:
• Alias must not start with @
• Alias max 16 characters
• Can contain letters, numbers, _, -`
        );
        return;
      }

      const [aliasInput, friendInput] = args;
      
      // Validate alias
      if (!isValidFriendAlias(aliasInput)) {
        throw new ValidationError('Invalid alias format. Must not start with @ and be 1-16 characters long.');
      }

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      // Parse friend identifier
      let friendData;
      try {
        const parsed = parseRecipient(friendInput);
        friendData = { type: parsed.type, value: parsed.value };
      } catch (error) {
        throw new ValidationError('Invalid friend identifier. Use @username, userID, or USDC address.');
      }

      // Get current friends list
      const currentMetadata = user.user_metadata || {};
      const friends = currentMetadata.friends || {};

      // Check if alias already exists
      if (friends[aliasInput]) {
        await telegramService.sendMessage(
          chatId,
          `❌ Alias "${aliasInput}" already exists for: ${this.formatFriendDisplay(friends[aliasInput])}
          
Use /removefriend ${aliasInput} to remove it first.`
        );
        return;
      }

      // Add new friend
      friends[aliasInput] = friendData;

      // Update user metadata
      await auth0Service.updateUserMetadata(user.user_id, {
        ...currentMetadata,
        friends
      });

      await telegramService.sendMessage(
        chatId,
        `✅ Friend added successfully!

Alias: ${aliasInput}
Target: ${this.formatFriendDisplay(friendData)}

You can now use "${aliasInput}" in payments and requests.`
      );

      logger.audit('friend_added', telegramId, {
        alias: aliasInput,
        friend: friendData
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        await telegramService.sendErrorMessage(message.chat.id, error.message);
      } else {
        logger.error('Add friend failed', {
          telegramId: message.from.id,
          args,
          error: error.message
        });
        await telegramService.sendErrorMessage(message.chat.id, 'Failed to add friend. Please try again.');
      }
    }
  }

  async handleRemoveFriend(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      if (args.length < 1) {
        await telegramService.sendMessage(
          chatId,
          `❓ Usage: /removefriend <alias>

Example: /removefriend alice`
        );
        return;
      }

      const aliasInput = args[0];
      
      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      // Get current friends list
      const currentMetadata = user.user_metadata || {};
      const friends = currentMetadata.friends || {};

      // Check if alias exists
      if (!friends[aliasInput]) {
        await telegramService.sendMessage(
          chatId,
          `❌ Alias "${aliasInput}" not found.

Use /friends to see your current friends list.`
        );
        return;
      }

      const removedFriend = friends[aliasInput];
      delete friends[aliasInput];

      // Update user metadata
      await auth0Service.updateUserMetadata(user.user_id, {
        ...currentMetadata,
        friends
      });

      await telegramService.sendMessage(
        chatId,
        `✅ Friend removed successfully!

Removed alias: ${aliasInput}
Was pointing to: ${this.formatFriendDisplay(removedFriend)}`
      );

      logger.audit('friend_removed', telegramId, {
        alias: aliasInput,
        friend: removedFriend
      });
    } catch (error) {
      logger.error('Remove friend failed', {
        telegramId: message.from.id,
        args,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to remove friend. Please try again.');
    }
  }

  async handleListFriends(message, args) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;

      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendErrorMessage(chatId, 'Please create an account first with /start');
        return;
      }

      // Get current friends list
      const currentMetadata = user.user_metadata || {};
      const friends = currentMetadata.friends || {};

      if (Object.keys(friends).length === 0) {
        await telegramService.sendMessage(
          chatId,
          `👥 Friends List

You haven't added any friends yet.

Use /addfriend <alias> <@username|userID|address> to add friends.

Example: /addfriend alice @alice_crypto`
        );
        return;
      }

      let friendsList = `👥 **Friends List** (${Object.keys(friends).length} friends)\n\n`;
      
      for (const [alias, friendData] of Object.entries(friends)) {
        friendsList += `• **${alias}** → ${this.formatFriendDisplay(friendData)}\n`;
      }
      
      friendsList += `\nUse these aliases in /pay and /request commands.`;

      await telegramService.sendMessage(chatId, friendsList, { parse_mode: 'Markdown' });

      logger.audit('friends_listed', telegramId, {
        friendCount: Object.keys(friends).length
      });
    } catch (error) {
      logger.error('List friends failed', {
        telegramId: message.from.id,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to list friends. Please try again.');
    }
  }

  // Payment deep link handler
  async handlePaymentDeepLink(message, paymentParam) {
    try {
      const chatId = message.chat.id;
      const telegramId = message.from.id;
      
      // Parse payment parameters: pay_address_amount_currency
      const parts = paymentParam.split('_');
      if (parts.length < 2) {
        await telegramService.sendErrorMessage(chatId, 'Invalid payment link format.');
        return;
      }
      
      const targetAddress = parts[1];
      let amount = null;
      let currency = 'USDC';
      
      if (parts.length >= 3) {
        amount = parseFloat(parts[2]);
      }
      if (parts.length >= 4) {
        currency = parts[3].toUpperCase();
      }
      
      // Validate currency
      if (!['USDC', 'USDC'].includes(currency)) {
        await telegramService.sendErrorMessage(chatId, 'Invalid currency. Use USDC or USDC.');
        return;
      }
      
      // Check if user has an account
      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user) {
        await telegramService.sendMessage(
          chatId,
          `💸 Payment Request

To: \`${targetAddress}\`
${amount ? `Amount: ${amount} ${currency}` : 'Amount: Not specified'}

❌ You need to create an account first.
Use /start to create your account, then try the payment link again.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      
      if (amount && amount > 0) {
        // Show payment confirmation with fixed amount
        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ Confirm Payment', callback_data: `confirm_pay_${targetAddress}_${amount}_${currency}` },
              { text: '❌ Cancel', callback_data: 'cancel_payment' }
            ]
          ]
        };
        
        let paymentText = `💸 **Payment Request**

To: \`${targetAddress}\`
Amount: ${amount} ${currency}
From: Your account (\`${user.user_metadata.arc_address}\`)

${currency === 'USDC' ? '⚠️ Requires USDC for gas fees' : ''}

Do you want to proceed with this payment?`;

        await telegramService.sendMessage(chatId, paymentText, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } else {
        // Set up session for amount input
        telegramService.setUserSession(telegramId, {
          waitingFor: 'payment_amount',
          paymentData: {
            targetAddress,
            currency,
            type: 'deeplink'
          }
        });
        
        let paymentText = `💸 **Payment Request**

To: \`${targetAddress}\`
Currency: ${currency}
From: Your account (\`${user.user_metadata.arc_address}\`)

${currency === 'USDC' ? '⚠️ Requires USDC for gas fees' : ''}

💭 Please enter the amount you want to send:
Example: 10.5`;

        await telegramService.sendMessage(chatId, paymentText, {
          parse_mode: 'Markdown'
        });
      }
      
      logger.audit('payment_deeplink_accessed', telegramId, {
        targetAddress,
        amount,
        currency
      });
    } catch (error) {
      logger.error('Payment deep link failed', {
        telegramId: message.from.id,
        paymentParam,
        error: error.message
      });
      await telegramService.sendErrorMessage(message.chat.id, 'Failed to process payment link. Please try again.');
    }
  }

  // Helper methods
  formatFriendDisplay(friendData) {
    switch (friendData.type) {
      case 'username':
        return `@${friendData.value}`;
      case 'userId':
        return `User ID: ${friendData.value}`;
      case 'address':
        return `${friendData.value.substring(0, 8)}...${friendData.value.substring(-4)}`;
      default:
        return friendData.value;
    }
  }

  async resolveRecipient(recipient, senderTelegramId = null) {
    try {
      logger.info('parseRecipient input', { recipient });
      const parsed = parseRecipient(recipient);
      logger.info('parseRecipient result', { parsed });

      switch (parsed.type) {
        case 'address':
          // Check if this address belongs to a known user (hierarchy level 1)
          const addressOwner = await this.findUserByAddress(parsed.value);
          if (addressOwner) {
            return {
              type: 'address',
              address: parsed.value,
              displayName: `@${addressOwner.username}`, // Show telegram handle
              telegramId: addressOwner.telegramId,
              username: addressOwner.username
            };
          }
          
          // Check if this address is in sender's friends list (hierarchy level 2)
          if (senderTelegramId) {
            const friendAlias = await this.findFriendAliasByAddress(senderTelegramId, parsed.value);
            if (friendAlias) {
              return {
                type: 'address',
                address: parsed.value,
                displayName: friendAlias, // Show friend alias
                isFriend: true
              };
            }
          }
          
          return {
            type: 'address',
            address: parsed.value,
            displayName: `${parsed.value.substring(0, 8)}...${parsed.value.substring(-4)}` // Show truncated address
          };

        case 'username':
          const userByUsername = await auth0Service.getUserByTelegramUsername(parsed.value);
          if (userByUsername && userByUsername.user_metadata.arc_address) {
            // Check if this username is in sender's friends list (hierarchy level 2)
            if (senderTelegramId) {
              const friendAlias = await this.findFriendAliasByUsername(senderTelegramId, parsed.value);
              if (friendAlias) {
                return {
                  type: 'username',
                  address: userByUsername.user_metadata.arc_address,
                  displayName: friendAlias, // Show friend alias
                  telegramId: userByUsername.user_metadata.telegram_id,
                  username: userByUsername.user_metadata.telegram_username,
                  isFriend: true
                };
              }
            }
            
            return {
              type: 'username',
              address: userByUsername.user_metadata.arc_address,
              displayName: `@${parsed.value}`, // Show telegram handle
              username: userByUsername.user_metadata.telegram_username,
              telegramId: userByUsername.user_metadata.telegram_id
            };
          }
          break;

        case 'userId':
          const userById = await auth0Service.getUserByTelegramId(parsed.value);
          if (userById && userById.user_metadata.arc_address) {
            // Check if this user ID is in sender's friends list (hierarchy level 2)
            if (senderTelegramId) {
              const friendAlias = await this.findFriendAliasByUserId(senderTelegramId, parsed.value);
              if (friendAlias) {
                return {
                  type: 'userId',
                  address: userById.user_metadata.arc_address,
                  displayName: friendAlias, // Show friend alias
                  telegramId: userById.user_metadata.telegram_id,
                  username: userById.user_metadata.telegram_username,
                  isFriend: true
                };
              }
            }
            
            return {
              type: 'userId',
              address: userById.user_metadata.arc_address,
              displayName: `@${userById.user_metadata.telegram_username}`, // Show telegram handle
              username: userById.user_metadata.telegram_username,
              telegramId: userById.user_metadata.telegram_id
            };
          }
          break;

        case 'alias':
          // Look up friend alias
          logger.info('Looking up alias', { alias: parsed.value, senderTelegramId });
          if (senderTelegramId) {
            const friendData = await this.getFriendByAlias(senderTelegramId, parsed.value);
            logger.info('Friend data found', { friendData });
            if (friendData) {
              // Handle different friend types
              if (friendData.type === 'address') {
                // Direct address - no need to recursively resolve
                return {
                  type: 'alias',
                  address: friendData.value,
                  displayName: parsed.value, // Show the alias name
                  isFriend: true
                };
              } else {
                // Recursively resolve username or userId
                const resolved = await this.resolveRecipient(
                  friendData.type === 'username' ? `@${friendData.value}` : 
                  friendData.type === 'userId' ? friendData.value.toString() : 
                  friendData.value, 
                  senderTelegramId
                );
                
                if (resolved) {
                  return {
                    ...resolved,
                    displayName: parsed.value, // Always show the alias for friends
                    isFriend: true
                  };
                }
              }
            }
          }
          break;
      }

      return null;
    } catch (error) {
      logger.error('Failed to resolve recipient', {
        recipient,
        error: error.message
      });
      return null;
    }
  }

  // Friend lookup helper methods
  async findUserByAddress(address) {
    try {
      // This would require a reverse lookup in Auth0 - for now we'll search all users
      // In production, you might want to add an index for this
      const response = await auth0Service.management.users.getAll({
        search_engine: 'v3',
        q: `user_metadata.arc_address:"${address}"`,
        per_page: 1
      });
      
      const users = response.data || response;
      if (users.length > 0) {
        const user = users[0];
        return {
          telegramId: user.user_metadata.telegram_id,
          username: user.user_metadata.telegram_username
        };
      }
      return null;
    } catch (error) {
      logger.error('Failed to find user by address', { address, error: error.message });
      return null;
    }
  }

  async getFriendByAlias(telegramId, alias) {
    try {
      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user || !user.user_metadata || !user.user_metadata.friends) {
        return null;
      }
      return user.user_metadata.friends[alias] || null;
    } catch (error) {
      logger.error('Failed to get friend by alias', { telegramId, alias, error: error.message });
      return null;
    }
  }

  async findFriendAliasByAddress(telegramId, address) {
    try {
      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user || !user.user_metadata || !user.user_metadata.friends) {
        return null;
      }
      
      const friends = user.user_metadata.friends;
      for (const [alias, friendData] of Object.entries(friends)) {
        if (friendData.type === 'address' && friendData.value === address) {
          return alias;
        }
      }
      return null;
    } catch (error) {
      logger.error('Failed to find friend alias by address', { telegramId, address, error: error.message });
      return null;
    }
  }

  async findFriendAliasByUsername(telegramId, username) {
    try {
      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user || !user.user_metadata || !user.user_metadata.friends) {
        return null;
      }
      
      const friends = user.user_metadata.friends;
      for (const [alias, friendData] of Object.entries(friends)) {
        if (friendData.type === 'username' && friendData.value === username) {
          return alias;
        }
      }
      return null;
    } catch (error) {
      logger.error('Failed to find friend alias by username', { telegramId, username, error: error.message });
      return null;
    }
  }

  async findFriendAliasByUserId(telegramId, userId) {
    try {
      const user = await auth0Service.getUserByTelegramId(telegramId);
      if (!user || !user.user_metadata || !user.user_metadata.friends) {
        return null;
      }
      
      const friends = user.user_metadata.friends;
      for (const [alias, friendData] of Object.entries(friends)) {
        if (friendData.type === 'userId' && friendData.value === userId) {
          return alias;
        }
      }
      return null;
    } catch (error) {
      logger.error('Failed to find friend alias by user ID', { telegramId, userId, error: error.message });
      return null;
    }
  }

  // --- NEW HELPER METHODS FOR THE AGENT ---

  /**
   * NEW: Processes the output from the agent
   */
  async _handleAgentResult(message, user, agentResult) {
    const chatId = message.chat.id;
    const telegramId = message.from.id;

    try {
      switch (agentResult.type) {
        case 'chat_response':
          // The agent just wants to send a message
          await telegramService.sendMessage(chatId, agentResult.content, { parse_mode: 'Markdown' });
          break;

        case 'tool_call':
          // The agent wants to use a tool
          switch (agentResult.toolName) {
            
            case 'get_transaction_history':
              // 1. Fulfill the information task
              await telegramService.sendMessage(chatId, '📊 Loading your transaction history...');
              const address = user.user_metadata.arc_address;
              const transactions = await arcService.getTransactionHistory(address, 10);
              
              // 2. Format the history using the refactored helper
              const historyText = await this._formatHistoryText(transactions, address, telegramId);
              
              // 3. "Query the model again" (as requested by your prompt)
              // The mock agent is built to handle this specific prompt:
              const historyPrompt = `Here is the user's transaction history in a pre-formatted text block. Please present this to the user with a friendly intro. \n\n${historyText}`;
              
              const summaryResult = await runAgent(historyPrompt, user);
              
              await telegramService.sendMessage(chatId, summaryResult.content, { parse_mode: 'Markdown' });
              
              logger.audit('agent_history_viewed', telegramId, {
                transactionCount: transactions.length
              });
              break;

            case 'make_payment':
              // 1. Get payment details from the agent
              const { recipient, amount } = agentResult.arguments;
              const currency = 'USDC'; // Only USDC is supported

              if (!isValidAmount(amount)) {
                await telegramService.sendMessage(chatId, `❌ The agent understood an invalid amount (${amount}). Please try again with a clear amount.`);
                return;
              }

              // 2. Resolve the recipient (address, @username, or alias)
              let targetAddress;
              let recipientInfo;
              
              try {
                const resolved = await this.resolveRecipient(recipient, telegramId);
                targetAddress = resolved.address;
                recipientInfo = resolved;
              } catch (error) {
                if (error instanceof ValidationError) {
                  await telegramService.sendMessage(chatId, `❌ ${error.message}`);
                } else if (error instanceof NotFoundError) {
                  await telegramService.sendMessage(chatId, `❌ Could not find recipient: ${recipient}`);
                } else {
                  await telegramService.sendMessage(chatId, `❌ Error resolving recipient: ${error.message}`);
                }
                return;
              }

              // 3. "Send a confirmation message" (as requested)
              // This re-uses your existing secure callback logic
              await this._sendPaymentConfirmation(chatId, user, targetAddress, amount, currency, recipientInfo);
              
              logger.audit('agent_payment_initiated', telegramId, {
                recipient,
                targetAddress,
                amount,
                currency,
                recipientType: recipientInfo.type
              });
              break;

            default:
              await telegramService.sendMessage(chatId, "The agent requested a tool I don't recognize. Please try rephrasing.");
          }
          break;

        default:
          await telegramService.sendMessage(chatId, "I'm not sure how to help with that. Please try /help.");
      }
    } catch (error) {
      logger.error('Failed to handle agent result', {
        telegramId,
        agentResult,
        error: error.message
      });
      await telegramService.sendErrorMessage(chatId, 'There was an error processing your request.');
    }
  }

  /**
   * NEW: Helper to send payment confirmation, re-using existing callbacks
   */
  async _sendPaymentConfirmation(chatId, user, targetAddress, amount, currency, recipientInfo = null) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Confirm Payment', callback_data: `confirm_pay_${targetAddress}_${amount}_${currency}` },
          { text: '❌ Cancel', callback_data: 'cancel_payment' }
        ]
      ]
    };
    
    // Use the same address logic from your handleStart for consistency
    const fromAddress = user.user_metadata.arc_address || 'Not found';
    
    // Format recipient display based on type
    let recipientDisplay = `\`${targetAddress}\``;
    if (recipientInfo) {
      switch (recipientInfo.type) {
        case 'username':
          recipientDisplay = `@${recipientInfo.displayName} (\`${targetAddress}\`)`;
          break;
        case 'alias':
          recipientDisplay = `${recipientInfo.displayName} (alias) (\`${targetAddress}\`)`;
          break;
        case 'address':
          recipientDisplay = `\`${targetAddress}\``;
          break;
        default:
          recipientDisplay = `\`${targetAddress}\``;
      }
    }
    
    let paymentText = `💸 **Payment Confirmation**
(Triggered by chat)

To: ${recipientDisplay}
Amount: ${amount} ${currency}
From: Your account (\`${fromAddress}\`)

Do you want to proceed with this payment?`;

    await telegramService.sendMessage(chatId, paymentText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * NEW: Refactored from handleHistory to be reusable
   */
  async _formatHistoryText(transactions, address, telegramId = null) {
    if (!transactions || transactions.length === 0) {
      return `📊 Transaction History

No transactions found for your address.

Address: \`${address}\``;
    }

    let historyText = `📊 *Recent Transactions*\n\n`;
    
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const isOutgoing = tx.from.toLowerCase() === address.toLowerCase();
      const direction = isOutgoing ? '📤 Sent' : '📥 Received';
      const amount = tx.amount ? `${tx.amount} ${tx.currency}` : 'N/A';
      const date = new Date(tx.date).toLocaleDateString();
      
      // Format sender and recipient with context
      const fromDisplay = await this._formatAddressForHistory(tx.from, address, telegramId);
      const toDisplay = await this._formatAddressForHistory(tx.to, address, telegramId);
      
      historyText += `${i + 1}. ${direction}\n`;
      historyText += `   Amount: ${amount}\n`;
      historyText += `   From: ${fromDisplay}\n`;
      historyText += `   To: ${toDisplay}\n`;
      if (tx.memo) {
        historyText += `   Description: ${tx.memo}\n`;
      }
      historyText += `   Date: ${date}\n`;
      historyText += `   Hash: \`${tx.hash.substring(0, 16)}...\`\n\n`;
    }

    historyText += `Your Address: \`${address}\``;
    return historyText;
  }

  /**
   * Helper to format addresses for transaction history display
   */
  async _formatAddressForHistory(address, userAddress, telegramId) {
    // If it's the user's own address, show "me"
    if (address.toLowerCase() === userAddress.toLowerCase()) {
      return "me";
    }

    // Check if address belongs to a friend alias
    if (telegramId) {
      const friendAlias = await this.findFriendAliasByAddress(telegramId, address);
      if (friendAlias) {
        return `${friendAlias} (\`${address.substring(0, 8)}...${address.substring(-4)}\`)`;
      }
    }

    // Check if address belongs to a known user
    const addressOwner = await this.findUserByAddress(address);
    if (addressOwner && addressOwner.username) {
      return `@${addressOwner.username} (\`${address.substring(0, 8)}...${address.substring(-4)}\`)`;
    }

    // Default: show truncated address
    return `\`${address.substring(0, 8)}...${address.substring(-4)}\``;
  }

  /**
   * Helper to format payment requests for display
   */
  _formatPaymentRequestsText(paymentRequests, telegramId) {
    const { sent, received } = paymentRequests;
    
    if (sent.length === 0 && received.length === 0) {
      return null; // No requests to show
    }

    let text = `💰 **Pending Payment Requests**\n\n`;

    if (received.length > 0) {
      text += `📥 **Requests to You:**\n`;
      received.forEach((req, index) => {
        const date = new Date(req.created_at).toLocaleDateString();
        text += `${index + 1}. ${req.amount} USDC from ${req.from}${req.reason ? ` - ${req.reason}` : ''}\n`;
        text += `   Created: ${date}\n\n`;
      });
    }

    if (sent.length > 0) {
      text += `📤 **Your Requests:**\n`;
      sent.forEach((req, index) => {
        const date = new Date(req.created_at).toLocaleDateString();
        text += `${index + 1}. ${req.amount} USDC to ${req.to}${req.reason ? ` - ${req.reason}` : ''}\n`;
        text += `   Created: ${date}\n\n`;
      });
    }

    return text;
  }

  // Cleanup expired payment requests
  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      for (const [requestId, request] of this.pendingPayments.entries()) {
        if (request.expiresAt && now > request.expiresAt) {
          this.pendingPayments.delete(requestId);
          logger.info('Cleaned up expired payment request', { requestId });
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }
}

module.exports = new BotController();