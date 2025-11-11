const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const healthMonitor = require('./healthMonitor');
const requestTracker = require('./middleware/requestTracker');
const { requireAuth } = require('./middleware/auth');
const app = express();

// Enable CORS for all origins (adjust for production)
app.use(cors({
  origin: '*', // Replace with your Flutter app's domain in production
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json());

// Enable request tracking middleware
app.use(requestTracker);

// Initialize Firebase Admin SDK
try {
  const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });
  console.log('Firebase initialized successfully');
} catch (error) {
  console.error('Error initializing Firebase:', error.message, error.stack);
  healthMonitor.sendCriticalAlert('firebase_initialization_error', error);
  process.exit(1);
}

// MiMSMS configuration
const SMS_API_URL = 'https://api.mimsms.com/api/SmsSending/SMS';
const SMS_USERNAME = process.env.SMS_USERNAME || 'fahimmaruf@gmail.com';
const SMS_API_KEY = process.env.SMS_API_KEY || 'VAUSWN3QKZ7FQ0H';
const SMS_SENDER_NAME = process.env.SMS_SENDER_NAME || '8809601003504';
const SMS_TRANSACTION_TYPE = 'T'; // Transactional SMS

// Challonge API configuration
const CHALLONGE_API_KEY = process.env.CHALLONGE_API_KEY || 'your_challonge_api_key';
const CHALLONGE_BASE_URL = 'https://api.challonge.com/v1';

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your_refresh_token_secret_key';

// Firestore collection
const db = admin.firestore();
const otpCollection = db.collection('otps');

// Initialize health monitor with Firestore
healthMonitor.initialize(db);

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Validate phone number format
function validatePhoneNumber(phoneNumber) {
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phoneNumber);
}

// Normalize phone number (remove + prefix if present)
function normalizePhoneNumber(phoneNumber) {
  return phoneNumber.startsWith('+') ? phoneNumber.substring(1) : phoneNumber;
}

// Function to get and log outgoing IP
async function logOutgoingIP(requestType) {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    console.log(`[${new Date().toISOString()}] [${requestType}] Outgoing IP: ${data.ip}`);
    return data.ip;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestType}] Error getting outgoing IP:`, error.message);
    return 'unknown';
  }
}

// Send OTP endpoint with improved error handling
app.post('/api/send-otp', async (req, res) => {
  console.log('Request body:', req.body);
  
  // Log outgoing IP before making SMS request
  await logOutgoingIP('SEND_OTP');

  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required' });
  }

  if (!validatePhoneNumber(phoneNumber)) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
  const otp = generateOTP();
  const sessionId = uuidv4();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5-minute expiry

  try {
    // Store OTP in Firestore first
    await otpCollection.doc(sessionId).set({
      phoneNumber,
      otp,
      expiresAt,
      createdAt: Date.now(),
      smsSent: false,
    });

    // Send SMS with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

    try {
      const response = await fetch(SMS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          UserName: SMS_USERNAME,
          Apikey: SMS_API_KEY,
          MobileNumber: normalizedPhoneNumber,
          CampaignId: 'null',
          SenderName: SMS_SENDER_NAME,
          TransactionType: SMS_TRANSACTION_TYPE,
          Message: `Welcome to sportsstation. Your OTP is ${otp}`,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const result = await response.json();
      console.log('Send OTP - MiMSMS Response:', JSON.stringify(result, null, 2));

      // Check if SMS was sent successfully
      if (response.ok && result.statusCode === '200') {
        // Update Firestore to mark SMS as sent
        await otpCollection.doc(sessionId).update({
          smsSent: true,
          smsResponse: result,
        });

        // Track SMS success
        healthMonitor.trackSMS(true);

        return res.status(200).json({ 
          sessionId,
          message: 'OTP sent successfully',
        });
      } else {
        console.error('MiMSMS error:', result);
        
        // Track SMS failure
        const smsError = new Error(result.responseResult || result.message || 'SMS service unavailable');
        healthMonitor.trackSMS(false, smsError);
        
        // Check if this is a critical error
        if (healthMonitor.isCriticalError('sms_send_failure')) {
          await healthMonitor.sendCriticalAlert('sms_send_failure', smsError, {
            endpoint: '/api/send-otp',
            phoneNumber: normalizedPhoneNumber,
          });
        }
        
        // Keep the OTP in database for manual retry
        return res.status(500).json({ 
          error: `Failed to send OTP: ${result.responseResult || result.message || 'SMS service unavailable'}`,
          sessionId, // Still return sessionId for potential retry
        });
      }
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        console.error('SMS API timeout');
        
        // Track timeout as SMS failure
        healthMonitor.trackSMS(false, fetchError);
        await healthMonitor.sendCriticalAlert('sms_send_failure', fetchError, {
          endpoint: '/api/send-otp',
          reason: 'timeout',
        });
        
        return res.status(504).json({ 
          error: 'SMS service timeout. Please try again.',
          sessionId,
        });
      }
      throw fetchError;
    }
  } catch (error) {
    console.error('Error sending OTP:', error.message, error.stack);
    
    // Track general error
    healthMonitor.trackError('otp_send_error', error, { endpoint: '/api/send-otp' });
    
    res.status(500).json({ error: `Failed to send OTP: ${error.message}` });
  }
});

// Retry OTP sending endpoint
app.post('/api/retry-otp', async (req, res) => {
  const { sessionId } = req.body;

  // Log outgoing IP before making SMS request
  await logOutgoingIP('RETRY_OTP');

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  try {
    const otpDoc = await otpCollection.doc(sessionId).get();
    if (!otpDoc.exists) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const data = otpDoc.data();
    
    // Check if OTP is still valid
    if (Date.now() > data.expiresAt) {
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }

    const normalizedPhoneNumber = normalizePhoneNumber(data.phoneNumber);

    // Retry sending SMS
    const response = await fetch(SMS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        UserName: SMS_USERNAME,
        Apikey: SMS_API_KEY,
        MobileNumber: normalizedPhoneNumber,
        CampaignId: 'null',
        SenderName: SMS_SENDER_NAME,
        TransactionType: SMS_TRANSACTION_TYPE,
        Message: `Welcome to sportsstation. Your OTP is ${data.otp}`,
      }),
    });

    const result = await response.json();
    console.log('Retry OTP - MiMSMS Response:', JSON.stringify(result, null, 2));

    if (response.ok && result.statusCode === '200') {
      await otpCollection.doc(sessionId).update({
        smsSent: true,
        smsResponse: result,
      });
      healthMonitor.trackSMS(true);
      return res.status(200).json({ message: 'OTP resent successfully' });
    } else {
      const smsError = new Error(result.responseResult || result.message);
      healthMonitor.trackSMS(false, smsError);
      return res.status(500).json({ 
        error: `Failed to resend OTP: ${result.responseResult || result.message}` 
      });
    }
  } catch (error) {
    console.error('Error retrying OTP:', error.message, error.stack);
    healthMonitor.trackError('otp_retry_error', error, { endpoint: '/api/retry-otp' });
    res.status(500).json({ error: `Failed to retry OTP: ${error.message}` });
  }
});

// Send general SMS endpoint (no JWT verification)
app.post('/api/send-sms', async (req, res) => {
  const { phoneNumber, message } = req.body;

  // Log outgoing IP before making SMS request
  await logOutgoingIP('SEND_SMS');

  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'Phone number and message are required' });
  }

  if (!validatePhoneNumber(phoneNumber)) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);

  try {
    const response = await fetch(SMS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        UserName: SMS_USERNAME,
        Apikey: SMS_API_KEY,
        MobileNumber: normalizedPhoneNumber,
        CampaignId: 'null',
        SenderName: SMS_SENDER_NAME,
        TransactionType: SMS_TRANSACTION_TYPE,
        Message: message,
      }),
    });

    const result = await response.json();
    console.log('Send SMS - MiMSMS Response:', JSON.stringify(result, null, 2));

    if (!response.ok || result.statusCode !== '200') {
      console.error('MiMSMS error:', result);
      const smsError = new Error(result.responseResult || result.message || 'SMS service unavailable');
      healthMonitor.trackSMS(false, smsError);
      return res.status(500).json({ 
        error: `Failed to send SMS: ${result.responseResult || result.message || 'SMS service unavailable'}` 
      });
    }

    healthMonitor.trackSMS(true);
    res.status(200).json({ message: 'SMS sent successfully', trxnId: result.trxnId });
  } catch (error) {
    console.error('Error sending SMS:', error.message, error.stack);
    healthMonitor.trackError('sms_send_error', error, { endpoint: '/api/send-sms' });
    res.status(500).json({ error: `Failed to send SMS: ${error.message}` });
  }
});

// Verify OTP endpoint
app.post('/api/verify-otp', async (req, res) => {
  const { phoneNumber, otp, sessionId } = req.body;

  if (!phoneNumber || !otp || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const otpDoc = await otpCollection.doc(sessionId).get();
    if (!otpDoc.exists) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const data = otpDoc.data();
    if (data.phoneNumber !== phoneNumber || data.otp !== otp || Date.now() > data.expiresAt) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    await otpCollection.doc(sessionId).delete();

    const jwtPayload = { phoneNumber };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '30d' });
    const refreshToken = jwt.sign(jwtPayload, REFRESH_TOKEN_SECRET, { expiresIn: '90d' });

    await db.collection('refreshTokens').doc(phoneNumber).set({
      refreshToken,
      createdAt: Date.now(),
    });

    const playerQuery = await db.collection('players')
      .where('phone_number', '==', phoneNumber)
      .limit(1)
      .get();

    let isProfileComplete = false;
    if (playerQuery.empty) {
      await db.collection('players').add({
        phone_number: phoneNumber,
        name: '',
        in_game_name: '',
        image_url: '',
        editedby_player: false,
        created_at: Date.now(),
      });
    } else {
      const playerData = playerQuery.docs[0].data();
      isProfileComplete = playerData.editedby_player === true;
    }

    res.status(200).json({ jwt: token, refreshToken, isProfileComplete });
  } catch (error) {
    console.error('Error verifying OTP:', error.message, error.stack);
    res.status(500).json({ error: `OTP verification failed: ${error.message}` });
  }
});

// Refresh token endpoint
app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    const storedTokenDoc = await db.collection('refreshTokens').doc(decoded.phoneNumber).get();

    if (!storedTokenDoc.exists || storedTokenDoc.data().refreshToken !== refreshToken) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const newToken = jwt.sign({ phoneNumber: decoded.phoneNumber }, JWT_SECRET, { expiresIn: '30d' });
    res.status(200).json({ jwt: newToken });
  } catch (error) {
    console.error('Error refreshing token:', error.message, error.stack);
    res.status(401).json({ error: `Invalid or expired refresh token: ${error.message}` });
  }
});

// Logout endpoint
app.post('/api/logout', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    const tokenDoc = await db.collection('refreshTokens').doc(phoneNumber).get();

    if (tokenDoc.exists) {
      await db.collection('refreshTokens').doc(phoneNumber).delete();
    }

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error during logout:', error.message, error.stack);
    res.status(500).json({ error: `Failed to log out: ${error.message}` });
  }
});

// ============================================================================
// CHALLONGE TOURNAMENT PROXY ENDPOINTS
// ============================================================================

// Fetch tournament participants
app.get('/api/tournaments/:slug/participants.json', async (req, res) => {
  const { slug } = req.params;
  const queryParams = new URLSearchParams({
    api_key: CHALLONGE_API_KEY,
    ...req.query,
  });

  try {
    const response = await fetch(
      `${CHALLONGE_BASE_URL}/tournaments/${slug}/participants.json?${queryParams}`,
      {
        headers: {
          'User-Agent': 'SportsStationBackend/1.0',
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Challonge participants error:', errorText);
      return res.status(response.status).json({ 
        error: `Challonge API error: ${response.statusText}`,
        details: errorText,
      });
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching participants:', error.message, error.stack);
    res.status(500).json({ error: `Failed to fetch participants: ${error.message}` });
  }
});

// Fetch tournament matches
app.get('/api/tournaments/:slug/matches.json', async (req, res) => {
  const { slug } = req.params;
  const queryParams = new URLSearchParams({
    api_key: CHALLONGE_API_KEY,
    ...req.query,
  });

  try {
    const response = await fetch(
      `${CHALLONGE_BASE_URL}/tournaments/${slug}/matches.json?${queryParams}`,
      {
        headers: {
          'User-Agent': 'SportsStationBackend/1.0',
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Challonge matches error:', errorText);
      return res.status(response.status).json({ 
        error: `Challonge API error: ${response.statusText}`,
        details: errorText,
      });
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching matches:', error.message, error.stack);
    res.status(500).json({ error: `Failed to fetch matches: ${error.message}` });
  }
});

// Fetch tournament details (optional - for additional info)
app.get('/api/tournaments/:slug.json', async (req, res) => {
  const { slug } = req.params;
  const queryParams = new URLSearchParams({
    api_key: CHALLONGE_API_KEY,
    ...req.query,
  });

  try {
    const response = await fetch(
      `${CHALLONGE_BASE_URL}/tournaments/${slug}.json?${queryParams}`,
      {
        headers: {
          'User-Agent': 'SportsStationBackend/1.0',
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Challonge tournament error:', errorText);
      return res.status(response.status).json({ 
        error: `Challonge API error: ${response.statusText}`,
        details: errorText,
      });
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching tournament:', error.message, error.stack);
    res.status(500).json({ error: `Failed to fetch tournament: ${error.message}` });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res.status(500).json({ error: `Internal server error: ${err.message}` });
});

// On-demand health report endpoint
app.post('/api/report-now', requireAuth, async (req, res) => {
  try {
    await healthMonitor.sendHourlyReport();
    const report = await healthMonitor.generateHealthReport();
    res.status(200).json({ 
      message: 'Health report sent to Discord',
      report,
    });
  } catch (error) {
    console.error('Error generating on-demand report:', error.message, error.stack);
    healthMonitor.trackError('report_generation_error', error, { endpoint: '/api/report-now' });
    res.status(500).json({ error: `Failed to generate report: ${error.message}` });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const report = await healthMonitor.generateHealthReport();
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: report.uptime,
    outgoingIP: report.outgoingIP,
    services: {
      firebase: report.services.firebase,
      sms: report.services.sms,
      challonge: CHALLONGE_BASE_URL,
    },
    metrics: report.metrics,
  });
});

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

// Hourly health report (at minute 0 of every hour)
cron.schedule('0 * * * *', async () => {
  console.log('Running scheduled hourly health report');
  try {
    await healthMonitor.sendHourlyReport();
  } catch (error) {
    console.error('Error in scheduled health report:', error.message);
  }
});

// Daily log purging (at 2:00 AM every day)
cron.schedule('0 2 * * *', async () => {
  console.log('Running scheduled log purge');
  try {
    await healthMonitor.purgeOldLogs();
  } catch (error) {
    console.error('Error in scheduled log purge:', error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS enabled for: ${process.env.CORS_ORIGIN || '*'}`);
  console.log('Health monitoring system initialized');
  console.log('Scheduled jobs:');
  console.log('  - Hourly health reports (every hour at :00)');
  console.log('  - Daily log purging (daily at 2:00 AM)');
  
  // Send initial startup notification
  if (process.env.DISCORD_WEBHOOK_URL) {
    healthMonitor.sendHourlyReport().catch(err => {
      console.error('Failed to send startup health report:', err.message);
    });
  }
});
