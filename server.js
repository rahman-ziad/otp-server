const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const request = require('request');
const app = express();

app.use(express.json());

// Initialize Firebase Admin SDK
try {
  const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });
} catch (error) {
  console.error('Error initializing Firebase:', error);
  process.exit(1); // Exit if Firebase initialization fails
}

// SMS.net.bd configuration
const SMS_API_KEY = process.env.SMS_API_KEY || 'OSF2WmBqBivoiM6q8MlxiSRo19ZnYhfbz24JTuMv';
const SMS_API_URL = 'https://api.sms.net.bd/sendsms';

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

// Send OTP endpoint
app.post('/api/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

  const otp = generateOTP();
  const sessionId = Math.random().toString(36).substring(2);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5-minute expiry

  try {
    // Store OTP in Firestore
    await otpCollection.doc(sessionId).set({ phoneNumber, otp, expiresAt });

    // Send OTP via SMS.net.bd
    const options = {
      method: 'POST',
      url: SMS_API_URL,
      formData: {
        api_key: SMS_API_KEY,
        msg: `Your OTP is ${otp}`,
        to: phoneNumber,
      },
    };

    request(options, (error, response, body) => {
      if (error) {
        console.error('Error sending OTP:', error);
        return res.status(500).json({ error: 'Failed to send OTP' });
      }
      const result = JSON.parse(body);
      if (result.error !== 0) {
        console.error('SMS.net.bd error:', result.msg);
        return res.status(500).json({ error: `Failed to send OTP: ${result.msg}` });
      }
      res.status(200).json({ sessionId });
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
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
    if (!otpDoc.exists) return res.status(400).json({ error: 'Invalid session ID' });

    const data = otpDoc.data();
    if (data.phoneNumber !== phoneNumber || data.otp !== otp || Date.now() > data.expiresAt) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    await otpCollection.doc(sessionId).delete();

    const jwtPayload = { phoneNumber };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign(jwtPayload, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });

    await db.collection('refreshTokens').doc(phoneNumber).set({
      refreshToken,
      createdAt: Date.now(),
    });

    res.status(200).json({ jwt: token, refreshToken });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

// Refresh token endpoint
app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    const storedToken = await db.collection('refreshTokens').doc(decoded.phoneNumber).get();

    if (!storedToken.exists || storedToken.data().refreshToken !== refreshToken) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const newToken = jwt.sign({ phoneNumber: decoded.phoneNumber }, JWT_SECRET, { expiresIn: '1h' });
    res.status(200).json({ jwt: newToken });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// Logout endpoint
app.post('/api/logout', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

  try {
    await db.collection('refreshTokens').doc(phoneNumber).delete();
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));