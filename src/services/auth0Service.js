const { ManagementClient, AuthenticationClient } = require('auth0');
const config = require('../config');
const logger = require('../utils/logger');
const encryption = require('../utils/encryption');
const { ExternalServiceError, NotFoundError } = require('../utils/errors');

class Auth0Service {
  constructor() {
    this.management = new ManagementClient({
      domain: config.auth0.domain,
      clientId: config.auth0.clientId,
      clientSecret: config.auth0.clientSecret,
      scope: 'read:users create:users update:users delete:users'
    });

    this.auth = new AuthenticationClient({
      domain: config.auth0.domain,
      clientId: config.auth0.clientId
    });
  }

  async createUser(telegramId, username, arcWallet) {
    try {
      // Encrypt the private key before storing
      const encryptedPrivateKey = encryption.encrypt(arcWallet.privateKey);
      
      const userData = {
        connection: 'Username-Password-Authentication',
        email: `${telegramId}@telegram.bot`,
        password: this.generateStrongPassword(),
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

      const user = await this.management.users.create(userData);
      
      logger.audit('user_created', telegramId, {
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
      logger.error('Failed to create Auth0 user', {
        telegramId,
        username,
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  async getUserByTelegramId(telegramId) {
    try {
      const response = await this.management.users.getAll({
        search_engine: 'v3',
        q: `email:"${telegramId}@telegram.bot"`,
        per_page: 1
      });
      
      const users = response.data || response;
      
      if (users.length === 0) {
        return null;
      }

      const user = users[0];
      
      // Check if user needs migration from XRPL to ARC
      if (user.app_metadata && user.app_metadata.xrp_seed_encrypted && !user.app_metadata.arc_private_key_encrypted) {
        logger.info('Migrating user from XRPL to ARC format', { userId: user.user_id, telegramId });
        try {
          await this.migrateUserToARC(user);
          // Refresh user data after migration
          const refreshedUsers = await this.management.users.getAll({
            search_engine: 'v3',
            q: `app_metadata.telegram_id:${telegramId}`,
            per_page: 1
          });
          if (refreshedUsers.data && refreshedUsers.data.length > 0) {
            const refreshedUser = refreshedUsers.data[0];
            refreshedUser.app_metadata.arc_private_key = encryption.decrypt(refreshedUser.app_metadata.arc_private_key_encrypted);
            return refreshedUser;
          }
        } catch (migrationError) {
          logger.error('Failed to migrate user to ARC', {
            userId: user.user_id,
            telegramId,
            error: migrationError.message
          });
        }
      }

      // Decrypt the ARC private key when needed
      if (user.app_metadata && user.app_metadata.arc_private_key_encrypted) {
        try {
          user.app_metadata.arc_private_key = encryption.decrypt(user.app_metadata.arc_private_key_encrypted);
        } catch (decryptError) {
          logger.error('Failed to decrypt ARC private key', {
            userId: user.user_id,
            telegramId,
            error: decryptError.message
          });
          // Don't throw here, just log the error
        }
      }

      return user;
    } catch (error) {
      logger.error('Failed to fetch user by Telegram ID', {
        telegramId,
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  async getUserByTelegramUsername(username) {
    try {
      const cleanUsername = username.replace('@', '');
      
      const params = {
        search_engine: 'v3',
        q: `user_metadata.telegram_username:"${cleanUsername}"`,
        per_page: 1
      };
      
      const response = await this.management.users.getAll(params);
      const users = response.data || response;
      
      if (users.length === 0) {
        return null;
      }

      const user = users[0];
      
      // Decrypt the ARC private key when needed
      if (user.app_metadata && user.app_metadata.arc_private_key_encrypted) {
        try {
          user.app_metadata.arc_private_key = encryption.decrypt(user.app_metadata.arc_private_key_encrypted);
        } catch (decryptError) {
          logger.error('Failed to decrypt ARC private key', {
            userId: user.user_id,
            username,
            error: decryptError.message
          });
        }
      }

      return user;
    } catch (error) {
      logger.error('Failed to fetch user by username', {
        username,
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  async updateUserMetadata(userId, metadata) {
    try {
      await this.management.users.update({ id: userId }, {
        user_metadata: metadata
      });

      logger.audit('user_metadata_updated', userId, {
        updatedFields: Object.keys(metadata)
      });
    } catch (error) {
      logger.error('Failed to update user metadata', {
        userId,
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  async deleteUser(userId) {
    try {
      await this.management.users.delete({ id: userId });
      
      logger.audit('user_deleted', userId);
    } catch (error) {
      logger.error('Failed to delete user', {
        userId,
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  async getUserStats() {
    try {
      const response = await this.management.users.getAll({
        search_engine: 'v3',
        q: 'app_metadata.user_type:"telegram_bot_user"',
        per_page: 0,
        include_totals: true
      });

      const stats = response.data || response;
      
      return {
        totalUsers: stats.total || stats.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to fetch user stats', {
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  generateStrongPassword() {
    // Generate a password that meets Auth0's strength requirements
    // At least 8 characters with uppercase, lowercase, number, and special char
    const length = 16;
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const special = '!@#$%^&*';
    
    let password = '';
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += special[Math.floor(Math.random() * special.length)];
    
    const all = uppercase + lowercase + numbers + special;
    for (let i = 4; i < length; i++) {
      password += all[Math.floor(Math.random() * all.length)];
    }
    
    // Shuffle the password
    return password.split('').sort(() => Math.random() - 0.5).join('');
  }

  // Payment request management
  async createPaymentRequest(fromTelegramId, toTelegramId, amount, currency, reason = null) {
    try {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const requestData = {
        id: requestId,
        from: fromTelegramId,
        to: toTelegramId,
        amount: amount,
        currency: currency,
        reason: reason,
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
      };

      // Store in both users' metadata
      const fromUser = await this.getUserByTelegramId(fromTelegramId);
      const toUser = await this.getUserByTelegramId(toTelegramId);

      if (!fromUser || !toUser) {
        throw new Error('One or both users not found');
      }

      // Add to sender's outgoing requests
      const fromRequests = fromUser.user_metadata.payment_requests_sent || [];
      fromRequests.push(requestData);
      await this.updateUserMetadata(fromUser.user_id, {
        ...fromUser.user_metadata,
        payment_requests_sent: fromRequests
      });

      // Add to recipient's incoming requests
      const toRequests = toUser.user_metadata.payment_requests_received || [];
      toRequests.push(requestData);
      await this.updateUserMetadata(toUser.user_id, {
        ...toUser.user_metadata,
        payment_requests_received: toRequests
      });

      logger.audit('payment_request_created', fromTelegramId, {
        requestId,
        to: toTelegramId,
        amount,
        currency,
        reason
      });

      return requestData;
    } catch (error) {
      logger.error('Failed to create payment request', {
        fromTelegramId,
        toTelegramId,
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  async getPaymentRequests(telegramId) {
    try {
      const user = await this.getUserByTelegramId(telegramId);
      if (!user) {
        return { sent: [], received: [] };
      }

      const sent = user.user_metadata.payment_requests_sent || [];
      const received = user.user_metadata.payment_requests_received || [];

      // Filter out expired requests
      const now = new Date().toISOString();
      const activeSent = sent.filter(req => req.expires_at > now && req.status === 'pending');
      const activeReceived = received.filter(req => req.expires_at > now && req.status === 'pending');

      return { sent: activeSent, received: activeReceived };
    } catch (error) {
      logger.error('Failed to get payment requests', {
        telegramId,
        error: error.message
      });
      throw new ExternalServiceError('Auth0', error);
    }
  }

  // Health check method
  async healthCheck() {
    try {
      const response = await this.management.users.getAll({ per_page: 1 });
      // Just check that we got a response
      return { status: 'healthy', service: 'Auth0' };
    } catch (error) {
      logger.error('Auth0 health check failed', {
        error: error.message
      });
      return { status: 'unhealthy', service: 'Auth0', error: error.message };
    }
  }
}

module.exports = new Auth0Service();