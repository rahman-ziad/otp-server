const healthMonitor = require('../healthMonitor');

// Middleware to track all incoming requests
function requestTracker(req, res, next) {
  const endpoint = `${req.method} ${req.path}`;
  const source = req.ip || req.connection.remoteAddress || 'unknown';
  
  // Track the request
  healthMonitor.trackRequest(endpoint, source, {
    userAgent: req.get('user-agent'),
    referer: req.get('referer'),
  });
  
  // Track response time
  const startTime = Date.now();
  
  // Override res.json to track errors
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    const responseTime = Date.now() - startTime;
    
    // Track errors in responses
    if (res.statusCode >= 400 && body && body.error) {
      const errorType = res.statusCode >= 500 ? 'server_error' : 'client_error';
      healthMonitor.trackError(errorType, new Error(body.error), {
        endpoint,
        statusCode: res.statusCode,
        responseTime,
      });
    }
    
    return originalJson(body);
  };
  
  next();
}

module.exports = requestTracker;
