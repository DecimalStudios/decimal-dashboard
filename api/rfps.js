// Vercel serverless function — SAM.gov RFP monitor with Claude scoring
// Env vars: SAM_GOV_API_KEY, ANTHROPIC_API_KEY

const SAM_URL = 'https://api.sam.gov/prod/opportunities/v2/search';
const NAICS = '541511,541430,541810,541512';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

async function fetchSamOpportunities(apiKey) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86400000); // last 30 days
  const fmt = d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

  const params = new URLSearchParams({
    api_key: apiKey,
    limit: '100',
    offset: '0',
    ptype: 'o,p,r,k',
    naicsCode: NAICS,
    postedFrom: fmt(from),
    postedTo: fmt(now),
  });

  const res = await fetch(`${SAM_URL}?${params}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SAM.gov API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return (data.opportunitiesData || []).map(o => ({
    id: o.noticeId || o.solicitationNumber || '',
    title: o.title || '',
    description: (o.description || '').slice(0, 500),
    organization: o.fullParentPathName || o.departmentName || '',
    deadline: o.responseDeadLine || '',
    location: o.officeAddress ? `${o.officeAddress.city || ''}, ${o.officeAddress.state || ''}`.replace(/^, |, $/g, '') : '',
    type: o.type || o.baseType || '',
    naics: o.naicsCode || '',
    link: o.uiLink || `https://sam.gov/opp/${o.noticeId || ''}`,
    postedDate: o.postedDate || '',
  }));
}

async function scoreWithClaude(listings, apiKey) {
  if (!listings.length) return [];

  const listingSummaries = listings.map((l, i) =>
    `[${i}] "${l.title}" — ${l.organization} — ${l.description.slice(0, 200)}`
  ).join('\n');

  const prompt = `You are evaluating RFP listings for fit with Decimal Studios, a design and web development agency. Their core services are: website design and redesign, brand identity, digital product design, UX/UI design, and web development (React, Next.js, CMS platforms).

Score each listing 1-10 for fit. High scores (7-10): website redesign, brand identity, CMS, digital presence, creative agency services, communications design. Low scores (1-4): government IT infrastructure, facilities management, engineering, specialized compliance, non-design procurement, hardware, military, construction.

For each listing, return ONLY a JSON array with objects containing "index" (number), "score" (1-10), and "rationale" (one sentence). No other text.

Listings:
${listingSummaries}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '[]';

  try {
    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    const scores = match ? JSON.parse(match[0]) : [];
    return scores;
  } catch (e) {
    console.error('Failed to parse Claude scores:', text);
    return [];
  }
}

export default async function handler(req, res) {
  const samKey = process.env.SAM_GOV_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  if (!samKey) return res.status(500).json({ error: 'SAM_GOV_API_KEY not set.' });
  if (!claudeKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  try {
    // Fetch opportunities from SAM.gov
    const listings = await fetchSamOpportunities(samKey);

    // Score in batches of 25 to stay within token limits
    const batchSize = 25;
    const allScores = [];
    for (let i = 0; i < listings.length; i += batchSize) {
      const batch = listings.slice(i, i + batchSize);
      const scores = await scoreWithClaude(batch, claudeKey);
      // Map scores back with offset
      for (const s of scores) {
        allScores.push({ ...s, index: s.index + i });
      }
    }

    // Merge scores into listings
    const scoreMap = {};
    for (const s of allScores) scoreMap[s.index] = s;

    const scored = listings.map((l, i) => ({
      ...l,
      score: scoreMap[i]?.score ?? 0,
      rationale: scoreMap[i]?.rationale ?? '',
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const result = {
      listings: scored,
      total: scored.length,
      lastUpdated: new Date().toISOString(),
    };

    // Cache for 6 hours
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
