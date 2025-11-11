// Simple authorization middleware using API key from environment
function requireAuth(req, res, next) {
  const apiKey = req.get('X-API-Key') || req.query.apiKey;
  const validApiKey = process.env.HEALTH_API_KEY;
  
  if (!validApiKey) {
    console.warn('HEALTH_API_KEY not configured, allowing request');
    return next();
  }
  
  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }
  
  next();
}

module.exports = { requireAuth };
