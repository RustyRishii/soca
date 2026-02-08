// Status Function - Lightweight endpoint to check job status
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Get job_id from query params (GET request) or body (POST request)
    let jobId: string | null = null

    if (req.method === 'GET') {
      const url = new URL(req.url)
      jobId = url.searchParams.get('job_id')
    } else {
      const body = await req.json()
      jobId = body.job_id
    }

    if (!jobId) {
      return new Response(
        JSON.stringify({ error: 'job_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch job status
    const { data: job, error } = await supabase
      .from('jobs')
      .select('id, status, query, result, error_message, retry_count, max_retries, created_at, updated_at, completed_at')
      .eq('id', jobId)
      .single()

    if (error || !job) {
      return new Response(
        JSON.stringify({ error: 'Job not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Return job status with relevant info based on state
    const response: Record<string, unknown> = {
      job_id: job.id,
      status: job.status,
      query: job.query,
      created_at: job.created_at,
      updated_at: job.updated_at,
    }

    // Add result if completed
    if (job.status === 'completed' && job.result) {
      response.result = job.result
      response.completed_at = job.completed_at
    }

    // Add error info if failed or dead_letter
    if (job.status === 'failed' || job.status === 'dead_letter') {
      response.error_message = job.error_message
      response.retry_count = job.retry_count
      response.max_retries = job.max_retries
    }

    // Add retry info if pending (could be a retry)
    if (job.status === 'pending' && job.retry_count > 0) {
      response.retry_count = job.retry_count
      response.max_retries = job.max_retries
    }

    return new Response(
      JSON.stringify(response),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Status error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/*
To test:

GET request:
curl "http://localhost:54321/functions/v1/status?job_id=YOUR_JOB_ID" \
  -H "Authorization: Bearer YOUR_ANON_KEY"

POST request:
curl -X POST http://localhost:54321/functions/v1/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"job_id": "YOUR_JOB_ID"}'
*/
