const axios = require('axios');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Metrics storage
const metrics = {
  requests: {
    total: 0,
    byEndpoint: {},
    bySource: {},
    lastHour: [],
  },
  errors: {
    total: 0,
    byType: {},
    lastHour: [],
  },
  smsStatus: {
    sent: 0,
    failed: 0,
    lastError: null,
  },
  startTime: Date.now(),
};

// Configuration
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ADMIN_PHONE = process.env.ADMIN_PHONE;
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);

// Firestore reference
let db;

// Initialize with Firebase admin instance
function initialize(firebaseDb) {
  db = firebaseDb;
}

// Track incoming requests
function trackRequest(endpoint, source, metadata = {}) {
  const timestamp = Date.now();
  
  metrics.requests.total++;
  metrics.requests.byEndpoint[endpoint] = (metrics.requests.byEndpoint[endpoint] || 0) + 1;
  metrics.requests.bySource[source] = (metrics.requests.bySource[source] || 0) + 1;
  
  metrics.requests.lastHour.push({ endpoint, source, timestamp, metadata });
  
  // Clean up old entries (keep only last hour)
  const oneHourAgo = timestamp - 3600000;
  metrics.requests.lastHour = metrics.requests.lastHour.filter(r => r.timestamp > oneHourAgo);
}

// Track errors
function trackError(type, error, context = {}) {
  const timestamp = Date.now();
  
  metrics.errors.total++;
  metrics.errors.byType[type] = (metrics.errors.byType[type] || 0) + 1;
  
  const errorEntry = {
    type,
    message: error.message || String(error),
    stack: error.stack,
    context,
    timestamp,
  };
  
  metrics.errors.lastHour.push(errorEntry);
  
  // Clean up old entries
  const oneHourAgo = timestamp - 3600000;
  metrics.errors.lastHour = metrics.errors.lastHour.filter(e => e.timestamp > oneHourAgo);
  
  return errorEntry;
}

// Track SMS status
function trackSMS(success, error = null) {
  if (success) {
    metrics.smsStatus.sent++;
  } else {
    metrics.smsStatus.failed++;
    metrics.smsStatus.lastError = {
      message: error?.message || String(error),
      timestamp: Date.now(),
    };
  }
}

// Get outgoing IP
async function getOutgoingIP() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch (error) {
    console.error('Error getting outgoing IP:', error.message);
    return 'unknown';
  }
}

// Check Firebase status
async function checkFirebaseStatus() {
  try {
    if (!db) return 'not_initialized';
    
    // Try a simple read operation
    await db.collection('_health_check').limit(1).get();
    return 'connected';
  } catch (error) {
    return `error: ${error.message}`;
  }
}

// Generate health report data
async function generateHealthReport() {
  const uptime = Date.now() - metrics.startTime;
  const uptimeHours = Math.floor(uptime / 3600000);
  const uptimeMinutes = Math.floor((uptime % 3600000) / 60000);
  
  const outgoingIP = await getOutgoingIP();
  const firebaseStatus = await checkFirebaseStatus();
  
  // Calculate requests in the last hour
  const requestsLastHour = metrics.requests.lastHour.length;
  const errorsLastHour = metrics.errors.lastHour.length;
  
  // Get top endpoints
  const topEndpoints = Object.entries(metrics.requests.byEndpoint)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([endpoint, count]) => ({ endpoint, count }));
  
  // Get request sources
  const sources = Object.entries(metrics.requests.bySource)
    .map(([source, count]) => ({ source, count }));
  
  return {
    timestamp: new Date().toISOString(),
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    uptimeMs: uptime,
    outgoingIP,
    services: {
      firebase: firebaseStatus,
      sms: metrics.smsStatus.lastError ? 
        `warning (last error: ${metrics.smsStatus.lastError.message})` : 
        'operational',
    },
    metrics: {
      requests: {
        total: metrics.requests.total,
        lastHour: requestsLastHour,
      },
      errors: {
        total: metrics.errors.total,
        lastHour: errorsLastHour,
      },
      sms: {
        sent: metrics.smsStatus.sent,
        failed: metrics.smsStatus.failed,
      },
    },
    topEndpoints,
    sources,
    recentErrors: metrics.errors.lastHour.slice(-5).map(e => ({
      type: e.type,
      message: e.message,
      timestamp: new Date(e.timestamp).toISOString(),
    })),
  };
}

// Send Discord notification
async function sendDiscordNotification(title, description, color, fields = []) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('Discord webhook URL not configured');
    return false;
  }
  
  try {
    const embed = {
      title,
      description,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'OTP Server Health Monitor',
      },
    };
    
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [embed],
    });
    
    return true;
  } catch (error) {
    console.error('Error sending Discord notification:', error.message);
    return false;
  }
}

// Send hourly health report to Discord
async function sendHourlyReport() {
  const report = await generateHealthReport();
  
  const fields = [
    {
      name: '🌐 Outgoing IP',
      value: report.outgoingIP,
      inline: true,
    },
    {
      name: '⏱️ Uptime',
      value: report.uptime,
      inline: true,
    },
    {
      name: '📊 Requests (Last Hour)',
      value: `${report.metrics.requests.lastHour} requests`,
      inline: true,
    },
    {
      name: '🔥 Firebase',
      value: report.services.firebase,
      inline: true,
    },
    {
      name: '📱 SMS Service',
      value: report.services.sms,
      inline: true,
    },
    {
      name: '📤 SMS Stats',
      value: `✅ ${report.metrics.sms.sent} sent | ❌ ${report.metrics.sms.failed} failed`,
      inline: true,
    },
  ];
  
  if (report.topEndpoints.length > 0) {
    fields.push({
      name: '🎯 Top Endpoints',
      value: report.topEndpoints.map(e => `\`${e.endpoint}\`: ${e.count}`).join('\n'),
      inline: false,
    });
  }
  
  if (report.sources.length > 0) {
    fields.push({
      name: '📍 Request Sources',
      value: report.sources.map(s => `${s.source}: ${s.count}`).join('\n'),
      inline: false,
    });
  }
  
  if (report.recentErrors.length > 0) {
    fields.push({
      name: '⚠️ Recent Errors',
      value: report.recentErrors.map(e => `[${e.type}] ${e.message.substring(0, 100)}`).join('\n').substring(0, 1024),
      inline: false,
    });
  }
  
  const color = report.metrics.errors.lastHour > 10 ? 0xFF0000 : 
                report.metrics.errors.lastHour > 0 ? 0xFFA500 : 0x00FF00;
  
  await sendDiscordNotification(
    '📊 Hourly Health Report',
    `Server is running for ${report.uptime}`,
    color,
    fields
  );
  
  // Log to Firestore
  await logToFirestore('hourly_report', report);
}

// Send critical error alert
async function sendCriticalAlert(errorType, error, context = {}) {
  console.error(`[CRITICAL ALERT] ${errorType}:`, error.message);
  
  // Send Discord alert
  const fields = [
    {
      name: 'Error Type',
      value: errorType,
      inline: true,
    },
    {
      name: 'Timestamp',
      value: new Date().toISOString(),
      inline: true,
    },
    {
      name: 'Error Message',
      value: error.message || String(error),
      inline: false,
    },
  ];
  
  if (context && Object.keys(context).length > 0) {
    fields.push({
      name: 'Context',
      value: JSON.stringify(context, null, 2).substring(0, 1024),
      inline: false,
    });
  }
  
  await sendDiscordNotification(
    '🚨 CRITICAL ERROR ALERT',
    `A critical error has occurred in the OTP server`,
    0xFF0000, // Red
    fields
  );
  
  // Send SMS to admin if configured
  if (ADMIN_PHONE) {
    try {
      // Use the same SMS sending mechanism
      const SMS_API_URL = 'https://api.mimsms.com/api/SmsSending/SMS';
      const SMS_USERNAME = process.env.SMS_USERNAME;
      const SMS_API_KEY = process.env.SMS_API_KEY;
      const SMS_SENDER_NAME = process.env.SMS_SENDER_NAME;
      
      if (SMS_USERNAME && SMS_API_KEY && SMS_SENDER_NAME) {
        await fetch(SMS_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            UserName: SMS_USERNAME,
            Apikey: SMS_API_KEY,
            MobileNumber: ADMIN_PHONE.startsWith('+') ? ADMIN_PHONE.substring(1) : ADMIN_PHONE,
            CampaignId: 'null',
            SenderName: SMS_SENDER_NAME,
            TransactionType: 'T',
            Message: `[OTP Server Alert] ${errorType}: ${error.message}`,
          }),
        });
      }
    } catch (smsError) {
      console.error('Failed to send SMS alert:', smsError.message);
    }
  }
  
  // Log to Firestore
  await logToFirestore('critical_alert', {
    errorType,
    message: error.message,
    stack: error.stack,
    context,
    timestamp: Date.now(),
  });
}

// Log to Firestore
async function logToFirestore(logType, data) {
  if (!db) {
    console.warn('Firestore not initialized, skipping log');
    return;
  }
  
  try {
    await db.collection('health_logs').add({
      type: logType,
      data,
      timestamp: Date.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Error logging to Firestore:', error.message);
  }
}

// Purge old logs from Firestore
async function purgeOldLogs() {
  if (!db) {
    console.warn('Firestore not initialized, skipping purge');
    return;
  }
  
  const cutoffTime = Date.now() - (LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  
  try {
    const oldLogs = await db.collection('health_logs')
      .where('timestamp', '<', cutoffTime)
      .limit(500) // Process in batches
      .get();
    
    if (oldLogs.empty) {
      console.log('No old logs to purge');
      return;
    }
    
    const batch = db.batch();
    oldLogs.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    console.log(`Purged ${oldLogs.size} old health logs`);
  } catch (error) {
    console.error('Error purging old logs:', error.message);
  }
}

// Check if error is critical
function isCriticalError(errorType) {
  const criticalTypes = [
    'sms_send_failure',
    'firebase_connection_error',
    'api_outage',
    'service_unavailable',
  ];
  return criticalTypes.includes(errorType);
}

// Export module
module.exports = {
  initialize,
  trackRequest,
  trackError,
  trackSMS,
  generateHealthReport,
  sendHourlyReport,
  sendCriticalAlert,
  purgeOldLogs,
  isCriticalError,
  getMetrics: () => metrics,
};
