const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const cors = require('cors'); // Added CORS package
const { v4: uuidv4 } = require('uuid'); // Added UUID for session IDs
const app = express();

// Enable CORS for all origins (adjust for production)
app.use(cors({
  origin: '*', // Replace with your Flutter app's domain in production
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Initialize Firebase Admin SDK
try {
  const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });
} catch (error) {
  console.error('Error initializing Firebase:', error.message, error.stack);
  process.exit(1);
}

// MiMSMS configuration
const SMS_API_URL = 'https://api.mimsms.com/api/SmsSending/SMS';
const SMS_USERNAME = process.env.SMS_USERNAME || 'fahimmaruf@gmail.com';
const SMS_API_KEY = process.env.SMS_API_KEY || 'VAUSWN3QKZ7FQ0H';
const SMS_SENDER_NAME = process.env.SMS_SENDER_NAME || '8809601003504';
const SMS_TRANSACTION_TYPE = 'T'; // Transactional SMS

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your_refresh_token_secret_key';

// Firestore collection
const db = admin.firestore();
const otpCollection = db.collection('otps');

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

// Send OTP endpoint
app.post('/api/send-otp', async (req, res) => {
  console.log('Request body:', req.body);
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required' });
  }

  if (!validatePhoneNumber(phoneNumber)) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
  const otp = generateOTP();
  const sessionId = uuidv4(); // Use UUID for session ID
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5-minute expiry

  try {
    await otpCollection.doc(sessionId).set({
      phoneNumber,
      otp,
      expiresAt,
      createdAt: Date.now(),
    });

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
    });

    const result = await response.json();
    console.log('Send OTP - MiMSMS Response:', JSON.stringify(result, null, 2));

    if (!response.ok || result.statusCode !== '200') {
      console.error('MiMSMS error:', result);
      return res.status(500).json({ 
        error: `Failed to send OTP: ${result.responseResult || result.message || 'SMS service unavailable'}` 
      });
    }

    res.status(200).json({ sessionId });
  } catch (error) {
    console.error('Error sending OTP:', error.message, error.stack);
    res.status(500).json({ error: `Failed to send OTP: ${error.message}` });
  }
});

// Send general SMS endpoint (no JWT verification)
app.post('/api/send-sms', async (req, res) => {
  const { phoneNumber, message } = req.body;

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
      return res.status(500).json({ 
        error: `Failed to send SMS: ${result.responseResult || result.message || 'SMS service unavailable'}` 
      });
    }

    res.status(200).json({ message: 'SMS sent successfully', trxnId: result.trxnId });
  } catch (error) {
    console.error('Error sending SMS:', error.message, error.stack);
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res.status(500).json({ error: `Internal server error: ${err.message}` });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});