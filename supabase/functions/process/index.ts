// Process Function - Picks up pending jobs, calls external API, handles retries
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Exponential backoff: 10s, 20s, 40s (shorter for testing - originally 1min, 2min, 4min)
function calculateNextRetryTime(retryCount: number): Date {
  const baseDelayMs = 10 * 1000 // 10 seconds for testing (change to 60 * 1000 for production)
  const delayMs = baseDelayMs * Math.pow(2, retryCount)
  return new Date(Date.now() + delayMs)
}

// Generate a unique worker ID for this instance
const WORKER_ID = crypto.randomUUID()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Check for test mode (force failure)
  let forceFail = false
  try {
    const body = await req.json().catch(() => ({}))
    forceFail = body.force_fail === true
  } catch {
    // No body or invalid JSON, that's fine
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    // ============================================
    // STEP 1: Release stuck jobs (timeout detection)
    // ============================================
    const { data: stuckJobs } = await supabase
      .from('jobs')
      .select('id, retry_count, max_retries')
      .eq('status', 'processing')
      .lt('locked_at', new Date(Date.now() - 600 * 1000).toISOString())

    if (stuckJobs && stuckJobs.length > 0) {
      for (const stuckJob of stuckJobs) {
        if (stuckJob.retry_count >= stuckJob.max_retries) {
          await supabase
            .from('jobs')
            .update({
              status: 'dead_letter',
              error_message: 'Job timed out after maximum retries',
              locked_at: null,
              locked_by: null,
              completed_at: new Date().toISOString(),
            })
            .eq('id', stuckJob.id)
          console.log(`Job ${stuckJob.id} moved to dead_letter (timeout)`)
        } else {
          await supabase
            .from('jobs')
            .update({
              status: 'pending',
              error_message: 'Job timed out, will retry',
              retry_count: stuckJob.retry_count + 1,
              next_retry_at: calculateNextRetryTime(stuckJob.retry_count).toISOString(),
              locked_at: null,
              locked_by: null,
            })
            .eq('id', stuckJob.id)
          console.log(`Job ${stuckJob.id} reset to pending for retry`)
        }
      }
    }

    // ============================================
    // STEP 2: Pick up a pending job (with locking)
    // ============================================
    const now = new Date().toISOString()
    
    // Also pick up failed jobs that are ready for retry
    const { data: job, error: pickError } = await supabase
      .from('jobs')
      .select('*')
      .in('status', ['pending', 'failed'])
      .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
      .is('locked_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    if (pickError || !job) {
      return new Response(
        JSON.stringify({ message: 'No pending jobs to process' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Lock the job
    const { error: lockError } = await supabase
      .from('jobs')
      .update({
        status: 'processing',
        locked_at: now,
        locked_by: WORKER_ID,
      })
      .eq('id', job.id)
      .in('status', ['pending', 'failed'])

    if (lockError) {
      return new Response(
        JSON.stringify({ message: 'Failed to lock job, another worker may have claimed it' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Worker ${WORKER_ID} processing job ${job.id}: "${job.query}" (force_fail: ${forceFail})`)

    // ============================================
    // STEP 3: Call the external API
    // ============================================
    try {
      // If force_fail is true, throw an error immediately
      if (forceFail) {
        throw new Error('Forced failure for testing retry mechanism')
      }

      // Using httpbin.org/delay to simulate a slow API (takes 5 seconds)
      const apiResponse = await fetch(`https://httpbin.org/delay/5`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          query: job.query,
          job_id: job.id,
          timestamp: new Date().toISOString()
        }),
      })

      if (!apiResponse.ok) {
        throw new Error(`API returned status ${apiResponse.status}`)
      }

      const apiResult = await apiResponse.json()

      // ============================================
      // STEP 4: Job succeeded
      // ============================================
      await supabase
        .from('jobs')
        .update({
          status: 'completed',
          result: apiResult,
          locked_at: null,
          locked_by: null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)

      console.log(`Job ${job.id} completed successfully`)

      return new Response(
        JSON.stringify({ 
          message: 'Job processed successfully',
          job_id: job.id,
          status: 'completed'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )

    } catch (apiError) {
      // ============================================
      // STEP 5: Job failed - handle retry or dead letter
      // ============================================
      console.error(`Job ${job.id} failed:`, (apiError as Error).message)

      const newRetryCount = job.retry_count + 1

      if (newRetryCount >= job.max_retries) {
        // Max retries reached - move to dead letter queue
        await supabase
          .from('jobs')
          .update({
            status: 'dead_letter',
            error_message: (apiError as Error).message,
            retry_count: newRetryCount,
            locked_at: null,
            locked_by: null,
            completed_at: new Date().toISOString(),
          })
          .eq('id', job.id)

        console.log(`Job ${job.id} moved to dead_letter after ${newRetryCount} attempts`)

        return new Response(
          JSON.stringify({ 
            message: 'Job failed permanently, moved to dead letter queue',
            job_id: job.id,
            status: 'dead_letter',
            attempts: newRetryCount
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )

      } else {
        // Schedule retry with exponential backoff
        const nextRetryAt = calculateNextRetryTime(newRetryCount)

        await supabase
          .from('jobs')
          .update({
            status: 'failed',
            error_message: (apiError as Error).message,
            retry_count: newRetryCount,
            next_retry_at: nextRetryAt.toISOString(),
            locked_at: null,
            locked_by: null,
          })
          .eq('id', job.id)

        console.log(`Job ${job.id} failed, retry #${newRetryCount} scheduled for ${nextRetryAt.toISOString()}`)

        return new Response(
          JSON.stringify({ 
            message: 'Job failed, retry scheduled',
            job_id: job.id,
            status: 'failed',
            retry_count: newRetryCount,
            next_retry_at: nextRetryAt.toISOString()
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

  } catch (error) {
    console.error('Process error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/*
To test:

Normal processing:
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/process \
  -H "Authorization: Bearer YOUR_ANON_KEY"

Force failure (to test retries):
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/process \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"force_fail": true}'
*/
