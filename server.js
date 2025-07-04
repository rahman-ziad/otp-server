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

  // Normalize phone number by removing '+' sign
  const normalizedPhoneNumber = phoneNumber.startsWith('+') ? phoneNumber.substring(1) : phoneNumber;

  const otp = generateOTP();
  const sessionId = Math.random().toString(36).substring(2);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5-minute expiry

  try {
    // Store OTP in Firestore with original phoneNumber
    await otpCollection.doc(sessionId).set({ 
      phoneNumber, 
      otp, 
      expiresAt,
      createdAt: Date.now()
    });

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

    if (!response.ok) {
      console.error('SMS API request failed:', response.status, response.statusText);
      return res.status(500).json({ error: 'Failed to send OTP - SMS service unavailable' });
    }

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

    // Delete used OTP
    await otpCollection.doc(sessionId).delete();

    // Create JWT tokens
    const jwtPayload = { phoneNumber };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign(jwtPayload, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });

    // Store refresh token
    await db.collection('refreshTokens').doc(phoneNumber).set({
      refreshToken,
      createdAt: Date.now(),
    });

    // Check if player document exists
    const playerQuery = await db.collection('players')
      .where('phone_number', '==', phoneNumber)
      .limit(1)
      .get();
    
    let isProfileComplete = false;
    if (playerQuery.empty) {
      // Create new player document for new user
      await db.collection('players').add({
        phone_number: phoneNumber,
        name: '',
        in_game_name: '',
        image_url: '',
        editedby_player: false,
        created_at: Date.now(),
      });
    } else {
      // Check if profile is complete
      const playerData = playerQuery.docs[0].data();
      isProfileComplete = playerData.editedby_player === true;
    }

    res.status(200).json({ jwt: token, refreshToken, isProfileComplete });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'OTP verification failed' });
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
    const tokenDoc = await db.collection('refreshTokens').doc(phoneNumber).get();

    if (tokenDoc.exists) {
      await db.collection('refreshTokens').doc(phoneNumber).delete();
    }

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ error: 'Failed to log out' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});