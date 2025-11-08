const crypto = require('crypto');
const config = require('../config');

class EncryptionService {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    // Ensure key is exactly 32 bytes for AES-256
    const key = config.security.encryptionKey;
    if (key.length !== 32) {
      throw new Error('Encryption key must be exactly 32 characters');
    }
    this.keyBuffer = Buffer.from(key, 'utf8');
  }

  encrypt(text) {
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.keyBuffer, iv);
      cipher.setAAD(Buffer.from('arc-bot-auth', 'utf8'));
      
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        encrypted
      };
    } catch (error) {
      throw new Error('Encryption failed: ' + error.message);
    }
  }

  decrypt(encryptedData) {
    try {
      const { iv, authTag, encrypted } = encryptedData;
      
      const decipher = crypto.createDecipheriv(this.algorithm, this.keyBuffer, Buffer.from(iv, 'hex'));
      decipher.setAAD(Buffer.from('arc-bot-auth', 'utf8'));
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      throw new Error('Decryption failed: ' + error.message);
    }
  }

  hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }
}

module.exports = new EncryptionService();