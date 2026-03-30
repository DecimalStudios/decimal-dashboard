// Vercel serverless function — Smartsheet API proxy
// Forwards all /api/ss/* requests to api.smartsheet.com
// Set SMARTSHEET_TOKEN in Vercel environment variables

export default async function handler(req, res) {
  const token = process.env.SMARTSHEET_TOKEN;

  if (!token) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN environment variable is not set.' });
  }

  // Strip /api/ss prefix to get the Smartsheet path
  const ssPath = req.url.replace(/^\/api\/ss/, '') || '/';

  const ssUrl = `https://api.smartsheet.com/2.0${ssPath}`;

  try {
    const response = await fetch(ssUrl, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
