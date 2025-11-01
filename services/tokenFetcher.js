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
        headless: 'new', // Use new headless mode (recommended by Puppeteer)
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
      await page.type('#userid', kite_user_id, { delay: 50 });
      await page.type('#password', password, { delay: 50 });
      
      // Find and click submit button (try multiple selectors)
      const loginSubmitSelectors = [
        'button[type="submit"]',
        'button.submit',
        'button.login',
        'button[class*="submit"]',
        'button[class*="login"]',
        'form button[type="submit"]',
        'button'
      ];
      
      let submitClicked = false;
      for (const submitSelector of loginSubmitSelectors) {
        try {
          const submitButton = await page.$(submitSelector);
          if (submitButton) {
            const buttonVisible = await page.evaluate((sel) => {
              const btn = document.querySelector(sel);
              return btn && btn.offsetParent !== null;
            }, submitSelector);
            
            if (buttonVisible) {
              logger.info(`✅ Clicking login submit button: ${submitSelector}`);
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
                page.click(submitSelector)
              ]);
              submitClicked = true;
              break;
            }
          }
        } catch (error) {
          continue; // Try next selector
        }
      }
      
      if (!submitClicked) {
        throw new Error('Could not find or click login submit button');
      }
      
      // Wait for navigation and verify we're on TOTP page
      logger.info('⏳ Waiting for TOTP page to load...');
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for page to load
      
      // Verify we're on the TOTP page by checking URL or page content
      const currentUrl = page.url();
      const hasTOTPIndicators = await page.evaluate(() => {
        const pageText = document.body.innerText || '';
        return pageText.includes('TOTP') || 
               pageText.includes('Two-factor') || 
               pageText.includes('2FA') ||
               document.querySelector('input[maxlength="6"]') !== null ||
               document.querySelector('input[autocomplete="one-time-code"]') !== null;
      });
      
      if (!hasTOTPIndicators && !currentUrl.includes('totp') && !currentUrl.includes('twofactor')) {
        // Check for error messages
        const errorMessage = await page.evaluate(() => {
          const errorElements = document.querySelectorAll('.error, .alert, [class*="error"], [class*="alert"]');
          return Array.from(errorElements).map(el => el.textContent || el.innerText).join(' | ') || null;
        });
        
        if (errorMessage) {
          throw new Error(`Login failed: ${errorMessage}`);
        }
        
        logger.warn(`⚠️ Page may not have navigated to TOTP page. URL: ${currentUrl}`);
        // Continue anyway - might still be on TOTP page
      } else {
        logger.info('✅ TOTP page detected');
      }
      
      // Step 3: Handle TOTP
      logger.info('🔐 Generating and entering TOTP');
      
      // Generate TOTP code
      const totp = otplib.authenticator.generate(totp_secret);
      logger.info(`✅ TOTP generated: ${totp}`);
      
      // Log current page URL for debugging
      const totpPageUrl = page.url();
      logger.info(`🔗 Current page URL (TOTP page): ${totpPageUrl}`);
      
      // Try multiple selectors for TOTP field (Zerodha may use different selectors)
      // Priority order: Most common Zerodha selectors first
      const totpSelectors = [
        'input[autocomplete="one-time-code"]', // Standard TOTP autocomplete (most likely)
        '#totp',                               // Original selector
        'input[name="totp"]',                  // Name-based selector
        'input[id="totp"]',                    // Explicit ID selector
        '#totpcode',                           // Alternative ID
        'input[placeholder*="TOTP"]',           // Placeholder-based (uppercase)
        'input[placeholder*="Enter TOTP"]',      // Common Zerodha placeholder
        'input[placeholder*="TOTP code"]',     // Alternative placeholder
        'input[placeholder*="totp"]',           // Placeholder-based (lowercase)
        'input[placeholder*="Totp"]',           // Placeholder-based (mixed case)
        'input[type="text"][maxlength="6"]',  // TOTP is usually 6 digits
        'input[type="text"][maxlength="8"]',  // Some use 8 digits
        'input.totp',                         // Class-based
        '.totp-input',                        // Alternative class
        '[data-name="totp"]',                 // Data attribute selector
        'input[autocomplete="off"][type="text"]' // Some forms disable autocomplete
      ];
      
      let totpFieldFound = false;
      let usedSelector = null;
      
      // Try each selector with a shorter timeout per attempt
      for (const selector of totpSelectors) {
        try {
          // Reduced logging to avoid rate limits
          if (totpSelectors.indexOf(selector) < 5) {
            logger.info(`🔍 Trying TOTP selector: ${selector}`);
          }
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
            // Reduced logging to avoid rate limits
            if (totpSelectors.indexOf(selector) < 5) {
              logger.warn(`⚠️ TOTP field found but not visible with selector: ${selector}`);
            }
          }
        } catch (error) {
          // Reduced logging - only log first few attempts
          if (totpSelectors.indexOf(selector) < 3) {
            logger.debug(`Selector ${selector} not found, trying next...`);
          }
          continue;
        }
      }
      
      if (!totpFieldFound) {
        // Take screenshot for debugging (silent - don't log)
        try {
          await page.screenshot({ path: '/tmp/totp-page-screenshot.png', fullPage: true });
        } catch (screenshotError) {
          // Silent fail
        }
        
        // Try to find all input fields on the page (concise logging)
        try {
          const allInputs = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            return inputs.map(input => ({
              id: input.id || null,
              name: input.name || null,
              type: input.type || null,
              placeholder: input.placeholder || null,
              autocomplete: input.autocomplete || null,
              className: input.className || null,
              maxLength: input.maxLength || null,
              visible: input.offsetParent !== null
            }));
          });
          
          // Log in single compact line to avoid rate limits
          const inputsSummary = allInputs.map(inp => 
            `id:${inp.id||'null'},name:${inp.name||'null'},type:${inp.type},maxLength:${inp.maxLength||'null'},visible:${inp.visible},placeholder:${inp.placeholder||'null'}`
          ).join(' | ');
          
          logger.error(`📋 All input fields (${allInputs.length}): ${inputsSummary}`);
          
          // Also log TOTP candidates (fields with maxLength 6 or 8)
          const totpCandidates = allInputs.filter(inp => 
            (inp.maxLength === 6 || inp.maxLength === 8) && inp.visible
          );
          if (totpCandidates.length > 0) {
            logger.error(`🎯 TOTP field candidates: ${JSON.stringify(totpCandidates.map(inp => ({
              id: inp.id,
              name: inp.name,
              placeholder: inp.placeholder,
              selector: inp.id ? `#${inp.id}` : inp.name ? `input[name="${inp.name}"]` : null
            })))}`);
          }
        } catch (htmlError) {
          logger.warn('Failed to get page HTML:', htmlError.message);
        }
        
        throw new Error('TOTP input field not found. Zerodha login page structure may have changed. Please check the page and update selectors. Check screenshot and logs for page structure.');
      }
      
      // Type TOTP code into the field
      logger.info(`📝 Entering TOTP code into field: ${usedSelector}`);
      await page.type(usedSelector, totp, { delay: 100 }); // Add small delay for reliability
      
      // Find and click submit button (try multiple selectors)
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button.submit',
        'button.login',
        'button[class*="submit"]',
        'button[class*="login"]',
        'form button[type="button"]', // Some forms use button instead of submit
        'button' // Generic button as last resort
      ];
      
      let submitButtonClicked = false;
      for (const submitSelector of submitSelectors) {
        try {
          const submitButton = await page.$(submitSelector);
          if (submitButton) {
            const buttonInfo = await page.evaluate((sel) => {
              const btn = document.querySelector(sel);
              if (!btn) return null;
              
              return {
                visible: btn.offsetParent !== null,
                text: btn.textContent || btn.innerText || '',
                type: btn.type || '',
                hasLoginText: (btn.textContent || btn.innerText || '').toLowerCase().includes('login') ||
                             (btn.textContent || btn.innerText || '').toLowerCase().includes('submit')
              };
            }, submitSelector);
            
            if (buttonInfo && buttonInfo.visible && (buttonInfo.type === 'submit' || buttonInfo.hasLoginText || submitSelector.includes('submit'))) {
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
      const redirectUrl = page.url();
      logger.info(`🔗 Redirected to: ${redirectUrl}`);
      
      const requestToken = new URL(redirectUrl).searchParams.get('request_token');
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

