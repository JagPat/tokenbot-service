const otplib = require('otplib');
const KiteConnect = require('kiteconnect').KiteConnect;
const logger = require('../utils/logger');
const browserPool = require('./browserPool');

class TokenFetcher {
  async fetchAccessToken({ kite_user_id, password, totp_secret, api_key, api_secret }) {
    const startTime = Date.now();
    let browserInfo = null;
    let browser = null;
    let page = null;

    try {
      logger.info(`🚀 Starting token fetch for user: ${kite_user_id}`);

      // 🔥 BROWSER POOL: Acquire browser from pool instead of launching new instance
      try {
        browserInfo = await browserPool.acquire();
        browser = browserInfo.browser;
        logger.info(`✅ Browser acquired from pool: ${browserInfo.id}`);
      } catch (poolError) {
        logger.error(`❌ Failed to acquire browser from pool: ${poolError.message}`);
        throw new Error(`Browser unavailable: ${poolError.message}`);
      }

      // Verify browser is connected
      if (!browser || !browser.isConnected()) {
        throw new Error('Browser is not connected');
      }

      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // CRITICAL: Set up response and request interceptors EARLY to capture callback URL
      // Must be set up BEFORE any navigation starts
      let interceptedRequestToken = null;
      let interceptedCallbackUrl = null;

      // Enable request interception to stop the backend from consuming the token
      await page.setRequestInterception(true);

      // Intercept requests to catch redirect to callback URL (BEFORE backend processes it)
      page.on('request', (request) => {
        const requestUrl = request.url();

        // Check for callback URL
        if (requestUrl.includes('/api/modules/auth/broker/callback') && requestUrl.includes('request_token')) {
          logger.info(`🎯 Intercepted callback REQUEST: ${requestUrl}`);

          // Extract request_token from request URL
          try {
            const urlObj = new URL(requestUrl);
            let token = urlObj.searchParams.get('request_token');

            if (!token && urlObj.hash) {
              const hashParams = new URLSearchParams(urlObj.hash.substring(1));
              token = hashParams.get('request_token');
            }

            if (!token) {
              const tokenMatch = requestUrl.match(/request_token[=:]([^&?#\s]+)/i);
              if (tokenMatch) {
                token = tokenMatch[1];
              }
            }

            if (token) {
              interceptedRequestToken = token;
              interceptedCallbackUrl = requestUrl;
              logger.info(`✅✅✅ Request token EXTRACTED from REQUEST: ${token.substring(0, 10)}...`);

              // CRITICAL: Abort the request so the backend (Chanakya Web) doesn't receive/consume the token!
              logger.info(`🛑 ABORTING callback request to prevent backend consumption.`);
              request.abort('blockedbyclient');
              return;
            }
          } catch (urlError) {
            logger.warn(`⚠️ Error parsing intercepted request URL: ${urlError.message}`);
          }
        }

        // Continue all other requests (or if extraction failed)
        // Safe check to ensure we don't crash if request is already handled
        if (!request.isInterceptResolutionHandled()) {
          request.continue();
        }
      });

      // Intercept responses to catch callback URL (captures both GET redirects and POST responses)
      page.on('response', async (response) => {
        const responseUrl = response.url();
        const status = response.status();

        // Check if this is the callback URL (even without request_token in URL - might be in response body)
        if (responseUrl.includes('/api/modules/auth/broker/callback')) {
          logger.info(`🎯 Intercepted callback RESPONSE: ${responseUrl} (Status: ${status})`);

          // Extract request_token from response URL
          try {
            const urlObj = new URL(responseUrl);
            let token = urlObj.searchParams.get('request_token');

            if (!token && urlObj.hash) {
              const hashParams = new URLSearchParams(urlObj.hash.substring(1));
              token = hashParams.get('request_token');
            }

            if (!token) {
              const tokenMatch = responseUrl.match(/request_token[=:]([^&?#\s]+)/i);
              if (tokenMatch) {
                token = tokenMatch[1];
              }
            }

            // If not in URL, try response body (for POST requests)
            if (!token && status === 200) {
              try {
                const responseBody = await response.text();
                const bodyTokenMatch = responseBody.match(/request_token["']?\s*[=:]\s*["']?([^"'\s&]+)/i);
                if (bodyTokenMatch) {
                  token = bodyTokenMatch[1];
                  logger.info(`✅ Found request_token in response body`);
                }
              } catch (bodyError) {
                // Ignore - response might not be text
              }
            }

            if (token && !interceptedRequestToken) {
              interceptedRequestToken = token;
              interceptedCallbackUrl = responseUrl;
              logger.info(`✅✅✅ Request token EXTRACTED from RESPONSE: ${token.substring(0, 10)}...`);
            }
          } catch (urlError) {
            logger.warn(`⚠️ Error parsing intercepted response URL: ${urlError.message}`);
          }
        } else if (responseUrl.includes('request_token')) {
          // Also catch any URL with request_token (even if not callback path)
          logger.info(`🎯 Intercepted URL with request_token: ${responseUrl}`);

          try {
            const urlObj = new URL(responseUrl);
            let token = urlObj.searchParams.get('request_token');

            if (!token && urlObj.hash) {
              const hashParams = new URLSearchParams(urlObj.hash.substring(1));
              token = hashParams.get('request_token');
            }

            if (!token) {
              const tokenMatch = responseUrl.match(/request_token[=:]([^&?#\s]+)/i);
              if (tokenMatch) {
                token = tokenMatch[1];
              }
            }

            if (token && !interceptedRequestToken) {
              interceptedRequestToken = token;
              interceptedCallbackUrl = responseUrl;
              logger.info(`✅✅✅ Request token EXTRACTED from URL: ${token.substring(0, 10)}...`);
            }
          } catch (urlError) {
            logger.warn(`⚠️ Error parsing intercepted URL: ${urlError.message}`);
          }
        }
      });

      // Step 1: Navigate to Kite OAuth login (not regular login page!)
      // CRITICAL: Use OAuth login URL to get request_token in callback URL
      // Regular login redirects to dashboard, but OAuth login redirects to callback URL with request_token
      // IMPORTANT: The redirect URI must match EXACTLY what's configured in Zerodha developer console
      const redirectUri = process.env.ZERODHA_REDIRECT_URL ||
        'https://quantumtrade-backend.up.railway.app/api/modules/auth/broker/callback';

      // Generate OAuth login URL with API key (v=3 is the API version)
      // NOTE: Zerodha uses the redirect_uri configured in developer console, not passed in URL
      // But we can still use the OAuth login endpoint to trigger the OAuth flow
      const sanitizedApiKey = (api_key || '').trim();
      if (!sanitizedApiKey) {
        throw new Error('Broker configuration is missing the Zerodha API key.');
      }
      if (sanitizedApiKey !== api_key) {
        logger.warn(`⚠️ API key contained whitespace; sanitized before use (original length ${api_key.length}, sanitized length ${sanitizedApiKey.length})`);
      }

      const oauthLoginUrl = `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(sanitizedApiKey)}&v=3`;
      logger.info(`📄 Navigating to Kite OAuth login: ${oauthLoginUrl}`);
      logger.info(`📋 Expected redirect URI: ${redirectUri}`);
      logger.info(`⚠️ NOTE: Redirect URI must be configured in Zerodha developer console to match: ${redirectUri}`);

      const loginResponse = await page.goto(oauthLoginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      // Detect API errors returned as JSON (e.g., invalid api_key)
      if (loginResponse) {
        try {
          const headers = loginResponse.headers();
          const contentType = headers?.['content-type'] || headers?.['Content-Type'] || '';
          if (contentType.includes('application/json')) {
            const bodyText = await loginResponse.text();
            if (bodyText && bodyText.includes('Invalid `api_key`')) {
              logger.error(`[ZerodhaOAuth] Login endpoint returned Invalid api_key JSON. Snippet: ${bodyText.slice(0, 200)}`);
              throw new Error('Zerodha rejected the provided API key while loading the OAuth login page. Please verify the API key in the broker configuration.');
            }
          }
        } catch (responseError) {
          logger.warn(`⚠️ Unable to inspect Zerodha login response: ${responseError.message}`);
        }
      }

      // Step 2: Enter user ID and password
      logger.info('🔑 Entering credentials');
      const loginUserSelectors = [
        '#userid',
        'input[name="user_id"]',
        'input[name="userid"]',
        'input[name="userId"]',
        'input[id*="user"][type="text"]',
        'input[placeholder*="User ID"]',
        'input[placeholder*="user"]',
        'input[aria-label*="User"]',
        'input[data-testid*="user"]',
        'input[type="text"]', // Fallback: any text input
        'input:not([type])'   // Fallback: input with no type (defaults to text)
      ];

      let loginUserSelector = null;
      let hiddenUserCandidate = null;

      for (const selector of loginUserSelectors) {
        try {
          // Reduced timeout for faster iteration on invalid selectors
          // NOTE: waitForSelector checks for presence (in DOM), not visibility, unless {visible: true} is set
          await page.waitForSelector(selector, { timeout: 2000 });
          const fieldInfo = await page.evaluate(sel => {
            const element = document.querySelector(sel);
            if (!element) return null;
            return {
              visible: element.offsetParent !== null,
              enabled: !element.disabled,
              tagName: element.tagName,
              type: element.type || 'text',
              id: element.id,
              placeholder: element.placeholder
            };
          }, selector);

          if (fieldInfo) {
            // Valid structural match (in DOM and enabled, not password/hidden type)
            if (fieldInfo.enabled && fieldInfo.type !== 'password' && fieldInfo.type !== 'hidden') {
              if (fieldInfo.visible) {
                // Perfect match: Visible
                loginUserSelector = selector;
                logger.info(`✅ Using visible login selector: ${selector}`);
                break;
              } else {
                // Possible match: Hidden (maybe pre-filled)
                // Prioritize #userid as it is the standard ID
                if (!hiddenUserCandidate || selector === '#userid') {
                  hiddenUserCandidate = selector;
                  logger.info(`⚠️ Found hidden candidate selector: ${selector}`);
                }
              }
            }
          }
        } catch (selectorError) {
          continue;
        }
      }

      // If no visible selector found, but we have a hidden one, use it
      if (!loginUserSelector && hiddenUserCandidate) {
        loginUserSelector = hiddenUserCandidate;
        logger.info(`⚠️ No visible input found. Using hidden candidate: ${loginUserSelector}`);
      }

      let userFieldVisible = false;

      // Check if User ID field is found but hidden (Pre-filled session)
      if (loginUserSelector) {
        userFieldVisible = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && el.offsetParent !== null;
        }, loginUserSelector);

        if (!userFieldVisible) {
          logger.info(`⚠️ User ID field found but HIDDEN. Checking for 'Change user' link...`);

          // Look for "Change user" link/button
          const changeUserSelectors = [
            'a.remove',
            'a.change-user',
            'button.change-user',
            'a[href="#"][class*="remove"]',
            'div.user-id span.remove' // Sometimes inside a container
          ];

          for (const linkSelector of changeUserSelectors) {
            const linkExists = await page.$(linkSelector);
            if (linkExists) {
              logger.info(`✅ Found 'Change user' link: ${linkSelector}. Clicking it to reveal User ID field...`);
              await page.click(linkSelector);
              // Wait for User ID input to become visible
              try {
                await page.waitForSelector(loginUserSelector, { visible: true, timeout: 5000 });
                userFieldVisible = true;
                logger.info('✅ User ID field is now VISIBLE.');
              } catch (e) {
                logger.warn('⚠️ User ID field did not become visible after clicking link.');
              }
              break;
            }
          }
        }
      }

      if (!loginUserSelector) {
        // ... (Existing error handling for no selector found)
        const loginPageContent = await page.content();
        // ...
        throw new Error('User ID input field not found on Zerodha login page...');
      }

      // Final check for visibility before typing
      if (!userFieldVisible) {
        // Re-check visibility one last time
        userFieldVisible = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && el.offsetParent !== null;
        }, loginUserSelector);
      }

      if (!userFieldVisible) {
        // If still not visible, we can try typing anyway (might work if it's just opacity 0 but interactive) 
        // OR throw specific error. Let's try typing but log warning.
        logger.warn(`⚠️ User ID field ${loginUserSelector} might still be hidden. Attempting to type anyway...`);
      }

      await page.type(loginUserSelector, kite_user_id, { delay: 50 });
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
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
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
      const preTotpUrl = page.url();
      const hasTOTPIndicators = await page.evaluate(() => {
        const pageText = document.body.innerText || '';
        return pageText.includes('TOTP') ||
          pageText.includes('Two-factor') ||
          pageText.includes('2FA') ||
          pageText.includes('Enter code') ||
          pageText.includes('authentication code');
      });

      if (!hasTOTPIndicators && !preTotpUrl.includes('totp') && !preTotpUrl.includes('twofactor')) {
        // Check for error messages
        const errorMessage = await page.evaluate(() => {
          const errorElements = document.querySelectorAll('.error, .alert, [class*="error"], [class*="alert"]');
          return Array.from(errorElements).map(el => el.textContent || el.innerText).join(' | ') || null;
        });

        if (errorMessage) {
          throw new Error(`Login failed: ${errorMessage}`);
        }

        logger.warn(`⚠️ Page may not have navigated to TOTP page. URL: ${preTotpUrl}`);
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
          'input[type="number"]',              // Common for TOTP
          'input[placeholder*="••••••"]',       // Masked placeholder (from logs)
          'input[type="number"][maxlength="6"]', // Number type with 6 digits (from logs)
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
          'input[type="number"]',                // Common for TOTP
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
            `id:${inp.id || 'null'},name:${inp.name || 'null'},type:${inp.type},maxLength:${inp.maxLength || 'null'},visible:${inp.visible},placeholder:${inp.placeholder || 'null'}`
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
      // CRITICAL: Interceptors are already set up above (before navigation)
      // They should have captured request_token from the callback URL
      logger.info('⏳ Waiting for authentication redirect');

      let redirectUrl = null;
      let requestToken = null;

      // Wait a moment for interceptors to capture the redirect
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if we already intercepted the request_token (before waiting for navigation)
      if (interceptedRequestToken && interceptedCallbackUrl) {
        requestToken = interceptedRequestToken;
        redirectUrl = interceptedCallbackUrl;
        logger.info(`✅✅✅ Using pre-intercepted request token: ${requestToken.substring(0, 10)}...`);
        logger.info(`✅✅✅ Pre-intercepted callback URL: ${redirectUrl}`);
        // Skip navigation wait - we already have the token!
      } else {
        // If not intercepted yet, wait for navigation
        try {
          // Wait for navigation event (redirect happens after TOTP submission)
          const navigationPromise = page.waitForNavigation({
            waitUntil: 'networkidle2',
            timeout: 30000
          });

          await navigationPromise;

          // Check interceptors again after navigation
          if (interceptedRequestToken && interceptedCallbackUrl && !requestToken) {
            requestToken = interceptedRequestToken;
            redirectUrl = interceptedCallbackUrl;
            logger.info(`✅✅✅ Request token intercepted after navigation: ${requestToken.substring(0, 10)}...`);
          } else {
            const currentUrl = page.url();
            logger.info(`🔗 Navigation completed, current URL: ${currentUrl}`);

            // Check current URL for request_token (might be in URL)
            redirectUrl = currentUrl;
            logger.info(`🔗 Checking current URL for request_token: ${redirectUrl}`);
          }

          // Wait a bit more in case there's another redirect
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Check interceptors again after waiting
          if (interceptedRequestToken && interceptedCallbackUrl && !requestToken) {
            requestToken = interceptedRequestToken;
            redirectUrl = interceptedCallbackUrl;
            logger.info(`✅✅✅ Request token intercepted after delay: ${requestToken.substring(0, 10)}...`);
          } else {
            const finalUrl = page.url();
            if (finalUrl !== redirectUrl && !requestToken) {
              logger.info(`🔗 Final redirect URL: ${finalUrl} (was: ${redirectUrl})`);
              redirectUrl = finalUrl;
            }
          }
        } catch (navError) {
          logger.warn(`⚠️ Navigation timeout (${navError.message}), checking current URL anyway`);

          // Check interceptors one more time
          if (interceptedRequestToken && interceptedCallbackUrl && !requestToken) {
            requestToken = interceptedRequestToken;
            redirectUrl = interceptedCallbackUrl;
            logger.info(`✅✅✅ Request token intercepted after timeout: ${requestToken.substring(0, 10)}...`);
          } else {
            if (!redirectUrl) {
              redirectUrl = page.url();
              logger.info(`🔗 Current URL (after timeout): ${redirectUrl}`);
            }

            // Wait a bit more for any delayed redirects
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Final check of interceptors
            if (interceptedRequestToken && interceptedCallbackUrl && !requestToken) {
              requestToken = interceptedRequestToken;
              redirectUrl = interceptedCallbackUrl;
              logger.info(`✅✅✅ Request token intercepted on final check: ${requestToken.substring(0, 10)}...`);
            } else if (!requestToken) {
              const delayedUrl = page.url();
              if (delayedUrl !== redirectUrl) {
                logger.info(`🔗 Delayed redirect detected: ${delayedUrl} (was: ${redirectUrl})`);
                redirectUrl = delayedUrl;
              }
            }
          }
        }
      }

      logger.info(`🔗 Final redirect URL: ${redirectUrl}`);

      // Try to extract request_token from multiple locations (if not already extracted from interceptor)
      // NOTE: requestToken variable is already declared above in the interceptor section
      if (!requestToken && redirectUrl) {
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

      // Close page but keep browser in pool
      await page.close();
      page = null;

      // Step 5: Generate session using KiteConnect
      logger.info('🔄 Generating session with KiteConnect API');
      const kite = new KiteConnect({ api_key });
      const session = await kite.generateSession(requestToken, api_secret);

      const executionTime = Date.now() - startTime;
      logger.info(`✅ Token generation successful in ${executionTime}ms`);

      // Release browser back to pool before returning
      if (browserInfo) {
        browserPool.release(browserInfo.id, browserInfo.requestId);
        logger.info(`🔄 Released browser ${browserInfo.id} back to pool`);
      }

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

      // Cleanup: close page if it exists
      if (page) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/972a6f96-8864-4e45-bf86-06098cc161d4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'tokenFetcher.js:930', message: 'BEFORE page.close() in error handler', data: { pageExists: !!page }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'I' }) }).catch(() => { });
        // #endregion
        try {
          await page.close();
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/972a6f96-8864-4e45-bf86-06098cc161d4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'tokenFetcher.js:933', message: 'AFTER page.close() in error handler - SUCCESS', data: {}, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'I' }) }).catch(() => { });
          // #endregion
        } catch (closeError) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/972a6f96-8864-4e45-bf86-06098cc161d4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'tokenFetcher.js:934', message: 'page.close() FAILED in error handler', data: { error: closeError.message }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'I' }) }).catch(() => { });
          // #endregion
          logger.warn(`Failed to close page: ${closeError.message}`);
        }
      }

      // 🔥 BROWSER POOL: Release browser back to pool (don't close it)
      if (browserInfo) {
        try {
          // Fix: Must pass requestId to release browser
          browserPool.release(browserInfo.id, browserInfo.requestId);
          logger.info(`🔄 Released browser ${browserInfo.id} back to pool`);
        } catch (releaseError) {
          logger.warn(`Failed to release browser: ${releaseError.message}`);
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

