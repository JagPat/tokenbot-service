const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 64 hex chars = 32 bytes

class Encryptor {
  constructor() {
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }

    if (process.env.ENCRYPTION_KEY.length !== 64) {
      throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
  }

  encrypt(text) {
    if (!text) throw new Error('Text to encrypt is required');
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Return format: iv:encryptedData
    return `${iv.toString('hex')}:${encrypted}`;
  }

  decrypt(encryptedText) {
    if (!encryptedText) throw new Error('Encrypted text is required');
    
    const [ivHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !encrypted) throw new Error('Invalid encrypted format');
    
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * Test encryption/decryption
   */
  test() {
    try {
      const testData = 'test-data-12345';
      const encrypted = this.encrypt(testData);
      const decrypted = this.decrypt(encrypted);
      
      if (testData === decrypted) {
        console.log('✅ Encryption service working correctly');
        return true;
      } else {
        console.error('❌ Encryption test failed: decrypted data does not match original');
        return false;
      }
    } catch (error) {
      console.error('❌ Encryption test error:', error.message);
      return false;
    }
  }
}

module.exports = new Encryptor();

