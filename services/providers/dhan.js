const axios = require('axios');
const logger = require('../../utils/logger');
const { authenticator } = require('otplib');

class DhanAuthProvider {
    constructor() {
        this.baseUrl = 'https://api.dhan.co/v2';
    }

    _extractTokenPayload(payload) {
        const accessToken =
            payload?.accessToken ||
            payload?.access_token ||
            payload?.token ||
            payload?.data?.accessToken ||
            payload?.data?.access_token ||
            payload?.data?.token;

        if (!accessToken || typeof accessToken !== 'string') {
            return null;
        }

        const expiresAt =
            payload?.expiresAt ||
            payload?.expires_at ||
            payload?.expiry ||
            payload?.data?.expiresAt ||
            payload?.data?.expires_at ||
            payload?.data?.expiry ||
            null;

        return {
            access_token: accessToken.trim(),
            refresh_token: payload?.refreshToken || payload?.refresh_token || payload?.data?.refreshToken || payload?.data?.refresh_token || null,
            expires_at: expiresAt
        };
    }

    async renewToken(accessToken, accountId) {
        const headers = {
            'access-token': accessToken,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
        if (accountId) {
            headers['client-id'] = accountId;
            headers['dhanClientId'] = accountId;
        }

        let payload = null;
        try {
            const response = await axios.get(`${this.baseUrl}/RenewToken`, { headers, timeout: 15000 });
            payload = response.data;
        } catch (error) {
            if (error?.response?.status === 405) {
                const response = await axios.post(`${this.baseUrl}/RenewToken`, {}, { headers, timeout: 15000 });
                payload = response.data;
            } else {
                throw error;
            }
        }

        const tokenData = this._extractTokenPayload(payload);
        if (!tokenData?.access_token) {
            throw new Error('Dhan RenewToken did not return an access token');
        }

        return tokenData;
    }

    /**
     * Validate a token by making a test request
     * @param {string} accessToken 
     * @param {string} accountId 
     * @returns {Promise<boolean>}
     */
    async validateToken(accessToken, accountId) {
        try {
            const headers = {
                'access-token': accessToken,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            };

            // Prefer /fundlimit (v2). Fallback to older path for compatibility.
            try {
                await axios.get(`${this.baseUrl}/fundlimit`, { headers });
            } catch (error) {
                if (error?.response?.status !== 404) throw error;
                await axios.get(`${this.baseUrl}/fund/limits`, { headers });
            }

            // If success, token is valid
            return true;
        } catch (error) {
            logger.warn(`Dhan token validation failed for ${accountId}: ${error.message}`);
            return false;
        }
    }

    /**
     * Generate token (Placeholder for now)
     * Dhan requires browser-based consent flow or specific partner API
     */
    async fetchToken(credentials) {
        const accessToken = credentials?.access_token || credentials?.accessToken || credentials?.token;
        const accountId = credentials?.accountId || credentials?.clientId || credentials?.dhanClientId || null;

        if (!accessToken) {
            throw new Error('Dhan automated refresh requires an existing access token');
        }

        return this.renewToken(accessToken, accountId);
    }
}

module.exports = new DhanAuthProvider();
