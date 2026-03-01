const crypto = require('crypto');

const LEGACY_ALGORITHM = 'aes-256-cbc';
const CANONICAL_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const GCM_TAG_BYTES = 16;

function isHex(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

function mapDecryptError(message, format) {
  const normalized = String(message || '').toLowerCase();
  if (normalized.includes('invalid authentication tag length')) return 'TOKEN_GCM_TAG_LENGTH_INVALID';
  if (normalized.includes('unable to authenticate data')) {
    return format === 'GCM' ? 'TOKEN_GCM_AUTH_FAILED' : 'TOKEN_DECRYPT_AUTH_FAILED';
  }
  if (normalized.includes('invalid initialization vector')) return 'TOKEN_IV_INVALID';
  if (normalized.includes('bad decrypt')) return 'TOKEN_DECRYPT_BAD_DATA';
  return 'TOKEN_DECRYPT_ERROR';
}

class Encryptor {
  constructor() {
    this.encryptionKey = null;
    this.keyFingerprint = null;
    
    if (process.env.ENCRYPTION_KEY) {
      const normalized = String(process.env.ENCRYPTION_KEY).trim();
      if (!/^[0-9a-f]{64}$/i.test(normalized)) {
        console.warn('⚠️ ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
      } else {
        this.encryptionKey = Buffer.from(normalized, 'hex');
        this.keyFingerprint = crypto.createHash('sha256').update(this.encryptionKey).digest('hex').slice(0, 12);
      }
    } else {
      console.warn('⚠️ ENCRYPTION_KEY environment variable not set');
    }
  }

  encrypt(text) {
    if (!this.encryptionKey) {
      throw new Error('Encryption service not initialized - ENCRYPTION_KEY required');
    }
    
    if (!text) throw new Error('Text to encrypt is required');

    // Canonical format for BrokerConnection/access tokens is GCM (iv:cipher:tag).
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(CANONICAL_ALGORITHM, this.encryptionKey, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${encrypted}:${authTag}`;
  }

  describePayload(encryptedText) {
    const payload = typeof encryptedText === 'string' ? encryptedText.trim() : '';
    const parts = payload ? payload.split(':') : [];
    return {
      parts: parts.length,
      ivLength: parts[0] ? parts[0].length : 0,
      cipherLength: parts[1] ? parts[1].length : 0,
      tagLength: parts[2] ? parts[2].length : 0
    };
  }

  detectFormat(encryptedText) {
    const payload = typeof encryptedText === 'string' ? encryptedText.trim() : '';
    const shape = this.describePayload(payload);
    if (!payload) {
      return { format: 'NONE', reasonCode: 'TOKEN_EMPTY', shape };
    }

    const parts = payload.split(':');
    if (parts.length === 3) {
      const [ivHex, encryptedHex, authTagHex] = parts;
      if (!isHex(ivHex) || ivHex.length !== IV_LENGTH * 2) return { format: 'GCM', reasonCode: 'TOKEN_GCM_IV_INVALID', shape };
      if (!isHex(encryptedHex)) return { format: 'GCM', reasonCode: 'TOKEN_GCM_CIPHER_INVALID', shape };
      if (!isHex(authTagHex)) return { format: 'GCM', reasonCode: 'TOKEN_GCM_TAG_INVALID', shape };
      if (authTagHex.length !== GCM_TAG_BYTES * 2) return { format: 'GCM', reasonCode: 'TOKEN_GCM_TAG_LENGTH_INVALID', shape };
      return { format: 'GCM', reasonCode: 'TOKEN_OK', shape };
    }

    if (parts.length === 2) {
      const [ivHex, encryptedHex] = parts;
      if (!isHex(ivHex) || ivHex.length !== IV_LENGTH * 2) return { format: 'CBC', reasonCode: 'TOKEN_CBC_IV_INVALID', shape };
      if (!isHex(encryptedHex)) return { format: 'CBC', reasonCode: 'TOKEN_CBC_CIPHER_INVALID', shape };
      return { format: 'CBC', reasonCode: 'TOKEN_CBC_LEGACY_FORMAT', shape };
    }

    return { format: 'UNKNOWN', reasonCode: 'TOKEN_FORMAT_UNSUPPORTED', shape };
  }

  decryptWithMeta(encryptedText, options = {}) {
    if (!this.encryptionKey) {
      return {
        ok: false,
        value: null,
        format: 'UNKNOWN',
        reasonCode: 'ENCRYPTION_KEY_MISSING',
        shape: this.describePayload(encryptedText)
      };
    }

    const allowLegacy = options.allowLegacy !== false;
    const detected = this.detectFormat(encryptedText);
    if (detected.reasonCode !== 'TOKEN_OK' && detected.reasonCode !== 'TOKEN_CBC_LEGACY_FORMAT') {
      return {
        ok: false,
        value: null,
        format: detected.format,
        reasonCode: detected.reasonCode,
        shape: detected.shape
      };
    }

    if (detected.format === 'CBC' && !allowLegacy) {
      return {
        ok: false,
        value: null,
        format: detected.format,
        reasonCode: 'TOKEN_LEGACY_FORMAT_DISABLED',
        shape: detected.shape
      };
    }

    try {
      const parts = String(encryptedText).trim().split(':');
      let decrypted = '';

      if (detected.format === 'GCM') {
        const [ivHex, encryptedHex, authTagHex] = parts;
        const decipher = crypto.createDecipheriv(
          CANONICAL_ALGORITHM,
          this.encryptionKey,
          Buffer.from(ivHex, 'hex')
        );
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
      } else if (detected.format === 'CBC') {
        const [ivHex, encryptedHex] = parts;
        const decipher = crypto.createDecipheriv(
          LEGACY_ALGORITHM,
          this.encryptionKey,
          Buffer.from(ivHex, 'hex')
        );
        decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
      } else {
        return {
          ok: false,
          value: null,
          format: detected.format,
          reasonCode: 'TOKEN_FORMAT_UNSUPPORTED',
          shape: detected.shape
        };
      }

      return {
        ok: true,
        value: decrypted || null,
        format: detected.format,
        reasonCode: 'TOKEN_OK',
        shape: detected.shape
      };
    } catch (error) {
      return {
        ok: false,
        value: null,
        format: detected.format,
        reasonCode: mapDecryptError(error.message, detected.format),
        errorMessage: error.message,
        shape: detected.shape
      };
    }
  }

  decrypt(encryptedText, options = {}) {
    const result = this.decryptWithMeta(encryptedText, options);
    if (!result.ok) {
      const error = new Error(result.errorMessage || result.reasonCode || 'Token decrypt failed');
      error.code = result.reasonCode || 'TOKEN_DECRYPT_FAILED';
      error.format = result.format;
      error.shape = result.shape;
      throw error;
    }
    return result.value;
  }

  getKeyFingerprint() {
    return this.keyFingerprint;
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
