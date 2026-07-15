# RED AI

RED AI is an internal founder and early-stage project intelligence tool for marketing and research teams. One search turns public web signals into a structured brief covering the company, founders, contact routes, region, segment, funding signals, sources, and confidence.

## Features

- Searches companies, projects, and founder names
- Supports Web3 and traditional startups
- Uses Chinese query variants and Baidu-backed discovery for CJK searches
- Scrapes official team, about, contact, and footer pages first
- Extracts public founder names, roles, emails, social profiles, and contact forms
- Falls back to Hunter and Apollo only when scraping does not produce an email
- Verifies email candidates with Hunter
- Streams each pipeline stage to the browser
- Preserves partial results when a provider fails
- Uses server-memory caching and session-only search history

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Cheerio
- SerpAPI
- Hunter
- Apollo

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Environment variables

```env
SERPAPI_KEY=
HUNTER_API_KEY=
APOLLO_API_KEY=
```

SerpAPI powers discovery. Hunter and Apollo are optional enrichment fallbacks. Missing keys and quota failures become step warnings instead of discarding findings from public sources.

## Pipeline

1. Run general, founder, contact, freshness, and Chinese-language search variants.
2. Rank likely official domains while excluding social networks and directories.
3. Safely fetch the official homepage and relevant team/about/contact pages.
4. Extract public emails, leadership names, descriptions, logos, and social links.
5. Cross-check LinkedIn, X, Crunchbase, and Wellfound search signals.
6. Use Hunter, then Apollo, when no public email was found.
7. Verify the selected email with Hunter.
8. Build the result with source and confidence notes.

## API

`POST /api/search`

```json
{
  "query": "Domus Protocol"
}
```

The route returns newline-delimited JSON with live `stage` events followed by one `result` event. Provider keys remain server-side.

## Security and privacy

- Provider calls run only in the Node.js route handler.
- Environment variables are never sent to the client.
- Scraping rejects private, local, and non-HTTP destinations.
- Redirect destinations are revalidated before fetching.
- Search history is session-only.
- RED AI finds information; it does not contact anyone.

## Vercel

Import the repository, add the environment variables, and deploy. No custom Vercel configuration is required.

## V1 scope

No accounts, persistent database, bulk search, or outreach workflow.

---

Built and maintained by [onchaindc](https://github.com/onchaindc).
