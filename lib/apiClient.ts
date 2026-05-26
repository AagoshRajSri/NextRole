import { CONFIG } from './config';

export class ApiClient {
  private userId: string;
  private baseUrl: string;
  
  constructor(userId: string, baseUrl = CONFIG.API_BASE_URL) {
    this.userId = userId;
    this.baseUrl = baseUrl;
  }
  
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeout?: number, retries?: number } = {}
  ): Promise<{ data: T | null, error: string | null, offline: boolean }> {
    const { timeout = 10000, retries = 1 } = options;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': this.userId,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (response.status === 409) {
          // Duplicate — not an error
          return { data: null, error: null, offline: false };
        }
        
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Unknown error' }));
          return { data: null, error: err.error || `HTTP ${response.status}`, offline: false };
        }
        
        const data = await response.json();
        return { data, error: null, offline: false };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          if (attempt === retries) return { data: null, error: 'Request timeout', offline: false };
          continue;
        }
        if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) {
          return { data: null, error: null, offline: true };  // offline, not an error
        }
        if (attempt === retries) {
          return { data: null, error: err.message, offline: false };
        }
      }
    }
    return { data: null, error: 'Max retries exceeded', offline: false };
  }
  
  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body: unknown) { return this.request<T>('POST', path, body); }
  patch<T>(path: string, body: unknown) { return this.request<T>('PATCH', path, body); }
  delete<T>(path: string) { return this.request<T>('DELETE', path); }
}
