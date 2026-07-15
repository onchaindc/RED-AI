export type PipelineStageId =
  | "search"
  | "website"
  | "profiles"
  | "enrichment"
  | "verification"
  | "synthesis";

export type PipelineStageStatus = "pending" | "running" | "complete" | "warning";

export interface PipelineStage {
  id: PipelineStageId;
  label: string;
  detail?: string;
  status: PipelineStageStatus;
}

export interface SourceRecord {
  title: string;
  url: string;
  snippet?: string;
  sourceType:
    | "official"
    | "search"
    | "linkedin"
    | "x"
    | "crunchbase"
    | "wellfound"
    | "hunter"
    | "apollo";
}

export interface FounderRecord {
  name: string;
  role: string;
  bio?: string;
  linkedin?: string;
  x?: string;
  confidence: "high" | "medium" | "low";
}

export interface ContactChannels {
  x?: string;
  linkedin?: string;
  contactForm?: string;
}

export interface EmailRecord {
  value?: string;
  status: "Verified" | "Likely" | "Not found";
  source:
    | "Scraped from site"
    | "Hunter"
    | "Apollo"
    | "Pattern-guessed"
    | "Not found";
}

export interface ResearchResult {
  query: string;
  searchedAt: string;
  cached: boolean;
  company: {
    name: string;
    description: string;
    website?: string;
    domain?: string;
    logo?: string;
  };
  segment: {
    value: "Web3" | "Non-Web3" | "Ambiguous";
    reasoning: string;
  };
  region: {
    value: string;
    isAsian: boolean;
    isChinese: boolean;
    reasoning: string;
  };
  founders: FounderRecord[];
  email: EmailRecord;
  channels: ContactChannels;
  fundingSignal: string;
  confidenceNote: string;
  sources: SourceRecord[];
  issues: string[];
}

export type SearchEvent =
  | { type: "stage"; stage: PipelineStage }
  | { type: "result"; result: ResearchResult }
  | { type: "fatal"; message: string };
