// apps/tokenbot/services/dhanTokenFetcher.js
//
// Puppeteer-based Dhan OAuth token fetcher.
// Dhan's flow:
//   1. Open https://login.dhan.co/?client_id=<API_KEY>&redirect_uri=<app_redirect>
//   2. Enter Mobile / Client ID + Password
//   3. If OTP required, enter TOTP
//   4. After login, Dhan redirects to redirect_uri with ?access_token=<JWT>
//      OR sets the token in the page/cookie
//   5. Capture and return the access token
//
// Fallback: if redirect URI is not set up, capture the token from page cookies/localStorage.

const logger = require('../utils/logger');
const browserPool = require('./browserPool');

const DHAN_LOGIN_URL = 'https://login.dhan.co/';
const DHAN_API_BASE = 'https://api.dhan.co/v2';

class DhanTokenFetcher {
    /**
     * Fetch a Dhan access token using Puppeteer browser automation.
     * @param {Object} credentials
     * @param {string} credentials.client_id    - Dhan client/account ID (e.g. 1105489384)
     * @param {string} credentials.dhan_user_id - Dhan login User ID / Mobile number (same as client_id usually)
     * @param {string} credentials.password     - Dhan login password
     * @param {string} [credentials.totp_secret] - Optional TOTP secret for 2FA
     * @param {string} credentials.api_key      - Dhan developer API key (e.g. b5916c34)
     * @param {string} [credentials.redirect_uri] - OAuth redirect URI registered in Dhan app
     * @returns {Promise<{ access_token: string, expires_at: Date }>}
     */
    async fetchAccessToken(credentials) {
        const { client_id, dhan_user_id, password, totp_secret, api_key, redirect_uri } = credentials;

        const loginId = dhan_user_id || client_id;
        if (!loginId || !password || !api_key) {
            throw new Error('Dhan token fetch requires: client_id (or dhan_user_id), password, and api_key');
        }

        logger.info(`[DhanTokenFetcher] 🚀 Starting Puppeteer login for client: ${client_id}`);

        let browserInfo = null;
        let browser = null;
        let page = null;

        try {
            // Acquire browser from pool
            try {
                browserInfo = await browserPool.acquire();
                browser = browserInfo.browser;
                logger.info(`[DhanTokenFetcher] ✅ Browser acquired: ${browserInfo.id}`);
            } catch (poolError) {
                throw new Error(`Browser pool unavailable: ${poolError.message}`);
            }

            if (!browser || !browser.isConnected()) {
                throw new Error('Acquired browser is not connected');
            }

            page = await browser.newPage();
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            // Intercept network requests to capture the access token from redirect URL
            let capturedToken = null;
            let capturedFromNetwork = false;

            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const url = req.url();
                // Check if this is the redirect after OAuth login
                try {
                    const parsed = new URL(url);
                    const token = parsed.searchParams.get('access_token') ||
                        parsed.searchParams.get('token') ||
                        parsed.searchParams.get('jwt');
                    if (token && token.length > 20) {
                        capturedToken = token;
                        capturedFromNetwork = true;
                        logger.info(`[DhanTokenFetcher] 🎯 Token intercepted from redirect URL`);
                    }
                } catch (_) {
                    // ignore parse errors
                }
                req.continue().catch(() => { });
            });

            // Also intercept API responses that might return the token
            page.on('response', async (res) => {
                if (capturedToken) return;
                try {
                    const url = res.url();
                    if (url.includes('/v2/access-token') || url.includes('/v2/Sessions') || url.includes('/login')) {
                        const body = await res.text().catch(() => '{}');
                        const json = JSON.parse(body);
                        const token = json?.access_token || json?.accessToken || json?.token ||
                            json?.data?.access_token || json?.data?.accessToken || json?.data?.token;
                        if (token && token.length > 20) {
                            capturedToken = String(token).trim();
                            logger.info(`[DhanTokenFetcher] 🎯 Token captured from API response`);
                        }
                    }
                } catch (_) {
                    // ignore
                }
            });

            // Build OAuth login URL
            const loginUrl = redirect_uri
                ? `${DHAN_LOGIN_URL}?client_id=${encodeURIComponent(api_key)}&redirect_uri=${encodeURIComponent(redirect_uri)}`
                : `${DHAN_LOGIN_URL}?client_id=${encodeURIComponent(api_key)}`;

            logger.info(`[DhanTokenFetcher] 🌐 Navigating to: ${loginUrl}`);
            await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Wait a moment for the page to load
            await new Promise(r => setTimeout(r, 2000));

            // Take screenshot for debugging
            const screenshot = await page.screenshot({ encoding: 'base64' }).catch(() => null);
            if (screenshot) {
                logger.info(`[DhanTokenFetcher] 📸 Page loaded (screenshot captured)`);
            }

            // Fill in the login form
            // Dhan's login page typically has: mobile/userid field + password field
            const loginIdSelectors = [
                'input[name="userId"]', 'input[id="userId"]',
                'input[name="loginId"]', 'input[id="loginId"]',
                'input[name="mobile"]', 'input[id="mobile"]',
                'input[placeholder*="User ID"]', 'input[placeholder*="Mobile"]',
                'input[type="text"]:first-of-type'
            ];

            let loginIdFilled = false;
            for (const selector of loginIdSelectors) {
                try {
                    const el = await page.$(selector);
                    if (el) {
                        await el.click({ clickCount: 3 });
                        await el.type(loginId, { delay: 50 });
                        loginIdFilled = true;
                        logger.info(`[DhanTokenFetcher] ✅ Login ID filled using: ${selector}`);
                        break;
                    }
                } catch (_) { }
            }

            if (!loginIdFilled) {
                throw new Error('Could not find login ID input field on Dhan login page');
            }

            await new Promise(r => setTimeout(r, 500));

            // Password field
            const passwordSelectors = [
                'input[name="password"]', 'input[id="password"]',
                'input[type="password"]',
                'input[placeholder*="Password"]', 'input[placeholder*="password"]'
            ];

            let passwordFilled = false;
            for (const selector of passwordSelectors) {
                try {
                    const el = await page.$(selector);
                    if (el) {
                        await el.click({ clickCount: 3 });
                        await el.type(password, { delay: 50 });
                        passwordFilled = true;
                        logger.info(`[DhanTokenFetcher] ✅ Password filled`);
                        break;
                    }
                } catch (_) { }
            }

            if (!passwordFilled) {
                throw new Error('Could not find password input on Dhan login page');
            }

            // Click the login/continue button
            const buttonSelectors = [
                'button[type="submit"]',
                'button:contains("Login")', 'button:contains("Continue")', 'button:contains("Next")',
                '[data-testid="login-btn"]', '[id*="login"]', '[class*="login-btn"]'
            ];

            let buttonClicked = false;
            for (const selector of buttonSelectors) {
                try {
                    const el = await page.$(selector);
                    if (el) {
                        await el.click();
                        buttonClicked = true;
                        logger.info(`[DhanTokenFetcher] ✅ Login button clicked: ${selector}`);
                        break;
                    }
                } catch (_) { }
            }

            if (!buttonClicked) {
                // Try Enter key
                await page.keyboard.press('Enter');
                logger.info(`[DhanTokenFetcher] ✅ Pressed Enter to submit`);
            }

            // Wait after login attempt
            await new Promise(r => setTimeout(r, 3000));

            // Check if TOTP/OTP is needed
            if (totp_secret) {
                const otpSelectors = [
                    'input[name="otp"]', 'input[id="otp"]',
                    'input[name="totp"]', 'input[id="totp"]',
                    'input[placeholder*="OTP"]', 'input[placeholder*="TOTP"]',
                    'input[maxlength="6"]', 'input[type="tel"]'
                ];

                for (const selector of otpSelectors) {
                    try {
                        const el = await page.$(selector);
                        if (el) {
                            const { authenticator } = require('otplib');
                            const otp = authenticator.generate(totp_secret);
                            await el.click({ clickCount: 3 });
                            await el.type(otp, { delay: 50 });
                            logger.info(`[DhanTokenFetcher] ✅ TOTP entered: ${otp}`);
                            await new Promise(r => setTimeout(r, 500));

                            // Submit OTP
                            const otpSubmitBtn = await page.$('button[type="submit"]');
                            if (otpSubmitBtn) {
                                await otpSubmitBtn.click();
                            } else {
                                await page.keyboard.press('Enter');
                            }
                            await new Promise(r => setTimeout(r, 3000));
                            break;
                        }
                    } catch (_) { }
                }
            }

            // Wait for redirect (up to 15s) and check for captured token
            let waited = 0;
            while (!capturedToken && waited < 15000) {
                await new Promise(r => setTimeout(r, 1000));
                waited += 1000;

                // Also check page URL for token
                try {
                    const currentUrl = page.url();
                    const parsed = new URL(currentUrl);
                    const urlToken = parsed.searchParams.get('access_token') ||
                        parsed.searchParams.get('token');
                    if (urlToken && urlToken.length > 20) {
                        capturedToken = urlToken;
                        logger.info(`[DhanTokenFetcher] 🎯 Token found in page URL`);
                        break;
                    }
                } catch (_) { }

                // Check localStorage / sessionStorage for token
                try {
                    const storedToken = await page.evaluate(() => {
                        const keys = ['access_token', 'accessToken', 'dhan_token', 'token', 'jwt'];
                        for (const k of keys) {
                            const v = localStorage.getItem(k) || sessionStorage.getItem(k);
                            if (v && v.length > 20) return v;
                        }
                        return null;
                    });
                    if (storedToken) {
                        capturedToken = storedToken;
                        logger.info(`[DhanTokenFetcher] 🎯 Token found in localStorage`);
                        break;
                    }
                } catch (_) { }
            }

            if (!capturedToken) {
                // Last resort: try to find it in page cookies
                try {
                    const cookies = await page.cookies();
                    for (const cookie of cookies) {
                        if (['access_token', 'token', 'jwt', 'dhan_jwt'].includes(cookie.name) && cookie.value.length > 20) {
                            capturedToken = cookie.value;
                            logger.info(`[DhanTokenFetcher] 🎯 Token found in cookies (${cookie.name})`);
                            break;
                        }
                    }
                } catch (_) { }
            }

            if (!capturedToken) {
                throw new Error(
                    'Dhan Puppeteer login completed but no access token was captured. ' +
                    'The redirect URL or login flow may have changed. Check if the redirect_uri is configured in the Dhan app settings.'
                );
            }

            const expiresAt = new Date(Date.now() + 20 * 3600000); // 20h default
            logger.info(`[DhanTokenFetcher] ✅ Access token obtained for client ${client_id}, expires: ${expiresAt.toISOString()}`);

            return {
                access_token: capturedToken,
                expires_at: expiresAt,
                client_id
            };

        } finally {
            if (page) {
                try { await page.close(); } catch (_) { }
            }
            if (browserInfo) {
                try { await browserPool.release(browserInfo); } catch (_) { }
            }
        }
    }
}

module.exports = new DhanTokenFetcher();
