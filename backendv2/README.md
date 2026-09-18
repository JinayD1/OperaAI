# Opera AI Backend (backendv2)

Processing API server for the Opera AI diagnostic pipeline. Handles image upload, AI-powered part localization, and annotated schematic generation.

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/process` | POST | Full pipeline: upload, plan-localize, localize, annotate |
| `/api/upload` | POST | Upload image to Cloudinary |
| `/api/plan-localization` | POST | Generate a localization plan from a repair step via Gemini |
| `/api/localize` | POST | Localize a part in an image using Gemini vision |
| `/api/annotate` | POST | Build Cloudinary URL with bounding-box overlay |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key (all model calls route through OpenRouter) |
| `OPENROUTER_MODEL` | No | Override the model, e.g. `google/gemini-2.5-flash` (the default) |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary API secret |
| `DATABASE_URL` | Yes (cases API) | Postgres connection string |
| `SUPABASE_URL` | Yes (uploads) | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (uploads) | Supabase service-role key (server-side only) |

## Run

```bash
cd backendv2
cp .env.example .env   # fill in the values above
npm install
npm run dev
```

Runs at `http://localhost:3001`.
