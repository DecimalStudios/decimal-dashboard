// Vercel serverless function — SAM.gov RFP monitor with optional Claude scoring
// Uses SAM.gov's public search API (no key needed)
// Optional env var: ANTHROPIC_API_KEY (for AI scoring, falls back to keyword scoring)

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Search queries relevant to a design/dev agency
const SEARCH_QUERIES = [
  'website redesign',
  'brand identity',
  'web design',
  'web development services',
  'digital agency',
  'UX design',
  'CMS development',
  'creative services',
];

async function fetchSamPublic() {
  const allResults = [];
  const seen = new Set();

  for (const q of SEARCH_QUERIES) {
    try {
      const url = `https://sam.gov/api/prod/opportunities/v1/search?api_key=null&index=opp&q=${encodeURIComponent(q)}&sort=-modifiedDate&size=25&mode=search&responseStatus=active`;
      const r = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });
      if (!r.ok) continue;
      const data = await r.json();
      const hits = data?._embedded?.results || data?.opportunitiesData || [];

      for (const o of hits) {
        const id = o.noticeId || o._id || o.solicitationNumber || '';
        if (seen.has(id)) continue;
        seen.add(id);

        const title = o.title || o._source?.title || '';
        const desc = o.description || o._source?.description || '';
        const org = o.fullParentPathName || o._source?.fullParentPathName || o.departmentName || o._source?.departmentName || '';
        const deadline = o.responseDeadLine || o._source?.responseDeadLine || '';
        const postedDate = o.postedDate || o._source?.postedDate || '';
        const type = o.type || o._source?.type || o.baseType || o._source?.baseType || '';
        const naics = o.naicsCode || o._source?.naicsCode || '';

        let location = '';
        const addr = o.officeAddress || o._source?.officeAddress;
        if (addr) {
          location = [addr.city, addr.state].filter(Boolean).join(', ');
        } else if (o._source?.placeOfPerformance?.state?.name) {
          location = o._source.placeOfPerformance.state.name;
        }

        const link = o.uiLink || `https://sam.gov/opp/${id}/view`;

        allResults.push({ id, title, description: desc.slice(0, 500), organization: org, deadline, location, type, naics, link, postedDate });
      }
    } catch (e) {
      console.error(`SAM search failed for "${q}":`, e.message);
    }
  }

  return allResults;
}

// Keyword-based scoring fallback when Claude API isn't available
function keywordScore(listing) {
  const text = `${listing.title} ${listing.description}`.toLowerCase();

  const highSignals = ['website redesign', 'web design', 'brand identity', 'branding', 'ux design', 'ui design',
    'user experience', 'digital presence', 'cms', 'wordpress', 'drupal', 'creative agency', 'creative services',
    'graphic design', 'visual design', 'digital strategy', 'web development', 'front-end', 'frontend',
    'responsive design', 'mobile design', 'design system', 'style guide', 'content management',
    'digital marketing', 'communications design', 'annual report design', 'publication design'];

  const lowSignals = ['infrastructure', 'network security', 'penetration testing', 'facilities',
    'construction', 'hvac', 'plumbing', 'electrical', 'janitorial', 'maintenance',
    'military', 'weapons', 'ammunition', 'classified', 'top secret', 'clearance required',
    'hardware', 'server', 'data center', 'cabling', 'roofing', 'paving',
    'medical equipment', 'laboratory', 'vehicle', 'fleet management'];

  let score = 5;
  let rationale = '';
  let highHits = [];
  let lowHits = [];

  for (const sig of highSignals) {
    if (text.includes(sig)) { score += 1.2; highHits.push(sig); }
  }
  for (const sig of lowSignals) {
    if (text.includes(sig)) { score -= 1.5; lowHits.push(sig); }
  }

  score = Math.max(1, Math.min(10, Math.round(score)));

  if (highHits.length > 0) {
    rationale = `Matches Decimal services: ${highHits.slice(0, 3).join(', ')}.`;
  } else if (lowHits.length > 0) {
    rationale = `Outside Decimal scope: ${lowHits.slice(0, 2).join(', ')}.`;
  } else {
    rationale = 'Limited information to assess fit.';
  }

  return { score, rationale };
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
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch (e) {
    console.error('Failed to parse Claude scores:', text);
    return [];
  }
}

export default async function handler(req, res) {
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  try {
    // Fetch from SAM.gov public search (no API key needed)
    const listings = await fetchSamPublic();

    if (listings.length === 0) {
      // Return empty result, not an error
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ listings: [], total: 0, lastUpdated: new Date().toISOString() });
    }

    let scored;

    if (claudeKey) {
      // Score with Claude in batches
      const batchSize = 25;
      const allScores = [];
      for (let i = 0; i < listings.length; i += batchSize) {
        const batch = listings.slice(i, i + batchSize);
        try {
          const scores = await scoreWithClaude(batch, claudeKey);
          for (const s of scores) allScores.push({ ...s, index: s.index + i });
        } catch (e) {
          console.error('Claude scoring failed for batch, falling back to keywords:', e.message);
          batch.forEach((l, j) => {
            const { score, rationale } = keywordScore(l);
            allScores.push({ index: i + j, score, rationale });
          });
        }
      }

      const scoreMap = {};
      for (const s of allScores) scoreMap[s.index] = s;
      scored = listings.map((l, i) => ({
        ...l,
        score: scoreMap[i]?.score ?? 0,
        rationale: scoreMap[i]?.rationale ?? '',
      }));
    } else {
      // Keyword-based scoring fallback
      scored = listings.map(l => {
        const { score, rationale } = keywordScore(l);
        return { ...l, score, rationale };
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const result = {
      listings: scored,
      total: scored.length,
      lastUpdated: new Date().toISOString(),
      scoring: claudeKey ? 'claude' : 'keyword',
    };

    // Cache for 6 hours
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
