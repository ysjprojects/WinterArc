// User storage service using Cloudflare KV

import { EncryptionService } from '../utils/encryption.js';

export class UserStorageService {
  constructor(kv, config, logger) {
    this.kv = kv; // Cloudflare KV namespace
    this.config = config;
    this.logger = logger;
    this.encryption = new EncryptionService(config.ENCRYPTION_KEY);
  }

  // Generate user key for KV storage
  getUserKey(telegramId) {
    return `user:${telegramId}`;
  }

  // Generate username lookup key
  getUsernameKey(username) {
    return `username:${username.toLowerCase()}`;
  }

  async createUser(telegramId, username, arcWallet) {
    try {
      // Encrypt the ARC private key
      const encryptedPrivateKey = await this.encryption.encrypt(arcWallet.privateKey);
      
      const userData = {
        telegramId,
        username: username || null,
        arcAddress: arcWallet.address,
        arcPrivateKeyEncrypted: encryptedPrivateKey,
        arcPublicKey: arcWallet.publicKey,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        version: '2.0'
      };

      const userKey = this.getUserKey(telegramId);
      
      // Store user data
      await this.kv.put(userKey, JSON.stringify(userData));
      
      // Create username lookup if username exists
      if (username) {
        const usernameKey = this.getUsernameKey(username);
        await this.kv.put(usernameKey, telegramId.toString());
      }
      
      this.logger.audit('user_created', telegramId, {
        arcAddress: arcWallet.address,
        username
      });

      return {
        telegramId,
        arcAddress: arcWallet.address,
        userData
      };
    } catch (error) {
      this.logger.error('Failed to create user', {
        telegramId,
        username,
        error: error.message
      });
      throw error;
    }
  }

  async getUserByTelegramId(telegramId) {
    try {
      const userKey = this.getUserKey(telegramId);
      const userData = await this.kv.get(userKey, 'json');
      
      if (!userData) {
        return null;
      }

      // Decrypt ARC private key when needed
      if (userData.arcPrivateKeyEncrypted) {
        try {
          userData.arcPrivateKey = await this.encryption.decrypt(userData.arcPrivateKeyEncrypted);
        } catch (decryptError) {
          this.logger.error('Failed to decrypt ARC private key', {
            telegramId,
            error: decryptError.message
          });
          // Don't throw, just log the error
        }
      }

      // Update last active timestamp
      userData.lastActive = new Date().toISOString();
      await this.kv.put(userKey, JSON.stringify(userData));

      return userData;
    } catch (error) {
      this.logger.error('Failed to fetch user by Telegram ID', {
        telegramId,
        error: error.message
      });
      throw error;
    }
  }

  async getUserByUsername(username) {
    try {
      if (!username) {
        return null;
      }

      const cleanUsername = username.replace('@', '').toLowerCase();
      const usernameKey = this.getUsernameKey(cleanUsername);
      
      // Get telegram ID from username lookup
      const telegramId = await this.kv.get(usernameKey);
      
      if (!telegramId) {
        return null;
      }

      // Get full user data
      return await this.getUserByTelegramId(parseInt(telegramId));
    } catch (error) {
      this.logger.error('Failed to fetch user by username', {
        username,
        error: error.message
      });
      throw error;
    }
  }

  async updateUser(telegramId, updates) {
    try {
      const userData = await this.getUserByTelegramId(telegramId);
      
      if (!userData) {
        throw new Error('User not found');
      }

      // Merge updates
      const updatedData = {
        ...userData,
        ...updates,
        lastActive: new Date().toISOString()
      };

      // Handle username changes
      if (updates.username && updates.username !== userData.username) {
        // Remove old username lookup
        if (userData.username) {
          const oldUsernameKey = this.getUsernameKey(userData.username);
          await this.kv.delete(oldUsernameKey);
        }
        
        // Add new username lookup
        const newUsernameKey = this.getUsernameKey(updates.username);
        await this.kv.put(newUsernameKey, telegramId.toString());
      }

      const userKey = this.getUserKey(telegramId);
      await this.kv.put(userKey, JSON.stringify(updatedData));

      this.logger.audit('user_updated', telegramId, {
        updatedFields: Object.keys(updates)
      });

      return updatedData;
    } catch (error) {
      this.logger.error('Failed to update user', {
        telegramId,
        error: error.message
      });
      throw error;
    }
  }

  async deleteUser(telegramId) {
    try {
      const userData = await this.getUserByTelegramId(telegramId);
      
      if (!userData) {
        throw new Error('User not found');
      }

      const userKey = this.getUserKey(telegramId);
      await this.kv.delete(userKey);

      // Remove username lookup
      if (userData.username) {
        const usernameKey = this.getUsernameKey(userData.username);
        await this.kv.delete(usernameKey);
      }

      this.logger.audit('user_deleted', telegramId, {
        arcAddress: userData.arcAddress
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to delete user', {
        telegramId,
        error: error.message
      });
      throw error;
    }
  }

  async getUserStats() {
    try {
      // KV doesn't have built-in count, so we'll estimate or use a counter
      // For now, return a placeholder - in production you might maintain a counter
      return {
        totalUsers: 'N/A (KV storage)',
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
      // Test KV operation
      const testKey = 'health_check_test';
      const testValue = new Date().toISOString();
      
      await this.kv.put(testKey, testValue);
      const retrieved = await this.kv.get(testKey);
      await this.kv.delete(testKey);
      
      if (retrieved === testValue) {
        return { status: 'healthy', service: 'UserStorage' };
      } else {
        throw new Error('KV read/write test failed');
      }
    } catch (error) {
      this.logger.error('User storage health check failed', {
        error: error.message
      });
      return { status: 'unhealthy', service: 'UserStorage', error: error.message };
    }
  }

  // Utility method to list all users (admin function)
  async listUsers(limit = 100) {
    try {
      const list = await this.kv.list({ prefix: 'user:', limit });
      const users = [];

      for (const key of list.keys) {
        try {
          const userData = await this.kv.get(key.name, 'json');
          if (userData) {
            // Remove sensitive data for listing
            const { arcPrivateKeyEncrypted, arcPrivateKey, ...safeData } = userData;
            users.push(safeData);
          }
        } catch (error) {
          this.logger.warn('Failed to parse user data', {
            key: key.name,
            error: error.message
          });
        }
      }

      return users;
    } catch (error) {
      this.logger.error('Failed to list users', {
        error: error.message
      });
      throw error;
    }
  }

  // Clean up old inactive users (maintenance function)
  async cleanupInactiveUsers(daysInactive = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysInactive);

      const list = await this.kv.list({ prefix: 'user:' });
      let deletedCount = 0;

      for (const key of list.keys) {
        try {
          const userData = await this.kv.get(key.name, 'json');
          if (userData && userData.lastActive) {
            const lastActive = new Date(userData.lastActive);
            if (lastActive < cutoffDate) {
              await this.deleteUser(userData.telegramId);
              deletedCount++;
            }
          }
        } catch (error) {
          this.logger.warn('Failed to process user during cleanup', {
            key: key.name,
            error: error.message
          });
        }
      }

      this.logger.info('Cleanup completed', {
        deletedUsers: deletedCount,
        cutoffDate: cutoffDate.toISOString()
      });

      return deletedCount;
    } catch (error) {
      this.logger.error('Failed to cleanup inactive users', {
        error: error.message
      });
      throw error;
    }
  }
}