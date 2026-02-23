// apps/tokenbot/services/token-managers/TokenManager.js

/**
 * @typedef {Object} TokenRefreshResult
 * @property {boolean} success
 * @property {string} [error]
 * @property {Date} [next_refresh_at]
 * @property {string} [token_status]
 * @property {string} [access_token]
 * @property {string} [refresh_token]
 * @property {number} [execution_time_ms]
 */

class TokenManager {
    constructor() {
        if (this.constructor === TokenManager) {
            throw new Error("Abstract class TokenManager cannot be instantiated directly.");
        }
    }

    get brokerType() {
        throw new Error("Method 'brokerType' must be implemented.");
    }

    get refreshInterval() {
        throw new Error("Method 'refreshInterval' must be implemented.");
    }

    /**
     * Refreshes the token for a specific broker connection.
     * @param {Object} context - { userId, connectionId, accountId, currentToken, correlationId }
     * @returns {Promise<TokenRefreshResult>}
     */
    async refresh(context) {
        throw new Error("Method 'refresh()' must be implemented.");
    }

    getExpiryWarningThreshold() {
        throw new Error("Method 'getExpiryWarningThreshold()' must be implemented.");
    }
}

module.exports = TokenManager;
