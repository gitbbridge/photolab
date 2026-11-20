# Give Holidays Supplier Discovery

Local React + Express application imported from the supplied ZIP. Includes spreadsheet import, package image extraction, image review, supplier discovery, and CSV/XLSX/ZIP exports. Job data is stored in data/giveholidays.db.

## Run on Windows

Requires Node.js 22.13 or newer (uses built-in SQLite).

```powershell
npm install
npm run dev
```

The local .env sets PORT=3015, so open http://localhost:3015. Without that setting the default is port 3000.

## AI configuration

Add these values to .env and restart the server:

```dotenv
PORT=3015
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-5-5
BRIGHTDATA_API_KEY=
BRIGHTDATA_SERP_ZONE=serp_api1
```

The app uses Anthropic's Claude Messages API with Claude Sonnet 5.5 by default. Set CLAUDE_MODEL to another supported vision and web-search model if needed. Enable web search for your Anthropic API organization. Claude is required for AI classification and supplier discovery. Bright Data is optional for Google Lens matching. No credentials were included or copied from other projects. AI requests may incur provider charges.

## Validation and production

```powershell
npm test
npm run lint
npm run build
npm start
```

npm start serves the built dist folder with the same API server. npm run preview serves only the frontend and does not provide API endpoints. Keep .env and data private. The supplied bun.lock is retained as source material; package-lock.json records the validated npm installation.

Claude cost estimates include token usage and web searches. Default token rates match Sonnet 5.5; set CLAUDE_INPUT_USD_PER_MILLION and CLAUDE_OUTPUT_USD_PER_MILLION when changing models. Estimates exclude Bright Data charges.

The Claude adapter tests mock the HTTP responses; no live provider calls are made by npm test. A real API key is needed to validate live classification and supplier research.

Google Lens requests use Bright Data POST https://api.brightdata.com/request with a SERP zone and bearer token. SERP_API_KEY remains a supported alias. Only the first Claude KEEP image per package is searched. Legacy serpapi_* database fields retain historical quota counters; Bright Data cache keys are separate from old provider results.
