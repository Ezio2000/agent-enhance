export interface SearchQuery {
  q: string;
  recency?: number;
  domains?: string[];
}
export interface SearchCommands {
  search_query?: SearchQuery[];
  image_query?: SearchQuery[];
  open?: { ref_id: string; lineno?: number }[];
  click?: { ref_id: string; id: number }[];
  find?: { ref_id: string; pattern: string }[];
  screenshot?: { ref_id: string; pageno: number }[];
  finance?: { ticker: string; type: "equity" | "fund" | "crypto" | "index"; market?: string }[];
  weather?: { location: string; start?: string; duration?: number }[];
  sports?: {
    tool?: "sports";
    fn: "schedule" | "standings";
    league: "nba" | "wnba" | "nfl" | "nhl" | "mlb" | "epl" | "ncaamb" | "ncaawb" | "ipl";
    team?: string;
    opponent?: string;
    date_from?: string;
    date_to?: string;
    num_games?: number;
    locale?: string;
  }[];
  time?: { utc_offset: string }[];
  response_length?: "short" | "medium" | "long";
}
export interface SearchSettings {
  search_context_size?: "low" | "medium" | "high";
  external_web_access?: boolean | "cached" | "indexed" | "live";
  filters?: { allowed_domains?: string[]; blocked_domains?: string[] };
  user_location?: {
    type: "approximate";
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
  image_settings?: { max_results?: number; caption?: boolean };
  allowed_callers?: ["direct"];
}
export interface SearchInputMessage {
  type: "message";
  role: "user" | "assistant";
  content: { type: "input_text" | "output_text"; text: string }[];
}
export interface SearchRequest {
  id: string;
  model: string;
  input?: SearchInputMessage[];
  commands: SearchCommands;
  settings?: SearchSettings;
  max_output_tokens?: number;
}
export interface SearchResponse {
  output: string;
  results?: unknown[] | null;
  encrypted_output?: string | null;
}
