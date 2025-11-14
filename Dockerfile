FROM node:18-alpine

# Install system dependencies with proper error handling and cleanup
# CRITICAL: Install Chromium and all required dependencies for Railway
RUN apk update && \
    apk add --no-cache \
    chromium \
    chromium-chromedriver \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ttf-dejavu \
    ttf-liberation \
    font-noto \
    libgcc \
    libstdc++ \
    && rm -rf /var/cache/apk/*

# CRITICAL: Set proper permissions for Chromium sandbox (prevents crashpad errors)
# Also create dummy crashpad handler to prevent "No such file or directory" errors
RUN chmod 4755 /usr/lib/chromium/chrome-sandbox || true && \
    chmod 4755 /usr/lib/chromium/chromium-sandbox || true && \
    # CRITICAL: Create dummy crashpad handler BEFORE removing original (if it exists)
    # Chromium requires this file to exist, so we create a no-op script
    mkdir -p /usr/lib/chromium && \
    echo '#!/bin/sh' > /usr/lib/chromium/chrome_crashpad_handler && \
    echo 'exit 0' >> /usr/lib/chromium/chrome_crashpad_handler && \
    chmod 755 /usr/lib/chromium/chrome_crashpad_handler && \
    # Also create chromium_crashpad_handler as fallback
    cp /usr/lib/chromium/chrome_crashpad_handler /usr/lib/chromium/chromium_crashpad_handler 2>/dev/null || true

# Install curl separately with retry logic for network resilience
RUN apk add --no-cache curl || \
    (sleep 2 && apk update && apk add --no-cache curl) || \
    echo "Warning: curl installation failed, health check may not work"

# Tell Puppeteer to skip downloading Chrome and use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROME_BIN=/usr/bin/chromium-browser

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S tokenbot -u 1001

# Create logs directory and set permissions
RUN mkdir -p logs && chmod 755 logs && \
    chown -R tokenbot:nodejs /app

# Switch to non-root user
USER tokenbot

# Expose port
EXPOSE 3000

# Health check using Node.js (always available, no dependency on curl)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start application
CMD ["npm", "start"]

