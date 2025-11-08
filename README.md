# ARC Telegram Bot

A secure, production-ready Telegram bot for ARC Network payments with Auth0 integration.

## Features

- 🔐 Secure EVM wallet creation and management
- 💸 Send and receive USDC payments
- 📱 QR code generation for payments
- 💰 Balance checking and transaction history
- 🔔 Payment requests between users
- 🛡️ Comprehensive security measures
- 📊 Rate limiting and monitoring
- 🔍 Audit logging
- ⚡ Health checks and graceful shutdown

## Security Features

- ✅ Encrypted private key storage
- ✅ Input validation and sanitization
- ✅ Rate limiting on all endpoints
- ✅ Webhook signature validation
- ✅ Request logging and audit trails
- ✅ Error handling without information leakage
- ✅ Environment variable validation
- ✅ SQL injection and XSS protection

## Quick Start

### Prerequisites

- Node.js 18+
- Auth0 account and application
- Telegram Bot Token
- ARC Network testnet/mainnet access

### Installation

1. Clone and install dependencies:
```bash
git clone <repository>
cd arc_tg
npm install
```

2. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. Validate environment:
```bash
npm run validate-env
```

4. Start the bot:
```bash
# Development
npm run dev

# Production
npm start
```

## Environment Configuration

Create a `.env` file based on `.env.example`:

```env
# Required
TELEGRAM_BOT_TOKEN=your_bot_token
AUTH0_DOMAIN=your-domain.auth0.com
AUTH0_CLIENT_ID=your_client_id
AUTH0_CLIENT_SECRET=your_client_secret
AUTH0_MANAGEMENT_TOKEN=your_management_token
WEBHOOK_URL=https://your-domain.com
ENCRYPTION_KEY=your_32_character_encryption_key
JWT_SECRET=your_jwt_secret_minimum_32_chars

# Optional
PORT=3000
NODE_ENV=development
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_CHAIN_ID=5042002
ARC_EXPLORER_URL=https://testnet.arcscan.app
LOG_LEVEL=info
```

### Getting Auth0 Credentials

1. Create an Auth0 application (Machine to Machine)
2. Enable the Management API with required scopes:
   - `read:users`
   - `create:users`
   - `update:users`
3. Get your domain, client ID, client secret, and management token

### Telegram Bot Setup

1. Create a bot with [@BotFather](https://t.me/botfather)
2. Get your bot token
3. Set up webhook (for production):
```bash
curl -X POST https://api.telegram.org/bot<TOKEN>/setWebhook \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-domain.com/bot<TOKEN>"}'
```

## Bot Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/start` | Create account with ARC wallet | `/start` |
| `/balance` | Check USDC balance | `/balance` |
| `/pay` | Send USDC to user/address | `/pay @alice 10` |
| `/request` | Request payment from user | `/request @alice 5` |
| `/qr` | Generate payment QR code | `/qr 25` |
| `/myqr` | Interactive QR generator | `/myqr` |
| `/history` | View recent transactions | `/history` |
| `/help` | Show help message | `/help` |

## API Endpoints

- `GET /health` - Health check
- `POST /bot{token}` - Telegram webhook
- `GET /stats` - Basic statistics

## Project Structure

```
src/
├── config/           # Configuration management
├── controllers/      # Request handlers
├── middleware/       # Express middleware
├── services/         # Business logic services
├── utils/           # Utilities (logging, errors, validation)
└── index.js         # Application entry point
```

## Development

### Scripts

```bash
npm run dev          # Development with nodemon
npm run start        # Production start
npm run validate-env # Validate environment variables
npm run lint         # Code linting
npm run test         # Run tests
```

### Adding New Commands

1. Add handler to `src/controllers/botController.js`
2. Register in `setupCommandHandlers()`
3. Add validation logic
4. Update help text in `telegramService.js`

### Logging

The bot uses Winston for structured logging:

```javascript
const logger = require('./utils/logger');

logger.info('Message', { metadata });
logger.error('Error', { error: error.message });
logger.audit('action', userId, { details });
logger.security('Security event', { details });
```

## Production Deployment

### Environment Setup

1. Set `NODE_ENV=production`
2. Use HTTPS for webhook URL
3. Set secure encryption keys
4. Configure proper logging
5. Set up monitoring

### Security Checklist

- [ ] Environment variables validated
- [ ] HTTPS webhook configured
- [ ] Rate limiting enabled
- [ ] Logging configured
- [ ] Error handling tested
- [ ] Auth0 scopes minimal
- [ ] ARC network correct (mainnet/testnet)
- [ ] Encryption keys secure

### Monitoring

Monitor these metrics:
- Request rates and errors
- ARC Network connection status
- Auth0 API health
- Memory and CPU usage
- Transaction success rates

## Troubleshooting

### Common Issues

1. **Webhook not receiving updates**
   - Check HTTPS certificate
   - Verify webhook URL
   - Check Telegram webhook status

2. **Auth0 connection errors**
   - Verify credentials
   - Check API scopes
   - Monitor rate limits

3. **ARC Network connection issues**
   - Check RPC URL
   - Verify internet connectivity
   - Monitor ARC network status

4. **Environment validation fails**
   - Check `.env` file exists
   - Verify all required variables
   - Run `npm run validate-env`

### Debug Mode

Set `LOG_LEVEL=debug` for detailed logging:

```bash
LOG_LEVEL=debug npm run dev
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
1. Check troubleshooting section
2. Review logs for errors
3. Create an issue with details
4. Include environment info (without secrets)