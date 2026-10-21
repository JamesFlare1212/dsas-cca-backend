export class Metrics {
  requests = 0;
  upstreamFetches = 0;
  upstreamFailures = 0;
  cacheHits = 0;
  cacheMisses = 0;
  staleResponses = 0;
  jobsCompleted = 0;
  jobFailures = 0;

  render(queueSize: number): string {
    const counters: Record<string, number> = {
      http_requests_total: this.requests,
      upstream_fetches_total: this.upstreamFetches,
      upstream_failures_total: this.upstreamFailures,
      cache_hits_total: this.cacheHits,
      cache_misses_total: this.cacheMisses,
      cache_stale_responses_total: this.staleResponses,
      background_jobs_completed_total: this.jobsCompleted,
      background_jobs_failed_total: this.jobFailures,
    };
    return `${Object.entries(counters)
      .map(([key, value]) => `# TYPE dsas_${key} counter\ndsas_${key} ${value}`)
      .join('\n')}\n# TYPE dsas_fetch_queue_size gauge\ndsas_fetch_queue_size ${queueSize}\n`;
  }
}
