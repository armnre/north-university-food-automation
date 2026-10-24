declare module 'autocannon' {
  export interface Options {
    url: string;
    method?: string;
    connections?: number;
    amount?: number;
    duration?: number;
    headers?: Record<string, string>;
    body?: string;
    requests?: Array<{
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string;
    }>;
  }

  export interface Histogram {
    average: number;
    p50: number;
    p97_5: number;
    p99: number;
    max: number;
  }

  export interface Result {
    errors: number;
    timeouts: number;
    non2xx: number;
    '2xx': number;
    latency: Histogram;
    requests: Histogram;
  }

  export default function autocannon(opts: Options, cb: (err: Error | null, result: Result) => void): void;
}
