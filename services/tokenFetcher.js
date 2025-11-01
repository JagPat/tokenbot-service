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
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait longer for dynamic content
      
      // Wait for TOTP input field to appear (it might be rendered dynamically)
      logger.info('⏳ Waiting for TOTP input field to appear...');
      let totpFieldAppeared = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between attempts
        
        const totpFieldExists = await page.evaluate(() => {
          // Check for TOTP field in multiple ways
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.some(inp => {
            const hasLength = inp.maxLength === 6 || inp.maxLength === 8;
            const hasPlaceholder = inp.placeholder && (
              inp.placeholder.toLowerCase().includes('totp') ||
              inp.placeholder.toLowerCase().includes('code') ||
              inp.placeholder.toLowerCase().includes('two-factor') ||
              inp.placeholder === '••••••'
            );
            const hasAutocomplete = inp.autocomplete === 'one-time-code';
            const isNotUserid = inp.id !== 'userid' && inp.name !== 'userid';
            const isNotPassword = inp.type !== 'password';
            const isVisible = inp.offsetParent !== null;
            
            return isVisible && isNotUserid && isNotPassword && 
                   (hasLength || hasPlaceholder || hasAutocomplete);
          });
        });
        
        if (totpFieldExists) {
          totpFieldAppeared = true;
          logger.info(`✅ TOTP field detected on attempt ${attempt + 1}`);
          break;
        }
      }
      
      if (!totpFieldAppeared) {
        logger.warn('⚠️ TOTP field not detected after waiting. Continuing to search...');
      }
      
      // Verify we're on the TOTP page by checking URL or page content
      const currentUrl = page.url();
      const hasTOTPIndicators = await page.evaluate(() => {
        const pageText = document.body.innerText || '';
        return pageText.includes('TOTP') || 
               pageText.includes('Two-factor') || 
               pageText.includes('2FA') ||
               pageText.includes('Enter code') ||
               pageText.includes('authentication code');
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
      
      // Check if we're on TOTP page first to determine selector strategy
      const isOnTOTPPage = await page.evaluate(() => {
        const pageText = document.body.innerText || '';
        return pageText.includes('TOTP') || 
               pageText.includes('Two-factor') || 
               pageText.includes('2FA') ||
               pageText.includes('Enter code') ||
               pageText.includes('authentication code');
      });
      
      // Try multiple selectors for TOTP field (Zerodha may use different selectors)
      // Based on logs: TOTP field appears as type=number, maxLength=6, placeholder="••••••"
      // CRITICAL: Zerodha reuses #userid for TOTP field on TOTP page!
      let totpSelectors;
      if (isOnTOTPPage) {
        // On TOTP page: #userid IS the TOTP field (confirmed from logs)
        totpSelectors = [
          '#userid',                           // Zerodha reuses userid ID for TOTP field! (HIGHEST PRIORITY)
          'input[placeholder*="••••••"]',       // Masked placeholder (from logs)
          'input[type="number"][maxlength="6"]', // Number type with 6 digits (from logs)
          'input[type="number"]',              // Any number type on TOTP page
          'input[autocomplete="one-time-code"]', // Standard TOTP autocomplete
          'input[placeholder*="TOTP"]',         // Placeholder-based (uppercase)
          'input[placeholder*="Enter TOTP"]',    // Common Zerodha placeholder
          'input[placeholder*="code"]',        // Generic code placeholder
          '#totp',                              // Original selector
          'input[name="totp"]',                 // Name-based selector
          '#totpcode'                           // Alternative ID
        ];
      } else {
        // On login page: use standard selectors (exclude #userid)
        totpSelectors = [
          'input[autocomplete="one-time-code"]', // Standard TOTP autocomplete
          'input[placeholder*="TOTP"]',          // Placeholder-based (uppercase)
          'input[placeholder*="Enter TOTP"]',    // Common Zerodha placeholder
          'input[placeholder*="code"]',          // Generic code placeholder
          '#totp',                               // Original selector
          'input[name="totp"]',                  // Name-based selector
          '#totpcode'                            // Alternative ID
        ];
      }
      
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
          
          // Verify the element is visible and enabled, and check if it's actually a TOTP field
          const fieldInfo = await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            if (!element) return null;
            
            // Check page context - are we on TOTP page?
            const pageText = document.body.innerText || '';
            const isTOTPPage = pageText.includes('TOTP') || 
                             pageText.includes('Two-factor') || 
                             pageText.includes('2FA') ||
                             pageText.includes('Enter code') ||
                             pageText.includes('authentication code');
            
            // On TOTP page, a field with maxLength=6 and placeholder="••••••" is the TOTP field
            // even if it has id="userid" (Zerodha might reuse the same ID)
            const matchesTOTPCriteria = (element.maxLength === 6 || element.maxLength === 8) &&
                                       (element.placeholder === '••••••' || 
                                        (element.placeholder && element.placeholder.toLowerCase().includes('totp')) ||
                                        element.autocomplete === 'one-time-code');
            
            return {
              exists: true,
              visible: element.offsetParent !== null,
              enabled: !element.disabled,
              hasSize: element.offsetWidth > 0 && element.offsetHeight > 0,
              isTOTPPage: isTOTPPage,
              matchesTOTPCriteria: matchesTOTPCriteria,
              // Accept if: (1) matches TOTP criteria, OR (2) on TOTP page and has masked placeholder
              acceptable: matchesTOTPCriteria || (isTOTPPage && element.placeholder === '••••••' && element.maxLength === 6)
            };
          }, selector);
          
          if (fieldInfo && fieldInfo.exists && fieldInfo.visible && fieldInfo.enabled && 
              fieldInfo.hasSize && fieldInfo.acceptable) {
            logger.info(`✅ TOTP field found with selector: ${selector} (on TOTP page: ${fieldInfo.isTOTPPage}, matches criteria: ${fieldInfo.matchesTOTPCriteria})`);
            usedSelector = selector;
            totpFieldFound = true;
            break;
          } else {
            // Reduced logging to avoid rate limits
            if (totpSelectors.indexOf(selector) < 5 && fieldInfo) {
              logger.warn(`⚠️ Field found but not acceptable: ${selector} (visible: ${fieldInfo.visible}, acceptable: ${fieldInfo.acceptable}, criteria: ${fieldInfo.matchesTOTPCriteria})`);
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
      
      // If still not found, try direct approach: find any input with masked placeholder on TOTP page
      if (!totpFieldFound) {
        logger.info('🔍 Trying direct field search by characteristics...');
        const directField = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const pageText = document.body.innerText || '';
          const isTOTPPage = pageText.includes('TOTP') || 
                           pageText.includes('Two-factor') || 
                           pageText.includes('2FA') ||
                           pageText.includes('Enter code');
          
          // Find input that matches TOTP characteristics
          for (const inp of inputs) {
            if (inp.offsetParent === null) continue; // Not visible
            if (inp.disabled) continue;
            if (inp.offsetWidth === 0 || inp.offsetHeight === 0) continue;
            
            // Check if it matches TOTP criteria
            const hasMaskedPlaceholder = inp.placeholder === '••••••';
            const hasCorrectLength = inp.maxLength === 6 || inp.maxLength === 8;
            const hasTOTPAutocomplete = inp.autocomplete === 'one-time-code';
            const isNumberType = inp.type === 'number';
            
            if (isTOTPPage && ((hasMaskedPlaceholder && hasCorrectLength) || hasTOTPAutocomplete || (hasMaskedPlaceholder && isNumberType))) {
              return {
                id: inp.id,
                name: inp.name,
                type: inp.type,
                maxLength: inp.maxLength,
                placeholder: inp.placeholder,
                autocomplete: inp.autocomplete,
                selector: inp.id ? `#${inp.id}` : inp.name ? `input[name="${inp.name}"]` : null
              };
            }
          }
          return null;
        });
        
        if (directField && directField.selector) {
          logger.info(`✅ TOTP field found via direct search: ${directField.selector}`);
          usedSelector = directField.selector;
          totpFieldFound = true;
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
          
          // Also log TOTP candidates - better filtering
          // Look for fields with: maxLength 6/8 AND visible AND (TOTP-related placeholder OR no placeholder)
          const totpCandidates = allInputs.filter(inp => {
            const hasTOTPLength = inp.maxLength === 6 || inp.maxLength === 8;
            const isVisible = inp.visible;
            const hasTOTPPlaceholder = inp.placeholder && (
              inp.placeholder.toLowerCase().includes('totp') ||
              inp.placeholder.toLowerCase().includes('two-factor') ||
              inp.placeholder.toLowerCase().includes('2fa') ||
              inp.placeholder.toLowerCase().includes('code') ||
              inp.placeholder === '••••••' // Might be masked TOTP
            );
            const isNotUserid = inp.id !== 'userid' && inp.name !== 'userid';
            const isNotPassword = inp.type !== 'password';
            
            return hasTOTPLength && isVisible && isNotUserid && isNotPassword && 
                   (hasTOTPPlaceholder || !inp.placeholder || inp.autocomplete === 'one-time-code');
          });
          
          if (totpCandidates.length > 0) {
            logger.error(`🎯 TOTP field candidates: ${JSON.stringify(totpCandidates.map(inp => ({
              id: inp.id,
              name: inp.name,
              type: inp.type,
              placeholder: inp.placeholder,
              maxLength: inp.maxLength,
              autocomplete: inp.autocomplete,
              selector: inp.id ? `#${inp.id}` : inp.name ? `input[name="${inp.name}"]` : null
            })))}`);
          } else {
            // Log all visible inputs with maxLength 6/8 for debugging
            const visibleInputs = allInputs.filter(inp => inp.visible);
            const length6or8 = allInputs.filter(inp => (inp.maxLength === 6 || inp.maxLength === 8));
            logger.error(`⚠️ No TOTP candidates found. Visible inputs: ${visibleInputs.length}, Length 6/8: ${length6or8.length}`);
            logger.error(`🔍 All visible inputs: ${JSON.stringify(visibleInputs.map(inp => ({
              id: inp.id,
              name: inp.name,
              type: inp.type,
              maxLength: inp.maxLength,
              placeholder: inp.placeholder
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
      
      // Wait for navigation with multiple strategies
      try {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
        ]);
      } catch (navError) {
        logger.warn('⚠️ Navigation timeout, checking current URL anyway');
      }
      
      // Wait a bit more for any client-side redirects
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const redirectUrl = page.url();
      logger.info(`🔗 Redirected to: ${redirectUrl}`);
      
      // Try to extract request_token from multiple locations
      let requestToken = null;
      
      try {
        // Try query parameter first (most common)
        const urlObj = new URL(redirectUrl);
        requestToken = urlObj.searchParams.get('request_token');
        
        // Try hash fragment if not in query params
        if (!requestToken && urlObj.hash) {
          const hashParams = new URLSearchParams(urlObj.hash.substring(1));
          requestToken = hashParams.get('request_token');
        }
        
        // Try parsing the entire URL/hash for request_token
        if (!requestToken) {
          const requestTokenMatch = redirectUrl.match(/request_token[=:]([^&?#\s]+)/i);
          if (requestTokenMatch) {
            requestToken = requestTokenMatch[1];
          }
        }
      } catch (urlError) {
        logger.error(`❌ Error parsing redirect URL: ${urlError.message}`);
      }
      
      if (!requestToken) {
        // Log full redirect URL for debugging
        logger.error(`❌ Request token not found in redirect URL: ${redirectUrl}`);
        logger.error(`🔍 URL breakdown - Protocol: ${redirectUrl.split('://')[0]}, Host: ${redirectUrl.split('/')[2]}, Path: ${redirectUrl.split('?')[0]}, Query: ${redirectUrl.split('?')[1] || 'none'}, Hash: ${redirectUrl.split('#')[1] || 'none'}`);
        
        // Check if we're still on the same page (maybe TOTP submission failed)
        const currentPageText = await page.evaluate(() => document.body.innerText || '');
        const stillOnTOTPPage = currentPageText.includes('TOTP') || 
                               currentPageText.includes('Two-factor') || 
                               currentPageText.includes('2FA');
        
        if (stillOnTOTPPage) {
          // Check for error messages
          const errorMessage = await page.evaluate(() => {
            const errorElements = document.querySelectorAll('.error, .alert, [class*="error"], [class*="alert"]');
            return Array.from(errorElements).map(el => el.textContent || el.innerText).join(' | ') || null;
          });
          
          if (errorMessage) {
            throw new Error(`TOTP submission failed: ${errorMessage}`);
          } else {
            throw new Error('TOTP submission may have failed - still on TOTP page and no request token found');
          }
        }
        
        throw new Error(`Request token not found in redirect URL. Full URL: ${redirectUrl}`);
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

