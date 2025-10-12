const puppeteer = require('puppeteer');
const otplib = require('otplib');
const KiteConnect = require('kiteconnect').KiteConnect;
const logger = require('../utils/logger');

class TokenFetcher {
  async fetchAccessToken({ kite_user_id, password, totp_secret, api_key, api_secret }) {
    const startTime = Date.now();
    let browser = null;
    
    try {
      logger.info(`🚀 Starting token fetch for user: ${kite_user_id}`);
      
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-software-rasterizer'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
      });
      
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Step 1: Navigate to Kite login
      logger.info('📄 Navigating to Kite login page');
      await page.goto('https://kite.zerodha.com', { 
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // Step 2: Enter user ID and password
      logger.info('🔑 Entering credentials');
      await page.waitForSelector('#userid', { timeout: 10000 });
      await page.type('#userid', kite_user_id);
      await page.type('#password', password);
      await page.click('button[type="submit"]');
      
      // Step 3: Handle TOTP
      logger.info('🔐 Generating and entering TOTP');
      await page.waitForSelector('#totp', { timeout: 10000 });
      const totp = otplib.authenticator.generate(totp_secret);
      logger.info(`✅ TOTP generated: ${totp}`);
      await page.type('#totp', totp);
      await page.click('button[type="submit"]');
      
      // Step 4: Wait for redirect and extract request token
      logger.info('⏳ Waiting for authentication redirect');
      await page.waitForNavigation({ timeout: 15000 });
      const currentUrl = page.url();
      logger.info(`🔗 Redirected to: ${currentUrl}`);
      
      const requestToken = new URL(currentUrl).searchParams.get('request_token');
      if (!requestToken) {
        throw new Error('Request token not found in redirect URL');
      }
      
      logger.info(`✅ Request token extracted: ${requestToken.substring(0, 10)}...`);
      
      await browser.close();
      browser = null;
      
      // Step 5: Generate session using KiteConnect
      logger.info('🔄 Generating session with KiteConnect API');
      const kite = new KiteConnect({ api_key });
      const session = await kite.generateSession(requestToken, api_secret);
      
      const executionTime = Date.now() - startTime;
      logger.info(`✅ Token generation successful in ${executionTime}ms`);
      
      return {
        access_token: session.access_token,
        public_token: session.public_token || null,
        login_time: session.login_time || new Date().toISOString(),
        expires_at: this.calculateExpiry(session.login_time || new Date()),
        execution_time_ms: executionTime
      };
      
    } catch (error) {
      logger.error(`❌ Token fetch failed: ${error.message}`);
      logger.error(error.stack);
      
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          logger.error('Failed to close browser:', closeError);
        }
      }
      
      throw error;
    }
  }
  
  calculateExpiry(loginTime) {
    // Kite tokens expire at 11:59 PM IST on the same day
    const loginDate = new Date(loginTime);
    
    // Convert to IST
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
    const loginIST = new Date(loginDate.getTime() + istOffset);
    
    // Set to 11:59 PM IST
    const expiryIST = new Date(loginIST);
    expiryIST.setHours(23, 59, 59, 999);
    
    // Convert back to UTC
    const expiryUTC = new Date(expiryIST.getTime() - istOffset);
    
    return expiryUTC.toISOString();
  }
}

module.exports = new TokenFetcher();

