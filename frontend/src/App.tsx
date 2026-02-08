import { useState, useEffect, useCallback } from 'react'

// ⚠️ REPLACE THESE WITH YOUR ACTUAL VALUES
const SUPABASE_URL = 'https://iasghievdtryrrvayjph.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhc2doaWV2ZHRyeXJydmF5anBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0NzU0OTYsImV4cCI6MjA4NjA1MTQ5Nn0.uuXFJ5Mum3OHrTKm9C2URDktEPTvpSPSUPLqTuDFwoA' // Get from Dashboard > Settings > API

interface JobStatus {
  job_id: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter'
  query: string
  result?: Record<string, unknown>
  error_message?: string
  retry_count?: number
  max_retries?: number
  created_at: string
  updated_at: string
  completed_at?: string
}

function App() {
  const [query, setQuery] = useState('')
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)

  const fetchStatus = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/status?job_id=${jobId}`, {
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      })
      const data = await response.json()
      setJobStatus(data)
      return data
    } catch (error) {
      console.error('Status fetch error:', error)
      return null
    }
  }, [])

  // Polling effect
  useEffect(() => {
    if (!jobStatus?.job_id) return
    if (['completed', 'dead_letter'].includes(jobStatus.status)) return

    const interval = setInterval(() => {
      fetchStatus(jobStatus.job_id)
    }, 3000)

    return () => clearInterval(interval)
  }, [jobStatus?.job_id, jobStatus?.status, fetchStatus])

  const enqueueJob = async () => {
    if (!query.trim()) {
      alert('Please enter a search query')
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/enqueue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({ query: query.trim() })
      })

      const data = await response.json()

      if (data.error) {
        alert('Error: ' + data.error)
        return
      }

      setJobStatus({
        job_id: data.job_id,
        status: data.status,
        query: query.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })

    } catch (error) {
      alert('Failed to create job: ' + (error as Error).message)
    } finally {
      setIsLoading(false)
    }
  }

  const processJob = async () => {
    setIsProcessing(true)
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/process`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      })

      // Fetch updated status after a short delay
      if (jobStatus?.job_id) {
        setTimeout(() => fetchStatus(jobStatus.job_id), 1000)
      }
    } catch (error) {
      console.error('Process error:', error)
    } finally {
      setIsProcessing(false)
    }
  }

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
      processing: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      completed: 'bg-green-500/20 text-green-400 border-green-500/30',
      failed: 'bg-red-500/20 text-red-400 border-red-500/30',
      dead_letter: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
    }
    return colors[status] || colors.pending
  }

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString()
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">
            🚀 Job Queue Demo
          </h1>
          <p className="text-slate-400">
            Supabase Edge Functions + Postgres
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-white/5 backdrop-blur-xl rounded-3xl p-8 border border-white/10 shadow-2xl">
          {/* Search Box */}
          <div className="flex gap-4 mb-8">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && enqueueJob()}
              placeholder="Enter search query (e.g., weather in Tokyo)"
              className="flex-1 px-5 py-4 bg-white/5 border-2 border-white/10 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 focus:bg-purple-500/10 transition-all"
            />
            <button
              onClick={enqueueJob}
              disabled={isLoading}
              className="px-8 py-4 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl text-white font-semibold hover:from-purple-500 hover:to-indigo-500 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-purple-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Creating...
                </span>
              ) : 'Search'}
            </button>
          </div>

          {/* Status Card */}
          {jobStatus && (
            <div className="bg-white/5 rounded-2xl p-6 border border-white/5 animate-in fade-in slide-in-from-bottom-4 duration-300">
              {/* Header with Status Badge */}
              <div className="flex items-center justify-between mb-6">
                <span className={`px-4 py-2 rounded-full text-sm font-semibold uppercase tracking-wide border ${getStatusColor(jobStatus.status)}`}>
                  {jobStatus.status}
                  {jobStatus.status === 'processing' && (
                    <span className="ml-2 inline-block w-2 h-2 bg-current rounded-full animate-pulse" />
                  )}
                </span>
                <span className="text-slate-500 text-sm font-mono">
                  {jobStatus.job_id.slice(0, 8)}...
                </span>
              </div>

              {/* Info Grid */}
              <div className="space-y-3">
                <div className="flex justify-between py-3 px-4 bg-white/5 rounded-lg">
                  <span className="text-slate-400">Query</span>
                  <span className="text-white font-medium">{jobStatus.query}</span>
                </div>
                <div className="flex justify-between py-3 px-4 bg-white/5 rounded-lg">
                  <span className="text-slate-400">Created</span>
                  <span className="text-white font-medium">{formatTime(jobStatus.created_at)}</span>
                </div>
                <div className="flex justify-between py-3 px-4 bg-white/5 rounded-lg">
                  <span className="text-slate-400">Updated</span>
                  <span className="text-white font-medium">{formatTime(jobStatus.updated_at)}</span>
                </div>
                {jobStatus.retry_count !== undefined && jobStatus.retry_count > 0 && (
                  <div className="flex justify-between py-3 px-4 bg-white/5 rounded-lg">
                    <span className="text-slate-400">Retries</span>
                    <span className="text-orange-400 font-medium">
                      {jobStatus.retry_count} / {jobStatus.max_retries}
                    </span>
                  </div>
                )}
              </div>

              {/* Result */}
              {jobStatus.status === 'completed' && jobStatus.result && (
                <div className="mt-6 p-4 bg-green-500/10 rounded-xl border border-green-500/20">
                  <h4 className="text-green-400 font-semibold mb-3 flex items-center gap-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Result
                  </h4>
                  <pre className="text-slate-300 text-sm overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(jobStatus.result, null, 2)}
                  </pre>
                </div>
              )}

              {/* Error */}
              {['failed', 'dead_letter'].includes(jobStatus.status) && jobStatus.error_message && (
                <div className="mt-6 p-4 bg-red-500/10 rounded-xl border border-red-500/20">
                  <h4 className="text-red-400 font-semibold mb-2 flex items-center gap-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Error
                  </h4>
                  <p className="text-slate-300">{jobStatus.error_message}</p>
                </div>
              )}

              {/* Process Button */}
              {['pending', 'failed'].includes(jobStatus.status) && (
                <button
                  onClick={processJob}
                  disabled={isProcessing}
                  className="mt-6 w-full py-4 bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl text-white font-semibold hover:from-emerald-500 hover:to-teal-500 hover:shadow-lg hover:shadow-emerald-500/25 transition-all disabled:opacity-50"
                >
                  {isProcessing ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Processing...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      ⚡ Process Job Now
                    </span>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Instructions */}
          <div className="mt-8 p-4 bg-purple-500/10 rounded-xl border border-purple-500/20">
            <h4 className="text-purple-400 font-semibold mb-2">📋 How it works:</h4>
            <ol className="text-slate-400 text-sm space-y-1 list-decimal list-inside">
              <li>Enter a search query and click Search</li>
              <li>A job is created instantly (status: pending)</li>
              <li>Click "Process Job" to run the background task</li>
              <li>Watch the status update to "completed"!</li>
            </ol>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-slate-500 text-sm mt-6">
          Job Queue System • Supabase + Edge Functions
        </p>
      </div>
    </div>
  )
}

export default App
