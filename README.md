# TokenBot Service

Autonomous Kite (Zerodha) token generation microservice for QuantumLeap Trading platform.

## Features

- 🤖 **Autonomous Token Generation**: Automatically logs in to Kite daily at 8:00 AM IST
- 🔐 **Secure Credential Storage**: AES-256 encryption for all sensitive data
- 🔄 **Retry Logic**: Exponential backoff with 3 attempts
- 📊 **Comprehensive Logging**: Track all token generation attempts
- ⏰ **Scheduled Refresh**: Daily cron job for multi-user token refresh
- 🔌 **Service Integration**: API endpoints for AI trading backend

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL
- **Automation**: Puppeteer + TOTP (otplib)
- **Encryption**: AES-256-CBC
- **Scheduler**: node-cron
- **Logging**: Winston

## Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Generate encryption key
openssl rand -hex 32

# Run database migrations (on main backend)
# Migration 013 will create the required tables
```

## Environment Variables

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname
ENCRYPTION_KEY=<64-char-hex-string>
JWT_SECRET=<your-jwt-secret>
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
TOKENBOT_API_KEY=<internal-api-key>
```

## API Endpoints

### Health Check
- `GET /health` - Basic health check
- `GET /health/detailed` - Detailed stats

### Credentials Management
- `POST /api/credentials` - Save/update credentials
- `GET /api/credentials/status` - Get credential status
- `DELETE /api/credentials` - Delete credentials
- `PATCH /api/credentials/toggle` - Toggle auto-refresh

### Token Management
- `POST /api/tokens/refresh` - Manual token refresh
- `GET /api/tokens/status` - Get token status
- `GET /api/tokens/:userId` - Get token (service-to-service)
- `GET /api/tokens/logs/:userId` - Get generation logs

## Authentication

### User Endpoints
Require JWT token in Authorization header:
```
Authorization: Bearer <jwt-token>
```

### Service Endpoints
Require API key:
```
X-API-Key: <tokenbot-api-key>
```

## Usage

### Start Server
```bash
# Development
npm run dev

# Production
npm start
```

### Test Token Generation
```bash
curl -X POST http://localhost:3000/api/tokens/refresh \
  -H "Authorization: Bearer <jwt-token>"
```

## Deployment

### Railway

1. Create new Railway service
2. Connect to GitHub repository
3. Set environment variables
4. Deploy

Railway will automatically:
- Detect `railway.toml` configuration
- Build using Dockerfile
- Start the service
- Run health checks

### Docker

```bash
# Build image
docker build -t tokenbot-service .

# Run container
docker run -d \
  -p 3000:3000 \
  --env-file .env \
  tokenbot-service
```

## Scheduler

Token refresh runs daily at **8:00 AM IST** (2:30 AM UTC).

Cron expression: `30 2 * * *`

## Security

- ✅ All credentials encrypted at rest (AES-256)
- ✅ JWT authentication for user endpoints
- ✅ API key authentication for service endpoints
- ✅ Helmet.js security headers
- ✅ CORS configuration
- ✅ Audit logging

## Integration with AI Trading Backend

The AI trading backend can fetch tokens using:

```javascript
const response = await fetch('https://tokenbot-service.railway.app/api/tokens/USER_ID', {
  headers: {
    'X-API-Key': process.env.TOKENBOT_API_KEY
  }
});

const { access_token } = await response.json();
```

## Monitoring

### Logs
- Location: `logs/`
- `combined.log` - All logs
- `error.log` - Errors only

### Metrics
Check `/health/detailed` for:
- Total users
- Active tokens
- Success rate
- Average execution time

## Troubleshooting

### Token Generation Fails
1. Check credentials are correct
2. Verify TOTP secret is valid
3. Check Kite API status
4. Review logs in `logs/error.log`

### Database Connection Issues
1. Verify `DATABASE_URL`
2. Check database is running
3. Ensure migration 013 is applied

### Scheduler Not Running
1. Check server logs
2. Verify cron expression
3. Ensure timezone is correct (Asia/Kolkata)

## License

MIT

## Support

For issues or questions, contact QuantumLeap Trading support.

