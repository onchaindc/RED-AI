"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  ExternalLink,
  Globe2,
  Linkedin,
  LoaderCircle,
  Mail,
  MapPin,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  PipelineStage,
  PipelineStageId,
  ResearchResult,
  SearchEvent,
} from "@/lib/types";

const INITIAL_STAGES: PipelineStage[] = [
  { id: "search", label: "Searching the web", status: "pending" },
  { id: "website", label: "Checking company site", status: "pending" },
  { id: "profiles", label: "Reading founder signals", status: "pending" },
  { id: "enrichment", label: "Running enrichment fallbacks", status: "pending" },
  { id: "verification", label: "Verifying email", status: "pending" },
  { id: "synthesis", label: "Building the brief", status: "pending" },
];

interface HistoryEntry {
  query: string;
  companyName: string;
  searchedAt: string;
}

const HISTORY_KEY = "red-ai-search-history";

function host(value?: string) {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function readableDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [stages, setStages] = useState(INITIAL_STAGES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(HISTORY_KEY);
      if (stored) setHistory(JSON.parse(stored) as HistoryEntry[]);
    } catch {
      // Session history is a convenience; a blocked storage API should not affect search.
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const currentStage = useMemo(
    () => stages.find((item) => item.status === "running"),
    [stages],
  );

  function updateHistory(nextResult: ResearchResult) {
    const next = [
      {
        query: nextResult.query,
        companyName: nextResult.company.name,
        searchedAt: nextResult.searchedAt,
      },
      ...history.filter(
        (item) => item.query.toLowerCase() !== nextResult.query.toLowerCase(),
      ),
    ].slice(0, 8);
    setHistory(next);
    try {
      window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // Keep the in-memory list even if sessionStorage is unavailable.
    }
  }

  async function runSearch(nextQuery?: string) {
    const value = (nextQuery ?? query).trim();
    if (value.length < 2 || loading) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setQuery(value);
    setLoading(true);
    setError("");
    setResult(null);
    setStages(INITIAL_STAGES.map((item) => ({ ...item })));
    setMobileMenuOpen(false);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: value }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error || `Search returned ${response.status}`);
      }
      if (!response.body) throw new Error("The search stream did not start.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as SearchEvent;
          if (event.type === "stage") {
            setStages((items) =>
              items.map((item) =>
                item.id === event.stage.id ? event.stage : item,
              ),
            );
          } else if (event.type === "result") {
            setResult(event.result);
            updateHistory(event.result);
          } else {
            throw new Error(event.message);
          }
        }
      }
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") {
        setError(
          caught instanceof Error
            ? caught.message
            : "Something interrupted the research pipeline.",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void runSearch();
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <button
            className="brand"
            onClick={() => {
              setResult(null);
              setQuery("");
              setError("");
            }}
            aria-label="RED AI home"
          >
            <span className="brand-mark">R</span>
            <span>
              <strong>RED AI</strong>
              <small>Founder intelligence</small>
            </span>
          </button>
          <button
            className="icon-button sidebar-close"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="nav-section" aria-label="Primary navigation">
          <button className="nav-item nav-item-active">
            <Search size={16} />
            Research
          </button>
        </nav>

        <div className="history-section">
          <div className="section-kicker">
            <span>Recent searches</span>
            <span>{history.length}</span>
          </div>
          <div className="history-list">
            {history.length === 0 ? (
              <p className="history-empty">
                Your searches will stay here for this session.
              </p>
            ) : (
              history.map((item) => (
                <button
                  key={`${item.query}-${item.searchedAt}`}
                  className="history-item"
                  onClick={() => void runSearch(item.query)}
                  disabled={loading}
                >
                  <span className="history-icon">
                    <Clock3 size={14} />
                  </span>
                  <span>
                    <strong>{item.companyName}</strong>
                    <small>{item.query}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-foot">
          <div className="privacy-note">
            <ShieldCheck size={16} />
            <span>
              <strong>Research only</strong>
              <small>No outreach or data storage</small>
            </span>
          </div>
          <div className="version-row">
            <span className="status-dot" />
            Server-side pipeline
            <span>v1.0</span>
          </div>
        </div>
      </aside>

      {mobileMenuOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <main className="main">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={19} />
          </button>
          <form className="search-form" onSubmit={onSubmit}>
            <Search size={19} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search a project, company, or founder..."
              aria-label="Search a project, company, or founder"
              autoComplete="off"
            />
            <span className="shortcut">⌘ K</span>
            <button
              className="search-button"
              type="submit"
              disabled={loading || query.trim().length < 2}
            >
              {loading ? <LoaderCircle className="spin" size={17} /> : "Research"}
            </button>
          </form>
          <div className="topbar-meta">
            <span className="live-dot" />
            Live research
          </div>
        </header>

        <div className="content">
          {!loading && !result && !error && (
            <EmptyState onExample={(value) => void runSearch(value)} />
          )}

          {loading && (
            <LoadingState
              query={query}
              stages={stages}
              currentStage={currentStage}
              onCancel={() => controllerRef.current?.abort()}
            />
          )}

          {error && !loading && (
            <ErrorState message={error} onRetry={() => void runSearch()} />
          )}

          {result && !loading && (
            <ResultView result={result} onRefresh={() => void runSearch()} />
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyState({ onExample }: { onExample: (value: string) => void }) {
  return (
    <section className="empty-state">
      <div className="eyebrow">
        <Sparkles size={14} />
        Multi-source company research
      </div>
      <h1>
        Find the people
        <br />
        behind the project.
      </h1>
      <p className="empty-lead">
        One search turns scattered public signals into a practical founder
        brief—identity, contact routes, stage, region, and confidence included.
      </p>
      <div className="example-row">
        <span>Try a search</span>
        {["Domus Protocol", "Jane Wu", "月之暗面"].map((example) => (
          <button key={example} onClick={() => onExample(example)}>
            {example}
            <ArrowUpRight size={13} />
          </button>
        ))}
      </div>

      <div className="capability-grid">
        <article>
          <div className="capability-icon">
            <Globe2 size={19} />
          </div>
          <div>
            <strong>Broad source coverage</strong>
            <p>Official sites, search, profiles, and funding signals.</p>
          </div>
        </article>
        <article>
          <div className="capability-icon">
            <span className="han">文</span>
          </div>
          <div>
            <strong>Asia-aware research</strong>
            <p>Chinese query variants and Baidu-backed discovery.</p>
          </div>
        </article>
        <article>
          <div className="capability-icon">
            <ShieldCheck size={19} />
          </div>
          <div>
            <strong>Evidence, not magic</strong>
            <p>Every email has a status, source, and confidence note.</p>
          </div>
        </article>
      </div>

      <div className="pipeline-preview">
        <div className="pipeline-title">
          <span>Research pipeline</span>
          <small>Scraping first · enrichment only when needed</small>
        </div>
        <div className="pipeline-track">
          {[
            ["01", "Web search"],
            ["02", "Official site"],
            ["03", "Founder signals"],
            ["04", "Email verify"],
          ].map(([number, label], index) => (
            <div className="pipeline-step" key={number}>
              <span>{number}</span>
              <strong>{label}</strong>
              {index < 3 && <ChevronRight size={15} />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LoadingState({
  query,
  stages,
  currentStage,
  onCancel,
}: {
  query: string;
  stages: PipelineStage[];
  currentStage?: PipelineStage;
  onCancel: () => void;
}) {
  const complete = stages.filter((item) => item.status === "complete").length;
  const progress = Math.max(8, Math.round((complete / stages.length) * 100));
  return (
    <section className="loading-wrap">
      <div className="loading-heading">
        <div>
          <div className="eyebrow">
            <span className="live-dot" />
            Research in progress
          </div>
          <h1>
            Building a brief on <span>{query}</span>
          </h1>
          <p>
            {currentStage?.detail ||
              "Starting the public-source research pipeline..."}
          </p>
        </div>
        <button className="text-button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className="loading-card">
        <div className="progress-head">
          <span>Pipeline progress</span>
          <strong>{progress}%</strong>
        </div>
        <div className="progress-track">
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="stage-list">
          {stages.map((item) => (
            <div className={`stage-row stage-${item.status}`} key={item.id}>
              <span className="stage-state">
                {item.status === "running" ? (
                  <LoaderCircle className="spin" size={17} />
                ) : item.status === "complete" ? (
                  <Check size={16} />
                ) : item.status === "warning" ? (
                  <AlertTriangle size={15} />
                ) : (
                  <Circle size={10} />
                )}
              </span>
              <span className="stage-copy">
                <strong>{item.label}</strong>
                <small>{item.detail || "Waiting"}</small>
              </span>
              {item.status === "running" && <span className="running-tag">Now</span>}
            </div>
          ))}
        </div>
      </div>

      <p className="loading-footnote">
        RED keeps partial findings if a provider fails or reaches its quota.
      </p>
    </section>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className="error-state">
      <div className="error-icon">
        <AlertTriangle size={22} />
      </div>
      <h1>The research run was interrupted.</h1>
      <p>{message}</p>
      <button className="primary-action" onClick={onRetry}>
        <RefreshCw size={16} />
        Try again
      </button>
    </section>
  );
}

function ResultView({
  result,
  onRefresh,
}: {
  result: ResearchResult;
  onRefresh: () => void;
}) {
  return (
    <section className="result-wrap">
      <div className="result-toolbar">
        <div>
          <div className="eyebrow">
            <CheckCircle2 size={14} />
            Research complete
            {result.cached && <span className="cache-tag">Cache hit</span>}
          </div>
          <p>
            Searched {readableDate(result.searchedAt)} · {result.sources.length}{" "}
            sources retained
          </p>
        </div>
        <button className="secondary-action" onClick={onRefresh}>
          <RefreshCw size={15} />
          Run again
        </button>
      </div>

      <article className="result-card">
        <header className="company-header">
          <div className="company-identity">
            <div className="company-logo">
              {result.company.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={result.company.logo}
                  alt=""
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              ) : (
                <span>{result.company.name.slice(0, 1).toUpperCase()}</span>
              )}
            </div>
            <div>
              <div className="company-name-row">
                <h1>{result.company.name}</h1>
                {result.region.isChinese && <span className="china-tag">CN</span>}
              </div>
              <p>{result.company.description}</p>
              {result.company.website && (
                <a
                  className="website-link"
                  href={result.company.website}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Globe2 size={14} />
                  {host(result.company.website)}
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
          <div className={`segment-badge segment-${result.segment.value.toLowerCase()}`}>
            {result.segment.value}
          </div>
        </header>

        <div className="signal-strip">
          <div>
            <Building2 size={17} />
            <span>
              <small>Segment</small>
              <strong>{result.segment.value}</strong>
            </span>
          </div>
          <div>
            <MapPin size={17} />
            <span>
              <small>Region / origin</small>
              <strong>{result.region.value}</strong>
            </span>
          </div>
          <div>
            <Sparkles size={17} />
            <span>
              <small>Stage signal</small>
              <strong>{result.fundingSignal}</strong>
            </span>
          </div>
        </div>

        <div className="result-grid">
          <section className="detail-section founder-section">
            <SectionTitle
              icon={<Users size={17} />}
              title="Leadership"
              meta={
                result.founders.length
                  ? `${result.founders.length} found`
                  : "No names found"
              }
            />
            {result.founders.length ? (
              <div className="founder-list">
                {result.founders.map((founder) => (
                  <div className="founder-row" key={`${founder.name}-${founder.role}`}>
                    <span className="avatar">
                      {founder.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="founder-copy">
                      <strong>{founder.name}</strong>
                      <small>{founder.role}</small>
                    </span>
                    <span className={`confidence-dot confidence-${founder.confidence}`}>
                      {founder.confidence}
                    </span>
                    <span className="founder-links">
                      {founder.linkedin && (
                        <a
                          href={founder.linkedin}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`${founder.name} on LinkedIn`}
                        >
                          <Linkedin size={15} />
                        </a>
                      )}
                      {founder.x && (
                        <a
                          href={founder.x}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`${founder.name} on X`}
                        >
                          𝕏
                        </a>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <MissingField>
                No founder or CEO was named strongly enough across the available
                sources.
              </MissingField>
            )}
          </section>

          <section className="detail-section email-section">
            <SectionTitle
              icon={<Mail size={17} />}
              title="Best email"
              meta={result.email.source}
            />
            {result.email.value ? (
              <div className="email-card">
                <div className="email-main">
                  <a href={`mailto:${result.email.value}`}>{result.email.value}</a>
                  <StatusTag status={result.email.status} />
                </div>
                <div className="email-meta">
                  <span>Source</span>
                  <strong>{result.email.source}</strong>
                </div>
              </div>
            ) : (
              <div className="email-card email-missing">
                <div className="email-main">
                  <strong>Email not found</strong>
                  <StatusTag status="Not found" />
                </div>
                <p>
                  Use an alternative public channel below or verify manually.
                </p>
              </div>
            )}
          </section>
        </div>

        <section className="detail-section contact-section">
          <SectionTitle
            icon={<ArrowUpRight size={17} />}
            title="Alternative contact routes"
            meta="Public channels"
          />
          <div className="contact-grid">
            <ContactLink
              label="X / Twitter"
              value={result.channels.x}
              icon={<span className="x-icon">𝕏</span>}
            />
            <ContactLink
              label="LinkedIn"
              value={result.channels.linkedin}
              icon={<Linkedin size={17} />}
            />
            <ContactLink
              label="Contact page"
              value={result.channels.contactForm}
              icon={<Globe2 size={17} />}
            />
          </div>
        </section>

        <section className="confidence-panel">
          <div className="confidence-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <span>Confidence note</span>
            <p>{result.confidenceNote}</p>
          </div>
        </section>

        <div className="reason-grid">
          <section>
            <span>Segment reasoning</span>
            <p>{result.segment.reasoning}</p>
          </section>
          <section>
            <span>Regional reasoning</span>
            <p>{result.region.reasoning}</p>
          </section>
        </div>
      </article>

      <div className="lower-grid">
        <section className="sources-card">
          <div className="card-heading">
            <div>
              <span>Evidence trail</span>
              <h2>Sources reviewed</h2>
            </div>
            <small>{result.sources.length} retained</small>
          </div>
          <div className="source-list">
            {result.sources.length ? (
              result.sources.map((source) => (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="source-row"
                  key={source.url}
                >
                  <span className={`source-icon source-${source.sourceType}`}>
                    {source.sourceType === "linkedin" ? (
                      <Linkedin size={14} />
                    ) : source.sourceType === "x" ? (
                      "𝕏"
                    ) : source.sourceType === "official" ? (
                      <Building2 size={14} />
                    ) : (
                      <Globe2 size={14} />
                    )}
                  </span>
                  <span>
                    <strong>{source.title}</strong>
                    <small>{host(source.url)}</small>
                  </span>
                  <ExternalLink size={14} />
                </a>
              ))
            ) : (
              <MissingField>No usable sources were retained.</MissingField>
            )}
          </div>
        </section>

        <section className="issues-card">
          <div className="card-heading">
            <div>
              <span>Pipeline health</span>
              <h2>Step notes</h2>
            </div>
            <small>{result.issues.length} warnings</small>
          </div>
          {result.issues.length ? (
            <div className="issue-list">
              {result.issues.map((issue) => (
                <div key={issue}>
                  <AlertTriangle size={15} />
                  <p>{issue}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="all-clear">
              <CheckCircle2 size={19} />
              <div>
                <strong>All configured steps completed</strong>
                <p>No provider or scraping warnings were reported.</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function SectionTitle({
  icon,
  title,
  meta,
}: {
  icon: React.ReactNode;
  title: string;
  meta: string;
}) {
  return (
    <div className="section-title">
      <span className="section-title-icon">{icon}</span>
      <strong>{title}</strong>
      <small>{meta}</small>
    </div>
  );
}

function StatusTag({
  status,
}: {
  status: "Verified" | "Likely" | "Not found";
}) {
  return (
    <span className={`status-tag status-${status.toLowerCase().replace(" ", "-")}`}>
      {status === "Verified" && <Check size={12} />}
      {status}
    </span>
  );
}

function ContactLink({
  label,
  value,
  icon,
}: {
  label: string;
  value?: string;
  icon: React.ReactNode;
}) {
  if (!value) {
    return (
      <div className="contact-link contact-link-missing">
        <span>{icon}</span>
        <span>
          <small>{label}</small>
          <strong>Not found</strong>
        </span>
      </div>
    );
  }
  return (
    <a href={value} target="_blank" rel="noreferrer" className="contact-link">
      <span>{icon}</span>
      <span>
        <small>{label}</small>
        <strong>{host(value)}</strong>
      </span>
      <ExternalLink size={14} />
    </a>
  );
}

function MissingField({ children }: { children: React.ReactNode }) {
  return (
    <div className="missing-field">
      <Circle size={9} />
      <p>{children}</p>
    </div>
  );
}
