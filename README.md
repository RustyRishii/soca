# Job Queue System with Supabase

A complete job queue system built entirely on Supabase (Postgres + Edge Functions) — no Redis, no external queue service.

##  Features

- **Immediate Response**: Jobs are enqueued instantly, returning a job ID without waiting
- **Async Processing**: Heavy API calls run in the background
- **Status Polling**: Lightweight endpoint for clients to check job progress
- **Concurrent Submission Handling**: Duplicate prevention via idempotency keys
- **Job Timeouts**: Automatic detection and recovery of stuck jobs
- **Exponential Backoff**: Retries with increasing delay (10s → 20s → 40s)
- **Dead-Letter Queue**: Permanently failed jobs preserved for debugging

---

##  Database Schema

### Entity Relationship

```
┌─────────────────────────────────────────────────────────────────┐
│                           jobs                                   │
├─────────────────────────────────────────────────────────────────┤
│ id              UUID        PRIMARY KEY                          │
│ user_id         UUID        → auth.users (nullable)              │
│ idempotency_key TEXT        UNIQUE (prevents duplicates)         │
│ query           TEXT        NOT NULL                             │
│ status          job_status  ENUM                                 │
│ result          JSONB       (nullable)                           │
│ error_message   TEXT        (nullable)                           │
│ retry_count     INTEGER     DEFAULT 0                            │
│ max_retries     INTEGER     DEFAULT 3                            │
│ next_retry_at   TIMESTAMPTZ (nullable)                           │
│ timeout_seconds INTEGER     DEFAULT 600                          │
│ locked_at       TIMESTAMPTZ (nullable)                           │
│ locked_by       TEXT        (nullable)                           │
│ created_at      TIMESTAMPTZ DEFAULT NOW()                        │
│ updated_at      TIMESTAMPTZ DEFAULT NOW()                        │
│ completed_at    TIMESTAMPTZ (nullable)                           │
└─────────────────────────────────────────────────────────────────┘
```

### Status Enum Values

```sql
CREATE TYPE job_status AS ENUM (
  'pending',      -- Job created, waiting to be picked up
  'processing',   -- Worker is actively processing the job
  'completed',    -- Job finished successfully
  'failed',       -- Job failed, may retry
  'dead_letter'   -- Permanently failed after max retries
);
```

### State Transitions

```
                    ┌──────────────┐
                    │   pending    │◄─────────────────┐
                    └──────┬───────┘                  │
                           │                          │
                           ▼                          │
                    ┌──────────────┐                  │
                    │  processing  │                  │
                    └──────┬───────┘                  │
                           │                          │
              ┌────────────┴────────────┐             │
              │                         │             │
              ▼                         ▼             │
       ┌──────────────┐          ┌──────────────┐     │
       │  completed   │          │    failed    │─────┘
       └──────────────┘          └──────┬───────┘ (if retry_count < max_retries)
                                        │
                                        │ (if retry_count >= max_retries)
                                        ▼
                                 ┌──────────────┐
                                 │ dead_letter  │
                                 └──────────────┘
```

---

##  Schema Column Explanations

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key, returned to client as job identifier |
| `user_id` | UUID | Links job to authenticated user (optional) |
| `idempotency_key` | TEXT | Unique key to prevent duplicate job submissions |
| `query` | TEXT | The search/request input from the user |
| `status` | ENUM | Current state of the job |
| `result` | JSONB | API response data when job completes successfully |
| `error_message` | TEXT | Error details when job fails |
| `retry_count` | INTEGER | Number of processing attempts made |
| `max_retries` | INTEGER | Maximum allowed retry attempts |
| `next_retry_at` | TIMESTAMPTZ | When the next retry should occur (exponential backoff) |
| `timeout_seconds` | INTEGER | How long before a processing job is considered stuck |
| `locked_at` | TIMESTAMPTZ | When a worker claimed this job |
| `locked_by` | TEXT | Worker ID that claimed this job |
| `created_at` | TIMESTAMPTZ | When the job was initially created |
| `updated_at` | TIMESTAMPTZ | Last modification timestamp (auto-updated via trigger) |
| `completed_at` | TIMESTAMPTZ | When the job finished (success or final failure) |

---

##  Schema Design Decisions

### 1. Why `idempotency_key`?
**Problem**: User double-clicks "Search" button → two identical jobs created.

**Solution**: Generate a unique key from `user_id + query`. The UNIQUE constraint ensures:
- Same user + same query = returns existing job
- Different user + same query = creates new job

### 2. Why `locked_at` and `locked_by`?
**Problem**: Multiple workers might pick up the same job simultaneously.

**Solution**: 
- `locked_at` records when a worker claimed the job
- `locked_by` identifies which worker has it
- Enables timeout detection: if `locked_at + timeout_seconds < NOW()`, the job is stuck

### 3. Why `next_retry_at` instead of immediate retry?
**Problem**: If an API is down, immediate retries overload it further.

**Solution**: Exponential backoff scheduling:
- 1st retry: wait 10 seconds
- 2nd retry: wait 20 seconds
- 3rd retry: wait 40 seconds

### 4. Why separate `retry_count` and `max_retries`?
**Problem**: Need to track attempts AND enforce limits.

**Solution**:
- `retry_count`: How many times we've tried (increments on each failure)
- `max_retries`: The limit (configurable per job)
- When `retry_count >= max_retries`, job moves to `dead_letter`

### 5. Why `dead_letter` status instead of just `failed`?
**Problem**: How to distinguish "will retry" from "permanently failed"?

**Solution**:
- `failed`: Temporary failure, will be retried
- `dead_letter`: Permanent failure, preserved for debugging
- Dead letter jobs contain error info for post-mortem analysis

### 6. Why `JSONB` for `result`?
**Problem**: Different APIs return different response structures.

**Solution**: JSONB allows storing any JSON structure, enabling:
- Flexibility for different API responses
- Efficient querying with Postgres JSON operators
- No schema migrations needed for new response fields

---

##  Edge Functions

### 1. Enqueue (`/functions/v1/enqueue`)
Creates a new job and returns immediately.

```bash
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/enqueue \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"query": "weather in Tokyo"}'
```

**Response:**
```json
{
  "job_id": "abc-123-xyz",
  "message": "Job created successfully",
  "status": "pending"
}
```

### 2. Status (`/functions/v1/status`)
Lightweight polling endpoint.

```bash
curl "https://YOUR_PROJECT.supabase.co/functions/v1/status?job_id=abc-123-xyz" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

**Response:**
```json
{
  "job_id": "abc-123-xyz",
  "status": "completed",
  "query": "weather in Tokyo",
  "result": { ... },
  "created_at": "...",
  "completed_at": "..."
}
```

### 3. Process (`/functions/v1/process`)
Picks up pending jobs and processes them.

```bash
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/process \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

**For testing failures:**
```bash
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/process \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"force_fail": true}'
```

---

##  Complete SQL Schema

```sql
-- 1. Create the status enum
CREATE TYPE job_status AS ENUM (
  'pending',
  'processing', 
  'completed',
  'failed',
  'dead_letter'
);

-- 2. Create the jobs table
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  idempotency_key TEXT UNIQUE,
  query TEXT NOT NULL,
  result JSONB,
  error_message TEXT,
  status job_status NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  timeout_seconds INTEGER NOT NULL DEFAULT 600,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 3. Create indexes for performance
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_user_id ON jobs(user_id);
CREATE INDEX idx_jobs_next_retry_at ON jobs(next_retry_at) WHERE status = 'pending';
CREATE INDEX idx_jobs_locked_at ON jobs(locked_at) WHERE status = 'processing';

-- 4. Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

---

## 🏗️ Project Structure

```
soca/
├── frontend/                 # React + Tailwind frontend
│   ├── src/
│   │   ├── App.tsx          # Main component with job queue UI
│   │   └── index.css        # Tailwind imports
│   └── package.json
├── supabase/
│   └── functions/
│       ├── enqueue/         # Creates new jobs
│       │   └── index.ts
│       ├── process/         # Processes pending jobs
│       │   └── index.ts
│       └── status/          # Returns job status
│           └── index.ts
└── README.md
```

---

## Testing Scenarios

| Scenario | How to Test | Expected Result |
|----------|-------------|-----------------|
| Normal flow | Submit query → Process → Check status | Status: `completed` with result |
| Duplicate prevention | Submit same query twice | Returns same job_id |
| Retry mechanism | Process with `force_fail: true` | Status: `failed`, retry_count: 1 |
| Dead-letter queue | Force fail 3 times | Status: `dead_letter` |
| Exponential backoff | Check `next_retry_at` after failure | Increasing intervals |

---

## External API

The system uses **httpbin.org/delay/5** as a mock external API that simulates long-running operations. In production, this would be replaced with the actual search/AI API.

```typescript
// Current (testing)
const apiResponse = await fetch(`https://httpbin.org/delay/5`, {...})

```

---

## 🚀 Deployment

```bash
# Deploy all functions
supabase functions deploy

# Or deploy individually
supabase functions deploy enqueue
supabase functions deploy process
supabase functions deploy status
```

---

## License

MIT
