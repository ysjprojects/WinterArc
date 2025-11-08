# Cloudflare Workers Deployment Guide

## 🚀 Quick Deploy to Cloudflare Workers

### Prerequisites

1. **Cloudflare account** (free tier works)
2. **Node.js 18+** installed
3. **Auth0 account** with API application
4. **Telegram Bot Token** from [@BotFather](https://t.me/botfather)

### Step 1: Install Dependencies

```bash
npm install
npm install -g wrangler  # Cloudflare CLI
```

### Step 2: Setup Cloudflare Workers

```bash
# Login to Cloudflare
wrangler auth login

# Create a KV namespace for sessions (optional)
wrangler kv:namespace create "SESSIONS"
wrangler kv:namespace create "SESSIONS" --preview

# Update wrangler.toml with the KV namespace IDs returned
```

### Step 3: Set Environment Variables

```bash
# Set secrets (these are encrypted in CF)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put AUTH0_CLIENT_SECRET
wrangler secret put AUTH0_MANAGEMENT_TOKEN
wrangler secret put ENCRYPTION_KEY
wrangler secret put JWT_SECRET

# Set regular environment variables
wrangler secret put AUTH0_DOMAIN
wrangler secret put AUTH0_CLIENT_ID
```

**Generate encryption key:**
```bash
# Generate a 32-character encryption key
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

### Step 4: Deploy

```bash
# Build and deploy
npm run build:workers
npm run deploy:workers

# Your bot will be available at:
# https://your-worker-name.your-subdomain.workers.dev
```

### Step 5: Set Telegram Webhook

```bash
# Replace YOUR_WORKER_URL and YOUR_BOT_TOKEN
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-worker-name.your-subdomain.workers.dev/botYOUR_BOT_TOKEN",
    "allowed_updates": ["message", "callback_query"]
  }'
```

## 🔧 Environment Variables Reference

### Required Secrets
```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
AUTH0_DOMAIN=your-domain.auth0.com  
AUTH0_CLIENT_ID=your_auth0_client_id
AUTH0_CLIENT_SECRET=your_auth0_client_secret
AUTH0_MANAGEMENT_TOKEN=your_auth0_management_token
ENCRYPTION_KEY=32_character_encryption_key
JWT_SECRET=your_jwt_secret_minimum_32_chars
```

### Optional Variables (set in wrangler.toml)
```bash
ARC_RPC_URL=https://rpc.testnet.arc.network  # ARC Network RPC
ARC_CHAIN_ID=5042002          # ARC Chain ID
ARC_EXPLORER_URL=https://testnet.arcscan.app  # ARC Explorer
LOG_LEVEL=info                # error, warn, info, debug
RATE_LIMIT_WINDOW_MS=900000   # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100   # Max requests per window
```

## 📁 Project Structure for Workers

```
workers/
├── index.js              # Entry point
├── bot.js                 # Main bot logic
├── controllers/
│   └── bot.js            # Command handlers
├── services/
│   ├── telegram.js       # Telegram API
│   ├── auth0.js          # Auth0 service
│   └── arcService.js     # ARC Network service
└── utils/
    ├── validation.js     # Input validation
    ├── logger.js         # Logging utility
    └── encryption.js     # Encryption service
```

## 🛠️ Development Workflow

### Local Development
```bash
# Test locally with Wrangler
npm run dev:workers

# Your bot runs at http://localhost:8787
# Test webhook: POST to http://localhost:8787/bot{token}
```

### Testing Webhook
```bash
# Test health endpoint
curl https://your-worker.workers.dev/health

# Test stats endpoint  
curl https://your-worker.workers.dev/stats

# Simulate Telegram update
curl -X POST "https://your-worker.workers.dev/bot{TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"message": {"chat": {"id": 123}, "from": {"id": 123}, "text": "/start"}}'
```

## 🔐 Security Setup

### Auth0 Configuration

1. Create **Machine to Machine Application**
2. Authorize for **Auth0 Management API**
3. Grant scopes:
   - `read:users`
   - `create:users`
   - `update:users`

### Telegram Bot Security

1. **Set webhook with secret**:
```bash
curl -X POST "https://api.telegram.org/botTOKEN/setWebhook" \
  -d "url=https://your-worker.workers.dev/botTOKEN" \
  -d "secret_token=your_secret_here"
```

2. **Restrict bot to private chats** (optional):
   - Contact [@BotFather](https://t.me/botfather)
   - Use `/setjoingroups` and select "Disable"

## 📊 Monitoring & Logs

### View Logs
```bash
# Stream real-time logs
wrangler tail

# View logs in Cloudflare dashboard
wrangler dash
```

### Monitor Performance
- **Cloudflare Dashboard** → Workers → your-worker → Analytics
- Track requests, errors, CPU time
- Set up alerts for high error rates

## 🔄 CI/CD Pipeline

### GitHub Actions Example
```yaml
# .github/workflows/deploy.yml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - run: npm install
      - run: npm run build:workers
      
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## 💰 Cost Estimation

### Cloudflare Workers Pricing
- **Free Tier**: 100,000 requests/day
- **Paid Tier**: $5/month for 10M requests
- **Typical bot usage**: ~1,000-10,000 requests/day

### Cost Comparison
| Platform | Free Tier | Paid |
|----------|-----------|------|
| CF Workers | 100k req/day | $5/month |
| AWS Lambda | 1M req/month | ~$1-5/month |
| Vercel | 100GB-hours/month | $20/month |

## 🐛 Troubleshooting

### Common Issues

1. **"Module not found" errors**
   ```bash
   # Build bundle first
   npm run build:workers
   ```

2. **Auth0 connection fails**
   ```bash
   # Check secrets are set
   wrangler secret list
   
   # Test Auth0 credentials
   curl -X POST "https://YOUR_DOMAIN.auth0.com/oauth/token" \
     -H "Content-Type: application/json" \
     -d '{
       "client_id": "YOUR_CLIENT_ID",
       "client_secret": "YOUR_CLIENT_SECRET", 
       "audience": "https://YOUR_DOMAIN.auth0.com/api/v2/",
       "grant_type": "client_credentials"
     }'
   ```

3. **Telegram webhook not working**
   ```bash
   # Check webhook status
   curl "https://api.telegram.org/botTOKEN/getWebhookInfo"
   
   # Delete and reset webhook
   curl "https://api.telegram.org/botTOKEN/deleteWebhook"
   ```

4. **Environment validation fails**
   ```bash
   # Test environment locally
   node -e "
   const env = process.env;
   console.log('TELEGRAM_BOT_TOKEN:', !!env.TELEGRAM_BOT_TOKEN);
   console.log('AUTH0_DOMAIN:', !!env.AUTH0_DOMAIN);
   console.log('ENCRYPTION_KEY length:', env.ENCRYPTION_KEY?.length);
   "
   ```

### Debug Mode
```bash
# Enable debug logging
wrangler secret put LOG_LEVEL
# Enter: debug

# View detailed logs
wrangler tail --format=pretty
```

## 🔄 Updates & Maintenance

### Deploy Updates
```bash
npm run build:workers
npm run deploy:workers
```

### Monitor Health
```bash
# Check all services
curl https://your-worker.workers.dev/health

# Check user stats  
curl https://your-worker.workers.dev/stats
```

### Backup Strategy
- **Auth0**: User data stored in Auth0 (managed)
- **Sessions**: Stored in KV (temporary)
- **Logs**: Available in Cloudflare dashboard

Your bot is now deployed and ready to handle USDC payments on ARC Network via Telegram! 🎉