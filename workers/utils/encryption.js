// Encryption utilities for Cloudflare Workers

export class EncryptionService {
  constructor(encryptionKey) {
    this.key = encryptionKey;
  }

  async encrypt(text) {
    try {
      // Convert key to CryptoKey
      const keyBuffer = new TextEncoder().encode(this.key);
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );

      // Generate random IV
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      // Encrypt the text
      const encodedText = new TextEncoder().encode(text);
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        encodedText
      );

      // Return as base64 strings
      return {
        iv: this.arrayBufferToBase64(iv),
        encrypted: this.arrayBufferToBase64(encrypted)
      };
    } catch (error) {
      throw new Error('Encryption failed: ' + error.message);
    }
  }

  async decrypt(encryptedData) {
    try {
      const { iv, encrypted } = encryptedData;
      
      // Convert key to CryptoKey
      const keyBuffer = new TextEncoder().encode(this.key);
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      // Convert base64 back to ArrayBuffer
      const ivBuffer = this.base64ToArrayBuffer(iv);
      const encryptedBuffer = this.base64ToArrayBuffer(encrypted);
      
      // Decrypt
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBuffer },
        cryptoKey,
        encryptedBuffer
      );

      return new TextDecoder().decode(decrypted);
    } catch (error) {
      throw new Error('Decryption failed: ' + error.message);
    }
  }

  async hash(data) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return this.arrayBufferToBase64(hashBuffer);
  }

  generateSecureToken(length = 32) {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}