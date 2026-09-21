export interface WebSearchRequest {
  search_query: string;
  search_engine: string;
  search_intent: boolean;
  count: number;
  search_domain_filter?: string;
  search_recency_filter?: string;
  content_size?: string;
  request_id?: string;
}
export interface WebSearchResult {
  title?: string;
  content?: string;
  link?: string;
  media?: string;
  icon?: string;
  refer?: string;
  publish_date?: string;
}
export interface WebSearchResponse {
  id?: string;
  created?: number;
  request_id?: string;
  search_intent?: unknown;
  search_result?: WebSearchResult[];
}
export interface WebReaderRequest {
  url: string;
  timeout?: number;
  no_cache?: boolean;
  return_format?: string;
  retain_images?: boolean;
  no_gfm?: boolean;
  keep_img_data_url?: boolean;
  with_images_summary?: boolean;
  with_links_summary?: boolean;
}
export interface WebReaderResponse {
  id?: string;
  created?: number;
  request_id?: string;
  model?: string;
  reader_result?: {
    content?: string;
    title?: string;
    url?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  };
}
/** Day counts map onto the backend's fixed recency buckets (verified against the tool API docs). */
export function recencyBucket(days: number): string {
  if (days <= 1) return "oneDay";
  if (days <= 7) return "oneWeek";
  if (days <= 31) return "oneMonth";
  if (days <= 366) return "oneYear";
  return "noLimit";
}
