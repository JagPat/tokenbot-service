# 🔧 TokenBot Railway Browser Launch Fix

**Date:** 2025-11-13  
**Status:** ✅ **FIX APPLIED**

---

## 🚨 **Problem**

TokenBot service fails to launch Puppeteer browser on Railway with error:
```
Failed to launch the browser process!
posix_spawn /usr/lib/chromium/chrome_crashpad_handler: Resource temporarily unavailable (11)
```

**Root Cause:**
- Railway free/hobby tier has limited resources (CPU, Memory, File Descriptors)
- Chromium crashpad handler requires additional process spawning
- Missing Chromium dependencies and permissions

---

## ✅ **Solution Applied**

### **1. Enhanced Puppeteer Launch Configuration**

**File:** `services/tokenFetcher.js`

**Changes:**
- Added aggressive resource-saving flags:
  - `--disable-breakpad` - Disables crashpad (prevents the error)
  - `--disable-crash-reporter` - Disables crash reporting
  - `--disable-features=VizDisplayCompositor` - Reduces compositor overhead
  - `--log-level=3` - Minimal logging
- Added environment variables:
  - `PUPPETEER_DISABLE_CRASHPAD=1` - Explicitly disables crashpad
  - `NODE_OPTIONS=--max-old-space-size=512` - Limits Node.js memory

### **2. Enhanced Dockerfile**

**File:** `Dockerfile`

**Changes:**
- Added missing Chromium dependencies:
  - `chromium-chromedriver`
  - `ttf-dejavu`, `ttf-liberation`, `font-noto` (fonts)
  - `libgcc`, `libstdc++` (runtime libraries)
- Added sandbox permissions:
  - `chmod 4755` for chromium sandbox files

---

## 🧪 **Testing**

After deploying this fix:

1. **Check Railway Logs:**
   ```bash
   railway logs --service tokenbot-service
   ```

2. **Expected Success Logs:**
   ```
   ✅ Browser launched successfully
   🚀 Starting token fetch for user: EBW183
   ✅ Token generation successful
   ```

3. **Expected No Errors:**
   - ❌ No "Resource temporarily unavailable" errors
   - ❌ No "Failed to launch the browser process" errors
   - ❌ No crashpad handler errors

---

## 📋 **Railway Resource Requirements**

**Minimum Requirements:**
- **Memory:** 512MB+ (recommended: 1GB)
- **CPU:** 0.5 vCPU+ (recommended: 1 vCPU)
- **File Descriptors:** 1024+ (Railway default should be sufficient)

**If Still Failing:**
1. Upgrade Railway plan (Pro plan has more resources)
2. Enable Railway "Metal" build environment (Beta)
3. Consider using external browser service (Browserless.io)

---

## 🔄 **Deployment Steps**

1. **Commit Changes:**
   ```bash
   cd tokenbot-service
   git add services/tokenFetcher.js Dockerfile
   git commit -m "fix: Railway browser launch - disable crashpad and add resource flags"
   git push origin main
   ```

2. **Railway Auto-Deploys:**
   - Railway will automatically detect the push
   - Build will start automatically
   - Monitor deployment logs

3. **Verify Fix:**
   - Check Railway logs for successful browser launch
   - Test token generation via API
   - Verify auto-reauthentication works

---

## 📝 **Related Files**

- `services/tokenFetcher.js` - Puppeteer launch configuration
- `Dockerfile` - Chromium dependencies and permissions
- `package.json` - Puppeteer version (should be >= 21.0.0)

---

## ✅ **Status**

- ✅ Puppeteer launch configuration updated
- ✅ Dockerfile enhanced with dependencies
- ✅ Resource-saving flags added
- ✅ Crashpad disabled (prevents the error)
- ⏳ **Awaiting deployment and testing**

---

**Next Steps:** Deploy to Railway and monitor logs for successful browser launches.






