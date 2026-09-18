# Opera AI Backend

Takes photos of a broken appliance plus a symptom description, identifies the
exact model, reasons over that model's repair manual, and returns a repair
summary, a parts list, and instructions — with every claim traceable to a
manual page.

Replaces `backendv2/`. That service keeps running untouched until this one is
proven.

## How it works

```
Next.js UI ──proxy──▶ FastAPI (uvicorn)
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          Postgres   Supabase   OpenRouter
        (state,      Storage     (Gemini)
         facts)      (bytes)
```

Pipeline stages, each persisted to `stage_runs` as it completes:

| Stage | Does |
|---|---|
| `preprocess` | Normalize images, strip EXIF, thumbnail, probe video |
| `identify` | Read the nameplate, decode the model number, validate against the `appliances` catalog |
| `diagnose` | Reason over the manual PDF + symptom + photos → ranked causes with page citations |
| `parts` | Components implicated, part numbers only where the manual printed them |
| `instruct` | Step-by-step instructions, or a technician brief when the safety gate says so |

## Design decisions worth knowing

**The manual goes into the model's context as a PDF.** No chunking, no
embeddings, no vector store. At this corpus size the context window is the
retrieval layer. Add pgvector when the corpus outgrows it — the `manuals`
table is already the seam.

**PDFs must be sent with the `native` parser engine.** OpenRouter defaults to
text-extracting PDFs, which destroys anything living as an image on the page —
and in appliance manuals the troubleshooting flowcharts and status-code tables
are exactly that. `app/core/llm.py` sets the plugin; don't remove it.

**Part numbers and URLs never come from the model.** Numbers come from the
manual or the catalog; purchase URLs are constructed in code. Hallucinated part
numbers look identical to real ones.

**The DIY/technician verdict is deterministic.** Gas, high voltage, sealed
refrigerant and water heaters route to a professional via a rule table, not a
model judgment — and the manual's own scope language is the source. For the
Carrier furnace that means the homeowner-safe surface is filters, thermostat,
breaker, and the condensate drain.

**Results are persisted, not streamed-and-forgotten.** `stage_runs` is the
queue, the retry ledger, the idempotency key, and the result store at once.
A dropped connection costs nothing; reconnecting replays `pipeline_events`
instead of re-running the pipeline.

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env     # then fill it in
```

Put a manual PDF in `manuals/` (e.g. `manuals/carrier-59sc6a.pdf`) and test
images in `fixtures/`.

```bash
uvicorn app.main:app --reload --port 8000
curl localhost:8000/health | python3 -m json.tool
```

`/health` reports which dependencies are configured and which actually answer,
so a bad `DATABASE_URL` shows up as `configured: true, reachable: false` rather
than a stack trace somewhere downstream.

## Layout

```
app/
  config.py            settings from .env
  main.py              FastAPI app + /health
  schemas/contracts.py FROZEN — the integration boundary for every stage
  core/
    db.py              asyncpg pool, raw SQL, migrate()
    storage.py         signed upload/download URLs (Supabase; swap for S3 here)
    llm.py             OpenRouter/Gemini wrapper, native PDF passthrough
  api/                 route handlers
  pipeline/            runner, safety gate, stages/
migrations/001_init.sql
manuals/               manual PDFs (gitignored)
fixtures/              test images (gitignored)
```
