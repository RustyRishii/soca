// Enqueue Function - Creates a new job and returns job ID immediately
import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Parse request body
    const { query, user_id } = await req.json()

    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Query is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. Create Supabase client with service role (bypasses RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 3. Generate idempotency key to prevent duplicate jobs
    // Using query + user_id (or just query if no user_id)
    const idempotencyKey = user_id 
      ? `${user_id}:${query}` 
      : `anonymous:${query}`

    // 4. Check if a job with this idempotency key already exists and is not completed/failed
    const { data: existingJob } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('idempotency_key', idempotencyKey)
      .in('status', ['pending', 'processing'])
      .single()

    // 5. If active job exists, return existing job ID
    if (existingJob) {
      return new Response(
        JSON.stringify({ 
          job_id: existingJob.id, 
          message: 'Job already exists',
          status: existingJob.status 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 6. Create new job
    const { data: newJob, error: insertError } = await supabase
      .from('jobs')
      .insert({
        query: query,
        user_id: user_id || null,
        idempotency_key: idempotencyKey,
        status: 'pending',
        retry_count: 0,
        max_retries: 3,
        timeout_seconds: 600, // 10 minutes
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('Insert error:', insertError)
      return new Response(
        JSON.stringify({ error: 'Failed to create job', details: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 7. Return job ID immediately (job will be processed asynchronously)
    return new Response(
      JSON.stringify({ 
        job_id: newJob.id, 
        message: 'Job created successfully',
        status: 'pending'
      }),
      { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Enqueue error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/* 
To test locally:

curl -X POST http://localhost:54321/functions/v1/enqueue \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"query": "weather in Tokyo"}'

Expected response:
{
  "job_id": "abc-123-xyz",
  "message": "Job created successfully", 
  "status": "pending"
}
*/
