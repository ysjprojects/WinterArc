// Auth0 service for Cloudflare Workers

import { EncryptionService } from '../utils/encryption.js';

export class Auth0Service {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.baseUrl = `https://${config.AUTH0_DOMAIN}/api/v2`;
    this.encryption = new EncryptionService(config.ENCRYPTION_KEY);
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async getAccessToken() {
    // Check if we have a valid token
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const response = await fetch(`https://${this.config.AUTH0_DOMAIN}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.config.AUTH0_CLIENT_ID,
          client_secret: this.config.AUTH0_CLIENT_SECRET,
          audience: `https://${this.config.AUTH0_DOMAIN}/api/v2/`,
          grant_type: 'client_credentials'
        })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`Auth0 token request failed: ${data.error_description}`);
      }

      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // 1 minute buffer

      return this.accessToken;
    } catch (error) {
      this.logger.error('Failed to get Auth0 access token', {
        error: error.message
      });
      throw error;
    }
  }

  async makeRequest(endpoint, method = 'GET', data = null) {
    try {
      const token = await this.getAccessToken();
      const url = `${this.baseUrl}${endpoint}`;

      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      };

      if (data) {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(url, options);
      const result = await response.json();

      if (!response.ok) {
        throw new Error(`Auth0 API error: ${result.message || response.statusText}`);
      }

      return result;
    } catch (error) {
      this.logger.error(`Auth0 API request failed`, {
        endpoint,
        method,
        error: error.message
      });
      throw error;
    }
  }

  async createUser(telegramId, username, arcWallet) {
    try {
      // Encrypt the ARC private key
      const encryptedPrivateKey = await this.encryption.encrypt(arcWallet.privateKey);
      
      const userData = {
        connection: 'Username-Password-Authentication',
        email: `${telegramId}@telegram.bot`,
        password: this.encryption.generateSecureToken(32),
        email_verified: true,
        user_metadata: {
          telegram_id: telegramId,
          telegram_username: username,
          arc_address: arcWallet.address,
          created_at: new Date().toISOString()
        },
        app_metadata: {
          arc_private_key_encrypted: encryptedPrivateKey,
          arc_public_key: arcWallet.publicKey,
          user_type: 'telegram_bot_user',
          version: '2.0'
        }
      };

      const user = await this.makeRequest('/users', 'POST', userData);
      
      this.logger.audit('user_created', telegramId, {
        auth0_id: user.user_id,
        arc_address: arcWallet.address,
        username
      });

      return {
        auth0_id: user.user_id,
        arc_address: arcWallet.address,
        user
      };
    } catch (error) {
      this.logger.error('Failed to create Auth0 user', {
        telegramId,
        username,
        error: error.message
      });
      throw error;
    }
  }

  async getUserByEmail(email) {
    try {
      const users = await this.makeRequest(`/users-by-email?email=${encodeURIComponent(email)}`);
      return users.length > 0 ? users[0] : null;
    } catch (error) {
      if (error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async getUserByTelegramId(telegramId) {
    try {
      const user = await this.getUserByEmail(`${telegramId}@telegram.bot`);
      
      if (user && user.app_metadata && user.app_metadata.arc_private_key_encrypted) {
        try {
          user.app_metadata.arc_private_key = await this.encryption.decrypt(user.app_metadata.arc_private_key_encrypted);
        } catch (decryptError) {
          this.logger.error('Failed to decrypt ARC private key', {
            userId: user.user_id,
            telegramId,
            error: decryptError.message
          });
        }
      }

      return user;
    } catch (error) {
      this.logger.error('Failed to fetch user by Telegram ID', {
        telegramId,
        error: error.message
      });
      throw error;
    }
  }

  async getUserByTelegramUsername(username) {
    try {
      const cleanUsername = username.replace('@', '');
      
      const query = `user_metadata.telegram_username:"${cleanUsername}"`;
      const users = await this.makeRequest(`/users?search_engine=v3&q=${encodeURIComponent(query)}&per_page=1`);
      
      if (users.length === 0) {
        return null;
      }

      const user = users[0];
      
      if (user.app_metadata && user.app_metadata.arc_private_key_encrypted) {
        try {
          user.app_metadata.arc_private_key = await this.encryption.decrypt(user.app_metadata.arc_private_key_encrypted);
        } catch (decryptError) {
          this.logger.error('Failed to decrypt ARC private key', {
            userId: user.user_id,
            username,
            error: decryptError.message
          });
        }
      }

      return user;
    } catch (error) {
      this.logger.error('Failed to fetch user by username', {
        username,
        error: error.message
      });
      throw error;
    }
  }

  async getUserStats() {
    try {
      const query = 'app_metadata.user_type:"telegram_bot_user"';
      const result = await this.makeRequest(`/users?search_engine=v3&q=${encodeURIComponent(query)}&per_page=0&include_totals=true`);

      return {
        totalUsers: result.total,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Failed to fetch user stats', {
        error: error.message
      });
      throw error;
    }
  }

  async healthCheck() {
    try {
      await this.makeRequest('/users?per_page=1');
      return { status: 'healthy', service: 'Auth0' };
    } catch (error) {
      this.logger.error('Auth0 health check failed', {
        error: error.message
      });
      return { status: 'unhealthy', service: 'Auth0', error: error.message };
    }
  }
}