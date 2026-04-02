// Vercel serverless function — Google Sheets API proxy (authenticated via Service Account)
// Set GOOGLE_SERVICE_ACCOUNT_KEY in Vercel environment variables (paste full JSON key contents)

import crypto from 'crypto';

function createJWT(sa) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(sa.private_key, 'base64url');

  return `${header}.${payload}.${signature}`;
}

async function getAccessToken(sa) {
  const jwt = createJWT(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}

function valuesToCSV(values) {
  if (!values || values.length === 0) return '';
  return values.map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(',')
  ).join('\n');
}

export default async function handler(req, res) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set.' });
  }

  let sa;
  try {
    sa = JSON.parse(keyJson);
  } catch (e) {
    return res.status(500).json({ error: 'Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON.' });
  }

  // Spreadsheet ID and optional range from query params
  const spreadsheetId = req.query.id;
  const range = req.query.range || 'Sheet1';

  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Missing ?id= parameter (spreadsheet ID).' });
  }

  try {
    const token = await getAccessToken(sa);

    const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const sheetsRes = await fetch(sheetsUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!sheetsRes.ok) {
      const err = await sheetsRes.text();
      return res.status(sheetsRes.status).json({ error: `Sheets API error: ${err}` });
    }

    const data = await sheetsRes.json();
    const format = req.query.format || 'csv';

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(data);
    }

    // Default: return as CSV so existing frontend parsers work unchanged
    const csv = valuesToCSV(data.values);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).send(csv);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
