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
      
      // Generate TOTP code
      const totp = otplib.authenticator.generate(totp_secret);
      logger.info(`✅ TOTP generated: ${totp}`);
      
      // Try multiple selectors for TOTP field (Zerodha may use different selectors)
      const totpSelectors = [
        '#totp',                           // Original selector
        'input[name="totp"]',             // Name-based selector
        'input[id="totp"]',               // Explicit ID selector
        '#totpcode',                       // Alternative ID
        'input[placeholder*="TOTP" i]',   // Placeholder-based (case-insensitive)
        'input[placeholder*="totp" i]',   // Lowercase placeholder
        'input[type="text"]',             // Generic text input (fallback)
        '.totp-input',                     // Class-based selector
        '[data-name="totp"]'               // Data attribute selector
      ];
      
      let totpFieldFound = false;
      let usedSelector = null;
      
      // Try each selector with a shorter timeout per attempt
      for (const selector of totpSelectors) {
        try {
          logger.info(`🔍 Trying TOTP selector: ${selector}`);
          await page.waitForSelector(selector, { timeout: 5000 });
          
          // Verify the element is visible and enabled
          const isVisible = await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            return element && 
                   element.offsetParent !== null && 
                   !element.disabled &&
                   element.offsetWidth > 0 &&
                   element.offsetHeight > 0;
          }, selector);
          
          if (isVisible) {
            logger.info(`✅ TOTP field found with selector: ${selector}`);
            usedSelector = selector;
            totpFieldFound = true;
            break;
          } else {
            logger.warn(`⚠️ TOTP field found but not visible with selector: ${selector}`);
          }
        } catch (error) {
          logger.debug(`Selector ${selector} not found, trying next...`);
          continue;
        }
      }
      
      if (!totpFieldFound) {
        // Take screenshot for debugging
        try {
          await page.screenshot({ path: '/tmp/totp-page-screenshot.png', fullPage: true });
          logger.error('📸 Screenshot saved to /tmp/totp-page-screenshot.png for debugging');
        } catch (screenshotError) {
          logger.warn('Failed to take screenshot:', screenshotError.message);
        }
        
        // Log page HTML for debugging (first 2000 chars)
        try {
          const pageHtml = await page.content();
          logger.debug('Page HTML (first 2000 chars):', pageHtml.substring(0, 2000));
        } catch (htmlError) {
          logger.warn('Failed to get page HTML:', htmlError.message);
        }
        
        throw new Error('TOTP input field not found. Zerodha login page structure may have changed. Please check the page and update selectors.');
      }
      
      // Type TOTP code into the field
      logger.info(`📝 Entering TOTP code into field: ${usedSelector}`);
      await page.type(usedSelector, totp, { delay: 100 }); // Add small delay for reliability
      
      // Find and click submit button (try multiple selectors)
      const submitSelectors = [
        'button[type="submit"]',
        'button:contains("Login")',
        'input[type="submit"]',
        'button.submit',
        'button.login',
        'form button[type="button"]' // Some forms use button instead of submit
      ];
      
      let submitButtonClicked = false;
      for (const submitSelector of submitSelectors) {
        try {
          const submitButton = await page.$(submitSelector);
          if (submitButton) {
            const isVisible = await page.evaluate((sel) => {
              const btn = document.querySelector(sel);
              return btn && btn.offsetParent !== null;
            }, submitSelector);
            
            if (isVisible) {
              logger.info(`✅ Clicking submit button with selector: ${submitSelector}`);
              await page.click(submitSelector);
              submitButtonClicked = true;
              break;
            }
          }
        } catch (error) {
          continue;
        }
      }
      
      // Fallback: Press Enter if no submit button found
      if (!submitButtonClicked) {
        logger.warn('⚠️ Submit button not found, pressing Enter key');
        await page.keyboard.press('Enter');
      }
      
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

