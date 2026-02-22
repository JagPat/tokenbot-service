// apps/tokenbot/services/dhanTokenFetcher.js
//
// Puppeteer-based Dhan OAuth token fetcher.
// Dhan login flow (login.dhan.co):
//   Step 1 → Enter mobile number → click Continue
//   Step 2 → Enter 6-digit PIN
//   Step 3 → Enter TOTP (if 2FA is enabled)
//   Step 4 → Capture access_token from redirect URL / page response

const logger = require('../utils/logger');
const browserPool = require('./browserPool');

class DhanTokenFetcher {
    /**
     * Fetch a Dhan access token via Puppeteer browser automation.
     * @param {Object} credentials
     * @param {string} credentials.client_id     - Dhan Client ID (1105489384)
     * @param {string} credentials.dhan_user_id  - Mobile number used to login (8320303515)
     * @param {string} credentials.password      - 6-digit login PIN (403826)
     * @param {string} [credentials.totp_secret] - TOTP secret for 2FA
     * @param {string} credentials.api_key       - Dhan developer API key
     * @param {string} [credentials.redirect_uri]
     */
    async fetchAccessToken(credentials) {
        const { client_id, dhan_user_id, password, totp_secret, api_key } = credentials;

        const loginId = dhan_user_id || client_id;
        if (!loginId || !password) {
            throw new Error('Dhan token fetch requires: mobile number (dhan_user_id) and PIN (password)');
        }

        logger.info(`[DhanTokenFetcher] 🚀 Starting Puppeteer login for mobile: ${loginId.slice(0, 4)}****`);

        let browserInfo = null;
        let browser = null;
        let page = null;

        try {
            // Acquire browser from pool
            browserInfo = await browserPool.acquire();
            browser = browserInfo.browser;
            logger.info(`[DhanTokenFetcher] ✅ Browser acquired: ${browserInfo.id}`);

            if (!browser || !browser.isConnected()) {
                throw new Error('Acquired browser is not connected');
            }

            page = await browser.newPage();
            await page.setUserAgent(
                'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
            );

            // Intercept API responses that return access tokens
            let capturedToken = null;

            await page.setRequestInterception(true);
            page.on('request', (req) => {
                // Check redirect URL for token
                const url = req.url();
                try {
                    const parsed = new URL(url);
                    const token =
                        parsed.searchParams.get('access_token') ||
                        parsed.searchParams.get('token') ||
                        parsed.searchParams.get('jwt') ||
                        parsed.searchParams.get('accessToken');
                    if (token && token.length > 20 && !capturedToken) {
                        capturedToken = token;
                        logger.info(`[DhanTokenFetcher] 🎯 Token found in redirect URL`);
                    }
                } catch (_) { }
                req.continue().catch(() => { });
            });

            page.on('response', async (res) => {
                if (capturedToken) return;
                try {
                    const url = res.url();
                    if (
                        url.includes('/login') ||
                        url.includes('/auth') ||
                        url.includes('/oauth') ||
                        url.includes('/token') ||
                        url.includes('/session') ||
                        url.includes('/partner')
                    ) {
                        const text = await res.text().catch(() => '');
                        if (!text || text.length < 5) return;
                        const json = JSON.parse(text);
                        const token =
                            json?.access_token || json?.accessToken || json?.token ||
                            json?.data?.access_token || json?.data?.accessToken || json?.data?.token ||
                            json?.result?.access_token || json?.result?.accessToken || json?.result?.token;
                        if (token && typeof token === 'string' && token.length > 20) {
                            capturedToken = token.trim();
                            logger.info(`[DhanTokenFetcher] 🎯 Token captured from API response: ${url}`);
                        }
                    }
                } catch (_) { }
            });

            // Navigate to Dhan login
            const loginUrl = api_key
                ? `https://login.dhan.co/?client_id=${encodeURIComponent(api_key)}`
                : 'https://login.dhan.co/';

            logger.info(`[DhanTokenFetcher] 🌐 Navigating to: ${loginUrl}`);
            await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));

            // ─── STEP 1: Enter mobile number ───────────────────────────────
            logger.info(`[DhanTokenFetcher] Step 1: Entering mobile number`);
            const mobileSelectors = [
                'input[name="phone"]', 'input[id="phone"]',
                'input[name="mobile"]', 'input[id="mobile"]',
                'input[name="userId"]', 'input[id="userId"]',
                'input[name="loginId"]', 'input[id="loginId"]',
                'input[placeholder*="Mobile"]', 'input[placeholder*="mobile"]',
                'input[placeholder*="Phone"]', 'input[placeholder*="phone"]',
                'input[type="tel"]', 'input[type="number"]',
                'input[type="text"]:first-of-type'
            ];

            let mobileFound = false;
            for (const sel of mobileSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        await el.click({ clickCount: 3 });
                        await el.type(loginId, { delay: 80 });
                        mobileFound = true;
                        logger.info(`[DhanTokenFetcher] ✅ Mobile entered (${sel})`);
                        break;
                    }
                } catch (_) { }
            }

            if (!mobileFound) {
                // Screenshot for debugging
                const ss = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
                logger.warn(`[DhanTokenFetcher] ⚠️ Mobile input not found. Page title: ${await page.title()}`);
                throw new Error('Could not find mobile/login input on Dhan login page');
            }

            // Click Continue / Next button
            await this._clickContinue(page, 'Continue after mobile');
            await new Promise(r => setTimeout(r, 2500));

            // ─── STEP 2: Enter PIN ────────────────────────────────────────
            logger.info(`[DhanTokenFetcher] Step 2: Entering PIN`);
            const pinSelectors = [
                'input[name="pin"]', 'input[id="pin"]',
                'input[name="password"]', 'input[id="password"]',
                'input[type="password"]',
                'input[placeholder*="PIN"]', 'input[placeholder*="pin"]',
                'input[placeholder*="Password"]',
                'input[maxlength="6"]'
            ];

            let pinFound = false;
            for (const sel of pinSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        await el.click({ clickCount: 3 });
                        await el.type(password, { delay: 80 });
                        pinFound = true;
                        logger.info(`[DhanTokenFetcher] ✅ PIN entered (${sel})`);
                        break;
                    }
                } catch (_) { }
            }

            if (!pinFound) {
                // Maybe PIN is individual digit boxes (OTP-style)
                const digitBoxes = await page.$$('input[maxlength="1"]');
                if (digitBoxes.length >= 4) {
                    const digits = String(password).split('');
                    for (let i = 0; i < Math.min(digits.length, digitBoxes.length); i++) {
                        await digitBoxes[i].click();
                        await digitBoxes[i].type(digits[i], { delay: 80 });
                    }
                    pinFound = true;
                    logger.info(`[DhanTokenFetcher] ✅ PIN entered via individual digit boxes`);
                }
            }

            if (!pinFound) {
                logger.warn(`[DhanTokenFetcher] ⚠️ PIN input not found, trying Enter key`);
                await page.keyboard.press('Tab');
                await page.keyboard.type(password, { delay: 80 });
                pinFound = true;
            }

            // Click Continue / Login button
            await this._clickContinue(page, 'Continue after PIN');
            await new Promise(r => setTimeout(r, 3000));

            // ─── STEP 3: Enter TOTP (if required) ────────────────────────
            if (totp_secret) {
                logger.info(`[DhanTokenFetcher] Step 3: Checking for TOTP prompt`);

                const otpSelectors = [
                    'input[name="otp"]', 'input[id="otp"]',
                    'input[name="totp"]', 'input[id="totp"]',
                    'input[placeholder*="OTP"]', 'input[placeholder*="TOTP"]',
                    'input[placeholder*="authenticator"]',
                    'input[maxlength="6"]'
                ];

                for (const sel of otpSelectors) {
                    try {
                        const el = await page.$(sel);
                        if (el) {
                            const { authenticator } = require('otplib');
                            const otp = authenticator.generate(totp_secret);
                            await el.click({ clickCount: 3 });
                            await el.type(otp, { delay: 80 });
                            logger.info(`[DhanTokenFetcher] ✅ TOTP entered: ${otp}`);
                            await this._clickContinue(page, 'Submit TOTP');
                            await new Promise(r => setTimeout(r, 3000));
                            break;
                        }
                    } catch (_) { }
                }

                // Also handle individual-digit OTP boxes
                const digitBoxes = await page.$$('input[maxlength="1"]');
                if (digitBoxes.length >= 6 && !capturedToken) {
                    const { authenticator } = require('otplib');
                    const otp = authenticator.generate(totp_secret);
                    const digits = otp.split('');
                    for (let i = 0; i < Math.min(digits.length, digitBoxes.length); i++) {
                        await digitBoxes[i].click();
                        await digitBoxes[i].type(digits[i], { delay: 80 });
                    }
                    logger.info(`[DhanTokenFetcher] ✅ TOTP entered via digit boxes: ${otp}`);
                    await this._clickContinue(page, 'Submit TOTP digit boxes');
                    await new Promise(r => setTimeout(r, 3000));
                }
            }

            // ─── Wait for token capture ──────────────────────────────────
            let waited = 0;
            while (!capturedToken && waited < 20000) {
                await new Promise(r => setTimeout(r, 1000));
                waited += 1000;

                // Check current URL for token
                try {
                    const currentUrl = page.url();
                    const parsed = new URL(currentUrl);
                    const token =
                        parsed.searchParams.get('access_token') ||
                        parsed.searchParams.get('token') ||
                        parsed.searchParams.get('accessToken');
                    if (token && token.length > 20) {
                        capturedToken = token;
                        logger.info(`[DhanTokenFetcher] 🎯 Token found in page URL`);
                        break;
                    }
                } catch (_) { }

                // Check localStorage / sessionStorage
                try {
                    const stored = await page.evaluate(() => {
                        const keys = ['access_token', 'accessToken', 'token', 'jwt', 'dhan_token', 'auth_token'];
                        for (const k of keys) {
                            const v = localStorage.getItem(k) || sessionStorage.getItem(k);
                            if (v && v.length > 20) return v;
                        }
                        // Also check if there's a JSON blob with access_token
                        for (let i = 0; i < localStorage.length; i++) {
                            try {
                                const raw = localStorage.getItem(localStorage.key(i));
                                const parsed = JSON.parse(raw || '');
                                const t = parsed?.access_token || parsed?.accessToken || parsed?.token;
                                if (t && t.length > 20) return t;
                            } catch (_) { }
                        }
                        return null;
                    });
                    if (stored && stored.length > 20) {
                        capturedToken = stored;
                        logger.info(`[DhanTokenFetcher] 🎯 Token found in localStorage`);
                        break;
                    }
                } catch (_) { }

                // Check cookies
                try {
                    const cookies = await page.cookies();
                    for (const c of cookies) {
                        if (['access_token', 'token', 'jwt', 'auth_token', 'dhan_jwt'].includes(c.name) && c.value.length > 20) {
                            capturedToken = c.value;
                            logger.info(`[DhanTokenFetcher] 🎯 Token found in cookie: ${c.name}`);
                            break;
                        }
                    }
                } catch (_) { }
            }

            if (!capturedToken) {
                const finalUrl = page.url();
                logger.warn(`[DhanTokenFetcher] ⚠️ No token captured. Final URL: ${finalUrl}`);
                throw new Error(
                    `Dhan Puppeteer login completed but no access token was captured. ` +
                    `Final URL: ${finalUrl}. ` +
                    `Possible cause: login failed (wrong PIN?), TOTP required but not provided, ` +
                    `or token stored in unexpected location.`
                );
            }

            const expiresAt = new Date(Date.now() + 20 * 3600000); // 20h default
            logger.info(`[DhanTokenFetcher] ✅ Access token obtained for client ${client_id}`);

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

    async _clickContinue(page, label) {
        const buttonSelectors = [
            'button[type="submit"]',
            'button:not([type="button"])',
            '[data-testid*="continue"]', '[data-testid*="login"]', '[data-testid*="submit"]',
            '[class*="continue"]', '[class*="login"]', '[class*="submit"]',
            'button'
        ];

        for (const sel of buttonSelectors) {
            try {
                const buttons = await page.$$(sel);
                for (const btn of buttons) {
                    const text = await page.evaluate(el => el.innerText?.toLowerCase() || '', btn);
                    const isVisible = await page.evaluate(el => {
                        const s = window.getComputedStyle(el);
                        return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0;
                    }, btn);
                    if (isVisible && (
                        text.includes('continue') || text.includes('login') ||
                        text.includes('next') || text.includes('submit') ||
                        text.includes('verify') || text.includes('proceed')
                    )) {
                        await btn.click();
                        logger.info(`[DhanTokenFetcher] ✅ Clicked button: "${text}" (${label})`);
                        return;
                    }
                }
            } catch (_) { }
        }

        // Fallback: press Enter
        await page.keyboard.press('Enter');
        logger.info(`[DhanTokenFetcher] ✅ Pressed Enter (${label})`);
    }
}

module.exports = new DhanTokenFetcher();
