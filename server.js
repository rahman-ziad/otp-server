const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
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
  process.exit(1);
}

// MiMSMS configuration
const SMS_API_URL = 'https://api.mimsms.com/api/SmsSending/SMS';
const SMS_USERNAME = 'fahimmaruf@gmail.com';
const SMS_API_KEY = 'VAUSWN3QKZ7FQ0H';
const SMS_SENDER_NAME = '8809601003504'; // Replace with your MiMSMS-approved sender ID
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

// Send OTP endpoint
app.post('/api/send-otp', async (req, res) => {
  console.log('Request body:', req.body);
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

  // Normalize phone number by removing '+' sign
  const normalizedPhoneNumber = phoneNumber.startsWith('+') ? phoneNumber.substring(1) : phoneNumber;

  const otp = generateOTP();
  const sessionId = Math.random().toString(36).substring(2);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5-minute expiry

  try {
    // Store OTP in Firestore with original phoneNumber
    await otpCollection.doc(sessionId).set({ phoneNumber, otp, expiresAt });

    // Send OTP via MiMSMS using fetch
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

    if (result.statusCode !== '200' || result.status !== 'Success') {
      console.error('MiMSMS error:', result.responseResult);
      return res.status(500).json({ error: `Failed to send OTP: ${result.responseResult}` });
    }

    res.status(200).json({ sessionId });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP endpoint
app.post('/api/verify-otp', async (req, res) => {
  const { phoneNumber, otp } = req.body;

  if (!phoneNumber || !otp) {
    return res.status(400).json({ error: 'Phone number and OTP are required' });
  }

  try {
    // Fetch OTP from Firestore
    const otpDoc = await admin.firestore()
      .collection('otps')
      .doc(phoneNumber)
      .get();

    if (!otpDoc.exists) {
      return res.status(400).json({ error: 'No OTP found for this phone number' });
    }

    const storedOtp = otpDoc.data().otp;
    const expiresAt = otpDoc.data().expiresAt.toDate();

    if (expiresAt < new Date()) {
      // Delete expired OTP
      await admin.firestore().collection('otps').doc(phoneNumber).delete();
      return res.status(400).json({ error: 'OTP has expired' });
    }

    if (storedOtp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // OTP is valid, generate JWT and refresh token
    const jwtToken = jwt.sign(
      { phoneNumber },
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '1h' }
    );
    const refreshToken = jwt.sign(
      { phoneNumber },
      process.env.REFRESH_SECRET || 'your_refresh_secret',
      { expiresIn: '7d' }
    );

    // Store refresh token in Firestore
    await admin.firestore().collection('refreshTokens').doc(phoneNumber).set({
      refreshToken,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Clear OTP from Firestore
    await admin.firestore().collection('otps').doc(phoneNumber).delete();

    res.status(200).json({
      message: 'Login successful',
      jwt: jwtToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
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

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    // Delete the specific user's refresh token
    const tokenDoc = await admin.firestore()
      .collection('refreshTokens')
      .doc(phoneNumber)
      .get();

    if (tokenDoc.exists) {
      await admin.firestore().collection('refreshTokens').doc(phoneNumber).delete();
    }

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ error: 'Failed to log out' });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));