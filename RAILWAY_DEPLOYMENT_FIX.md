# Railway Deployment Issue - Dockerfile Cache

**Issue:** Railway is deploying from an OLD Dockerfile that includes `curl` in the main package list, causing build failures.

**Status:** ✅ **Dockerfile Fixed Locally** | ❌ **Railway Using Cached Build**

---

## 🔍 **Problem Analysis**

### **What's Happening:**
- ✅ Our local Dockerfile has the fixes (curl in separate RUN command)
- ✅ GitHub has the latest code (commits: `362737d`, `dcdd692`, `e39bc03`)
- ❌ Railway build logs show it's using the OLD Dockerfile format
- ❌ Build fails with `ERROR: curl-8.14.1-r2: IO ERROR`

### **Root Cause:**
Railway is likely using a **cached Docker build layer** from a previous deployment, so it's not pulling the latest Dockerfile.

---

## 🔧 **Solution**

### **Option 1: Force Railway to Rebuild (Recommended)**

1. **Trigger a new deployment manually:**
   - Go to Railway dashboard
   - Click on `tokenbot-service`
   - Click "Deploy" → "Redeploy"
   - Select "Clear Build Cache" or "Force Rebuild"

2. **OR Push a dummy commit to trigger rebuild:**
   ```bash
   git commit --allow-empty -m "trigger: force Railway rebuild"
   git push origin main
   ```

### **Option 2: Verify Railway Branch**

Make sure Railway is configured to deploy from the `main` branch:
1. Go to Railway dashboard
2. Check Settings → Build & Deploy
3. Verify it's using `main` branch

### **Option 3: Clear Railway Build Cache**

If Railway has a "Clear Cache" option:
1. Go to Railway dashboard
2. Settings → Build & Deploy
3. Clear build cache
4. Trigger new deployment

---

## 📋 **Verification Steps**

After redeploying, verify the build logs show:
```
# Install system dependencies with proper error handling and cleanup
# Split curl installation separately to handle network issues gracefully
RUN apk update && \
    apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Install curl separately with retry logic for network resilience
RUN apk add --no-cache curl || \
    (sleep 2 && apk update && apk add --no-cache curl) || \
    echo "Warning: curl installation failed, health check may not work"
```

**NOT** the old format:
```
RUN apk update && \
    apk add --no-cache \
    chromium \
    ...
    curl \  # ❌ This is in the wrong place
    && rm -rf /var/cache/apk/*
```

---

## ✅ **Expected Result**

After forcing a rebuild:
- ✅ Build succeeds even if curl installation has network issues
- ✅ Service deploys successfully
- ✅ Health check works using Node.js (no curl dependency)

---

## 📊 **Current Status**

| Component | Status | Notes |
|-----------|--------|-------|
| Local Dockerfile | ✅ Fixed | Has curl in separate RUN |
| GitHub Dockerfile | ✅ Fixed | Commits pushed: `362737d`, `dcdd692`, `e39bc03` |
| Railway Build | ❌ Cached | Still using old Dockerfile |

---

**Action Required:** Force Railway to rebuild by manually redeploying or pushing an empty commit.











