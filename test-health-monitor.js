// Simple test script for health monitoring system
const healthMonitor = require('./healthMonitor');

// Mock Firebase db
const mockDb = {
  collection: (name) => ({
    add: async (data) => {
      console.log(`[Mock Firestore] Adding to ${name}:`, data);
      return { id: 'mock-doc-id' };
    },
    where: () => ({
      limit: () => ({
        get: async () => ({
          empty: true,
          docs: [],
          size: 0,
        }),
      }),
    }),
    limit: () => ({
      get: async () => ({
        empty: true,
        docs: [],
      }),
    }),
  }),
};

// Initialize with mock db
healthMonitor.initialize(mockDb);

console.log('=== Health Monitor Test ===\n');

// Test 1: Track some requests
console.log('Test 1: Tracking requests...');
healthMonitor.trackRequest('POST /api/send-otp', '192.168.1.1', { userAgent: 'test-agent' });
healthMonitor.trackRequest('POST /api/verify-otp', '192.168.1.2');
healthMonitor.trackRequest('GET /health', '192.168.1.1');
healthMonitor.trackRequest('POST /api/send-sms', '192.168.1.3');
console.log('✓ Tracked 4 requests\n');

// Test 2: Track some errors
console.log('Test 2: Tracking errors...');
healthMonitor.trackError('server_error', new Error('Test server error'), { endpoint: '/test' });
healthMonitor.trackError('client_error', new Error('Test client error'));
console.log('✓ Tracked 2 errors\n');

// Test 3: Track SMS
console.log('Test 3: Tracking SMS...');
healthMonitor.trackSMS(true);
healthMonitor.trackSMS(true);
healthMonitor.trackSMS(false, new Error('SMS API timeout'));
console.log('✓ Tracked 3 SMS operations\n');

// Test 4: Generate health report
console.log('Test 4: Generating health report...');
healthMonitor.generateHealthReport().then(report => {
  console.log('✓ Generated health report:');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n');
  
  // Test 5: Send hourly report
  console.log('Test 5: Sending hourly report to Discord...');
  return healthMonitor.sendHourlyReport();
}).then(() => {
  console.log('✓ Sent hourly report to Discord\n');
  
  // Test 6: Send critical alert
  console.log('Test 6: Sending critical alert...');
  return healthMonitor.sendCriticalAlert(
    'sms_send_failure',
    new Error('Test critical SMS failure'),
    { endpoint: '/api/send-otp', phoneNumber: '+1234567890' }
  );
}).then(() => {
  console.log('✓ Sent critical alert to Discord\n');
  console.log('=== All Tests Completed ===');
}).catch(error => {
  console.error('✗ Test failed:', error.message);
  process.exit(1);
});
