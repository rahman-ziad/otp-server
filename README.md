# otp-server

OTP server for sportsstation with integrated health monitoring and reporting system.

## Features

- **OTP Management**: Send and verify OTPs via SMS
- **JWT Authentication**: Token-based authentication with refresh tokens
- **Challonge Integration**: Tournament data proxy endpoints
- **Health Monitoring**: Comprehensive health monitoring and reporting system

## Health Monitoring System

The server includes an automated health monitoring and reporting system that provides:

### Scheduled Reports
- **Hourly Health Reports**: Automatically sent to Discord every hour with:
  - Server uptime and status
  - Request metrics (total requests, requests per hour)
  - Top endpoints and request sources
  - SMS service status and statistics
  - Firebase connection status
  - Outgoing IP address
  - Recent errors

- **Daily Log Cleanup**: Automatically purges old health logs from Firestore (configurable retention period)

### Critical Error Alerts
When critical errors occur (SMS failures, API outages, service errors), the system:
- Immediately sends a Discord webhook notification with error details
- Sends an SMS alert to the configured admin phone number
- Logs the error to Firestore for historical analysis

### On-Demand Reports
- **Endpoint**: `POST /api/report-now`
- **Authorization**: Requires `X-API-Key` header or `apiKey` query parameter
- Generates and sends an instant health report to Discord

### Monitored Metrics
- Request count and distribution by endpoint
- Error tracking and categorization
- SMS sending success/failure rates
- Service health status (Firebase, SMS API)
- Response times and performance metrics

## Environment Variables

Copy `.env.example` to `.env` and configure the following variables:

### Required
- `FIREBASE_CREDENTIALS`: Firebase service account credentials (JSON)
- `SMS_USERNAME`: MiMSMS API username
- `SMS_API_KEY`: MiMSMS API key
- `SMS_SENDER_NAME`: SMS sender ID
- `JWT_SECRET`: Secret key for JWT tokens
- `REFRESH_TOKEN_SECRET`: Secret key for refresh tokens

### Health Monitoring
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for health reports (required for monitoring)
- `ADMIN_PHONE`: Phone number to receive critical error SMS alerts
- `LOG_RETENTION_DAYS`: Number of days to retain health logs (default: 7)
- `HEALTH_API_KEY`: API key to authorize `/api/report-now` endpoint

### Optional
- `CHALLONGE_API_KEY`: Challonge API key for tournament endpoints
- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment mode (development/production)
- `CORS_ORIGIN`: Allowed CORS origins (default: *)

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

## API Endpoints

### Authentication & OTP
- `POST /api/send-otp` - Send OTP to phone number
- `POST /api/retry-otp` - Retry sending OTP
- `POST /api/verify-otp` - Verify OTP and get JWT tokens
- `POST /api/refresh-token` - Refresh JWT token
- `POST /api/logout` - Logout user

### SMS
- `POST /api/send-sms` - Send general SMS

### Tournament (Challonge)
- `GET /api/tournaments/:slug.json` - Get tournament details
- `GET /api/tournaments/:slug/participants.json` - Get tournament participants
- `GET /api/tournaments/:slug/matches.json` - Get tournament matches

### Health & Monitoring
- `GET /health` - Basic health check with current metrics
- `POST /api/report-now` - Trigger instant health report (requires API key)

## Health Report Authorization

To trigger an on-demand health report, include the API key in your request:

**Using Header:**
```bash
curl -X POST http://your-server/api/report-now \
  -H "X-API-Key: your_secure_api_key"
```

**Using Query Parameter:**
```bash
curl -X POST "http://your-server/api/report-now?apiKey=your_secure_api_key"
```

## Firestore Collections

- `otps`: OTP storage with expiry
- `players`: User profiles
- `refreshTokens`: JWT refresh tokens
- `health_logs`: Health monitoring logs and reports

## Scheduled Tasks

- **Hourly (at :00)**: Send health report to Discord
- **Daily (2:00 AM)**: Purge old health logs from Firestore

## Security Considerations

- Keep `.env` file secure and never commit it to version control
- Use strong, unique values for `JWT_SECRET` and `REFRESH_TOKEN_SECRET`
- Protect `HEALTH_API_KEY` and only share with authorized services
- Monitor Discord alerts for security-related errors
- Regularly review health logs for suspicious activity