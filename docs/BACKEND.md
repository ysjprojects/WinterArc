# Backend API Documentation


## Authentication & User Identity System

### Enhanced User Model

```typescript
interface User {
  user_id: string,           // Primary Auth0 user ID
  arc_address: string,
  arc_private_key_encrypted: string,
  providers: {
    telegram?: {
      id: number,
      username: string,
    },
    google?: {
      id: string,
      email: string,
      name: string,
    },
    // Future providers
  },
  profile: {
    display_name: string,
    email?: string,
    avatar_url?: string
  },
  created_at: string,
  last_login: string
}
```

## Authentication APIs

### POST /api/auth/login
Multi-provider login

```typescript
Body: {
  provider: 'telegram' | 'google',
  credentials: {
    // For Telegram
    telegram_id?: number,
    username?: string,
    auth_date?: number,
    hash?: string,
    
    // For Google (Auth0 handles OAuth flow)
    google_token?: string,
    
    // For direct Auth0 token
    auth0_token?: string
  }
}
Response: {
  access_token: string,
  refresh_token: string,
  user: User,
  expires_in: number,
  wallet: {
    arc_address: string,
    created: boolean
  }
}
```

### POST /api/auth/link-provider
Link additional provider to existing account

```typescript
Headers: Authorization: Bearer <token>
Body: {
  provider: 'telegram' | 'google',
  credentials: object
}
Response: {
  success: boolean,
  linked_provider: {
    provider: string,
    linked_at: string
  },
  user: User
}
```

### DELETE /api/auth/unlink-provider/{provider}
Unlink provider (must have at least one remaining)

```typescript
Headers: Authorization: Bearer <token>
Path: provider: string
Response: {
  success: boolean,
  remaining_providers: string[]
}
```

### POST /api/auth/refresh
Refresh access token

```typescript
Body: {
  refresh_token: string
}
Response: {
  access_token: string,
  expires_in: number
}
```

### GET /api/me
Get current user profile

```typescript
Headers: Authorization: Bearer <token>
Response: {
  user_id: string,
  xrp_address: string,
  providers: object,
  profile: object,
  created_at: string
}
```

### PUT /api/me/profile
Update user profile

```typescript
Headers: Authorization: Bearer <token>
Body: {
  display_name?: string,
  email?: string,
  avatar_url?: string
}
Response: {
  success: boolean,
  profile: object
}
```

## User-Scoped Wallet APIs

### GET /api/wallet/balance
Get my wallet balances

```typescript
Headers: Authorization: Bearer <token>
Response: {
  usdc: number,
  address: string,
}
```

### GET /api/wallet/history
Get my transaction history

```typescript
Headers: Authorization: Bearer <token>
Query: {
  limit?: number (default: 10, max: 50),
  offset?: number
}
Response: {
  transactions: Transaction[],
  address: string,
  pagination: {
    total: number,
    limit: number,
    offset: number,
    has_more: boolean
  }
}
```

### POST /api/wallets/validate-address
Validate EVM address (if address exists)

```typescript
Body: {
  address: string
}
Response: {
  valid: boolean,
  address: string
}
```

## User-Scoped Payment APIs

### POST /api/payments/send
Send payment

```typescript
Headers: Authorization: Bearer <token>
Body: {
  recipient: string, // @username, email, userID, address, friend alias
  amount: number,
  currency: 'USDC',
  message?: string
}
Response: {
  success: boolean,
  transaction_hash?: string,
  fee?: number,
  recipient_info: {
    address: string,
    display_name: string,
    user_id?: string
  },
  error?: string
}
```

### POST /api/payments/request
Create payment request to another user

```typescript
Headers: Authorization: Bearer <token>
Body: {
  payer_identifier: string, // @username, email, userID, friend alias
  amount: number,
  currency: 'USDC',
  message?: string
}
Response: {
  request_id: string,
  payer: {
    user_id: string,
    display_name: string
  },
  amount: number,
  currency: string,
  expires_at: string
}
```

## Payment Requests (Optional)

### GET /api/me/payments/requests
Get my payment requests (sent and received)

```typescript
Headers: Authorization: Bearer <token>
Query: {
  status?: 'pending' | 'fulfilled' | 'declined' | 'expired',
  type?: 'sent' | 'received',
  limit?: number
}
Response: {
  requests: [{
    request_id: string,
    type: 'sent' | 'received',
    other_party: {
      user_id: string,
      display_name: string
    },
    amount: number,
    currency: string,
    status: string,
    created_at: string,
    expires_at: string
  }]
}
```

### POST /api/payments/request/{request_id}/fulfill
Fulfill payment request

```typescript
Headers: Authorization: Bearer <token>
Path: request_id: string
Body: {
  payer_telegram_id: number
}
Response: {
  success: boolean,
  transaction_hash?: string,
  fee?: number,
  error?: string
}
```

### POST /api/payments/request/{request_id}/decline
Decline payment request

```typescript
Headers: Authorization: Bearer <token>
Path: request_id: string
Body: {
  payer_telegram_id: number
}
Response: {
  success: boolean,
  message: string
}
```

## RLUSD APIs (User-Scoped)

### POST /api/rlusd/setup-trustline
Setup RLUSD for my wallet

```typescript
Headers: Authorization: Bearer <token>
Body: {
  limit?: string (default: "1000000000") // In the frontend, can just hardcode it
}
Response: {
  success: boolean,
  transaction_hash?: string,
  fee?: number,
  error?: string
}
```

### GET /api/rlusd/status
Get my RLUSD trustline status

```typescript
Headers: Authorization: Bearer <token>
Response: {
  exists: boolean,
  balance: number,
  limit: number,
  address: string
}
```

## User-Scoped Friend Management

### GET /api/friends
Get friend aliases

```typescript
Headers: Authorization: Bearer <token>
Response: {
  friends: [{
    alias: string,
    target: {
      type: 'user' | 'address',
      user_id?: string,
      display_name?: string,
      address?: string
    },
    created_at: string
  }],
  count: number
}
```

### POST /api/friends
Add friend alias

```typescript
Headers: Authorization: Bearer <token>
Body: {
  alias: string,
  target: {
    type: 'user' | 'address',
    telegram_id?: string,    // For registered users
    address?: string,    // For direct EVM addresses
    identifier?: string  // unique identifier for lookup
  }
}
Response: {
  success: boolean,
  friend: {
    alias: string,
    target: object,
    created_at: string
  }
}
```

### DELETE /api/friends/{alias}
Remove friend alias

```typescript
Headers: Authorization: Bearer <token>
Path: alias: string
Response: {
  success: boolean,
  removed_friend: {
    alias: string,
    type: string,
    value: string
  }
}
```

## QR Code APIs

### POST /api/qr/generate
Generate QR codes

```typescript
Headers: Authorization: Bearer <token>
Body: {
  amount?: number,
  currency: 'USDC',
  type: 'tg_bot' | 'evm_wallet'
  apple_wallet: boolean
}
Response: {
  // TODO: look up apple wallet specific responses
  wallet_qr?: {
    buffer: string (base64),
    uri: string
  },
  bot_qr?: {
    buffer: string (base64),
    uri: string
  },
  address: string,
  amount?: number,
  currency: string
}
```

### POST /api/recipients/resolve
Resolve recipient identifier (supports cross-platform)

```typescript
Headers: Authorization: Bearer <token>
Body: {
  identifier: string // @telegram_user, email@domain.com, user_id, address, friend_alias
}
Response: {
  success: boolean,
  recipient?: {
    user_id?: string,
    display_name: string,
    arc_address: string,
    providers: string[],
    is_friend: boolean,
    friend_alias?: string
  },
  error?: string
}
```

## Deep Link Processing API

### POST /api/deeplinks/parse
Parse payment deep link

```typescript
Headers: Authorization: Bearer <token>
Body: {
  link_param: string, // pay_address_amount_currency
}
Response: {
  valid: boolean,
  payment_data?: {
    target_address: string,
    amount?: number,
    currency: string,
    requires_amount_input: boolean
  },
  error?: string
}
```
