FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Switch to root to install dependencies/fix permissions if needed (though usually not needed)
USER root

# Skip chromium download (use image's bundled chrome)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

COPY package*.json ./
# Install app dependencies (use npm ci for reproducible builds)
RUN npm ci --omit=dev

COPY . .

# Create logs directory and fix permissions for pptruser (default user in this image)
RUN mkdir -p logs && chown -R pptruser:pptruser /app

# Switch back to the non-root user provided by the image
USER pptruser

EXPOSE 3000

# Health Check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "start"]
