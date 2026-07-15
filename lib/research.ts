import * as cheerio from "cheerio";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  ContactChannels,
  EmailRecord,
  FounderRecord,
  PipelineStage,
  PipelineStageId,
  ResearchResult,
  SourceRecord,
} from "@/lib/types";

type EmitStage = (stage: PipelineStage) => void;

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  sourceType: SourceRecord["sourceType"];
}

interface ScrapeBundle {
  companyName?: string;
  description?: string;
  logo?: string;
  emails: string[];
  founders: FounderRecord[];
  channels: ContactChannels;
  sources: SourceRecord[];
  text: string;
}

interface EnrichmentCandidate {
  email: string;
  source: "Hunter" | "Apollo";
}

const STAGES: Record<PipelineStageId, string> = {
  search: "Searching the web",
  website: "Checking company site",
  profiles: "Reading founder signals",
  enrichment: "Running enrichment fallbacks",
  verification: "Verifying email",
  synthesis: "Building the brief",
};

const EXCLUDED_WEBSITE_HOSTS = [
  "linkedin.com",
  "twitter.com",
  "x.com",
  "crunchbase.com",
  "wellfound.com",
  "angel.co",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "medium.com",
  "substack.com",
  "github.com",
  "producthunt.com",
  "coindesk.com",
  "cointelegraph.com",
  "techcrunch.com",
  "pitchbook.com",
  "tracxn.com",
  "bloomberg.com",
  "reuters.com",
];

const ASIAN_TERMS = [
  "china",
  "chinese",
  "beijing",
  "shanghai",
  "shenzhen",
  "hong kong",
  "singapore",
  "japan",
  "tokyo",
  "korea",
  "seoul",
  "taiwan",
  "vietnam",
  "indonesia",
  "india",
  "bangalore",
  "asia",
  "亚洲",
  "中国",
  "北京",
  "上海",
  "深圳",
  "香港",
  "新加坡",
  "日本",
  "韩国",
];

const CHINA_TERMS = [
  "china",
  "chinese",
  "beijing",
  "shanghai",
  "shenzhen",
  "hangzhou",
  "guangzhou",
  "hong kong",
  "中国",
  "北京",
  "上海",
  "深圳",
  "杭州",
  "广州",
  "香港",
];

const WEB3_TERMS = [
  "web3",
  "blockchain",
  "crypto",
  "defi",
  "nft",
  "dao",
  "token",
  "wallet",
  "protocol",
  "onchain",
  "on-chain",
  "ethereum",
  "solana",
  "bitcoin",
  "layer 2",
  "smart contract",
  "decentralized",
  "区块链",
  "加密",
  "链上",
  "代币",
  "协议",
];

const EMAIL_REGEX =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

const globalCache = globalThis as typeof globalThis & {
  __redResearchCache?: Map<string, ResearchResult>;
};

const cache = globalCache.__redResearchCache ?? new Map<string, ResearchResult>();
globalCache.__redResearchCache = cache;

function stage(
  id: PipelineStageId,
  status: PipelineStage["status"],
  detail?: string,
): PipelineStage {
  return { id, label: STAGES[id], status, detail };
}

function cleanText(value: string | undefined | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function hasCjk(value: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function sourceTypeForUrl(url: string): SourceRecord["sourceType"] {
  const host = safeHost(url);
  if (host.includes("linkedin.com")) return "linkedin";
  if (host === "x.com" || host.endsWith(".x.com") || host.includes("twitter.com"))
    return "x";
  if (host.includes("crunchbase.com")) return "crunchbase";
  if (host.includes("wellfound.com") || host.includes("angel.co"))
    return "wellfound";
  return "search";
}

function safeHost(value: string) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function rootDomain(value: string) {
  const host = safeHost(value);
  return host.replace(/^www\./, "");
}

function absoluteUrl(value: string | undefined, base: string) {
  if (!value) return undefined;
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item).toLowerCase();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function founderKey(name: string) {
  return name
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function mergeFounders(items: FounderRecord[]) {
  const confidenceRank = { low: 1, medium: 2, high: 3 };
  const merged = new Map<string, FounderRecord>();
  for (const founder of items) {
    const key = founderKey(founder.name);
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, founder);
      continue;
    }
    const stronger =
      confidenceRank[founder.confidence] > confidenceRank[existing.confidence]
        ? founder
        : existing;
    merged.set(key, {
      ...existing,
      ...stronger,
      role: stronger.role || existing.role,
      bio: stronger.bio || existing.bio,
      linkedin: founder.linkedin || existing.linkedin,
      x: founder.x || existing.x,
      unverified:
        founder.unverified === true && existing.unverified === true
          ? true
          : undefined,
    });
  }
  return [...merged.values()];
}

function isPrivateIp(address: string) {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd"))
    return true;
  if (address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Unsupported URL protocol");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("Private host rejected");
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Private IP rejected");
    return;
  }
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Private destination rejected");
  }
}

async function safeFetchHtml(initialUrl: string) {
  let current = initialUrl;
  for (let redirect = 0; redirect < 4; redirect += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(9_000),
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; RED-AI-Research/1.0; +https://vercel.app)",
        accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} had no location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Website returned ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error("Destination is not an HTML page");
    }
    return {
      html: (await response.text()).slice(0, 1_600_000),
      finalUrl: current,
    };
  }
  throw new Error("Too many redirects");
}

async function serpRequest(q: string, engine: "google" | "baidu") {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error("SERPAPI_KEY is not configured");
  console.info(`[RED AI] SerpAPI ${engine} query: ${q}`);
  const params = new URLSearchParams({
    api_key: apiKey,
    engine,
    q,
    num: "10",
  });
  if (engine === "google") {
    params.set("hl", hasCjk(q) ? "zh-cn" : "en");
  }
  const response = await fetch(`https://serpapi.com/search.json?${params}`, {
    signal: AbortSignal.timeout(14_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`SerpAPI returned ${response.status}`);
  const payload = (await response.json()) as {
    error?: string;
    organic_results?: Array<{
      title?: string;
      link?: string;
      snippet?: string;
      date?: string;
    }>;
  };
  if (payload.error) throw new Error(payload.error);
  return (payload.organic_results ?? [])
    .filter((item) => item.link)
    .map<SearchHit>((item) => ({
      title: cleanText(item.title) || safeHost(item.link!),
      url: item.link!,
      snippet: cleanText(item.snippet),
      date: item.date,
      sourceType: sourceTypeForUrl(item.link!),
    }));
}

async function searchWeb(query: string) {
  const queries = [
    `"${query}" founder OR co-founder`,
    `"${query}" CEO OR team`,
    `"${query}" official website startup OR project`,
    `site:linkedin.com/in "${query}" founder OR co-founder`,
  ];
  const attempts = await Promise.allSettled(
    queries.map((value) => serpRequest(value, "google")),
  );
  const hits = attempts.flatMap((item) =>
    item.status === "fulfilled" ? item.value : [],
  );
  const errors = attempts.flatMap((item) =>
    item.status === "rejected" ? [String(item.reason?.message ?? item.reason)] : [],
  );

  if (hasCjk(query)) {
    try {
      hits.push(
        ...(await serpRequest(`${query} 创始人 CEO 联系方式 官网 融资`, "baidu")),
      );
    } catch (error) {
      errors.push(`Baidu search: ${errorMessage(error)}`);
    }
  }

  return {
    hits: uniqueBy(hits, (hit) => hit.url).slice(0, 40),
    errors: uniqueBy(errors, (item) => item),
  };
}

function websiteScore(hit: SearchHit, query: string) {
  const host = safeHost(hit.url);
  if (!host || EXCLUDED_WEBSITE_HOSTS.some((excluded) => host.includes(excluded)))
    return -100;
  let score = 0;
  const normalizedQuery = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");
  const hostLabels = host.split(".");
  const hostMatchIndex = hostLabels.findIndex(
    (label) =>
      label.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "") === normalizedQuery,
  );
  const queryTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 2);
  const haystack = `${host} ${hit.title} ${hit.snippet}`.toLowerCase();
  score += queryTokens.filter((token) => haystack.includes(token)).length * 4;
  if (hostMatchIndex === 0) score += 14;
  if (hostMatchIndex > 0) score += 5;
  if (
    hostMatchIndex > 0 &&
    /residency|foundation|careers|jobs|docs|blog/i.test(hostLabels[0])
  )
    score -= 10;
  if (new URL(hit.url).pathname === "/" || new URL(hit.url).pathname === "")
    score += 2;
  if (/official|homepage|welcome|about/i.test(hit.title + hit.snippet)) score += 2;
  if (/funding|news|review|directory|database|profile/i.test(hit.title)) score -= 2;
  return score;
}

function pickWebsite(hits: SearchHit[], query: string) {
  return [...hits].sort(
    (a, b) => websiteScore(b, query) - websiteScore(a, query),
  )[0];
}

function extractEmails($: cheerio.CheerioAPI, text: string) {
  const mailtos = $("a[href^='mailto:']")
    .map((_, element) =>
      ($(element).attr("href") ?? "")
        .replace(/^mailto:/i, "")
        .split("?")[0]
        .trim(),
    )
    .get();
  const visible = text.match(EMAIL_REGEX) ?? [];
  return uniqueBy(
    [...mailtos, ...visible]
      .map((email) => email.toLowerCase())
      .filter(
        (email) =>
          !email.endsWith(".png") &&
          !email.endsWith(".jpg") &&
          !email.includes("example.com") &&
          !email.includes("sentry.io"),
      ),
    (email) => email,
  );
}

function validatePersonName(value: string) {
  const name = cleanText(value).replace(/[|•·—–,:，。]+$/u, "").trim();
  if (name.length < 2 || name.length > 70)
    return { name: "", reason: "name length is outside 2-70 characters" };
  if (/[.,;:!?()[\]{}]/u.test(name))
    return { name: "", reason: "contains sentence punctuation" };
  if (
    /^(our|meet|team|about|company|founder|co-founder|ceo|chief|learn|read|contact|home)$/i.test(
      name,
    )
  )
    return { name: "", reason: "is a common non-name word" };
  if (hasCjk(name)) {
    return /^[\p{Script=Han}·]{2,7}$/u.test(name)
      ? { name, reason: "" }
      : { name: "", reason: "does not match a Chinese personal-name shape" };
  }

  const words = name.split(/\s+/);
  if (words.length > 4)
    return { name: "", reason: "contains more than four words" };
  if (
    words.some(
      (word) =>
        !/^[\p{Lu}][\p{L}'’-]*$/u.test(word) ||
        (word.length > 1 && word === word.toLocaleUpperCase()),
    )
  )
    return { name: "", reason: "contains a non-capitalized or all-caps word" };
  if (/^(?:He|She|It|They|We|I|This|That|These|Those)$/i.test(words[0]))
    return { name: "", reason: "starts with a common sentence word" };
  if (
    /\b(?:said|was|were|is|are|manages?|managed|across|twitter|residency|content|support|through|pitch|program|project|protocol|community|investors?|building|growth|campaigns?)\b/i.test(
      name,
    )
  )
    return { name: "", reason: "contains a prose verb or non-name term" };
  return { name, reason: "" };
}

function cleanPersonName(value: string, context = "unknown source") {
  const result = validatePersonName(value);
  if (!result.name) {
    console.info(
      `[RED AI] Rejected founder candidate (${context}): ${JSON.stringify(value)} - ${result.reason}`,
    );
  }
  return result.name;
}

function extractFoundersFromText(text: string) {
  const founders: FounderRecord[] = [];
  const roleFirst =
    /\b(Founder|founder|Co-founder|co-founder|Chief Executive Officer|chief executive officer|CEO)\b\s*(?:is|:|—|–|-)?\s*([A-Z][\p{L}'’.-]+(?:\s+(?:[A-Z][\p{L}'’.-]+|de|del|van|von|da|di)){1,3})/gu;
  const nameFirst =
    /([A-Z][\p{L}'’.-]+(?:\s+(?:[A-Z][\p{L}'’.-]+|de|del|van|von|da|di)){1,3})\s*(?:,|—|–|-|\bis\b)\s*(Co-founder|co-founder|Founder|founder|Chief Executive Officer|chief executive officer|CEO)\b/gu;
  const chinese =
    /(?:联合创始人|创始人|首席执行官|CEO)\s*(?:是|为|[:：—–-])?\s*([\p{Script=Han}]{2,5})/gu;

  for (const match of text.matchAll(roleFirst)) {
    const name = cleanPersonName(match[2]);
    if (name)
      founders.push({
        name,
        role: titleCaseRole(match[1]),
        confidence: "low",
      });
  }
  for (const match of text.matchAll(nameFirst)) {
    const name = cleanPersonName(match[1]);
    if (name)
      founders.push({
        name,
        role: titleCaseRole(match[2]),
        confidence: "low",
      });
  }
  for (const match of text.matchAll(chinese)) {
    const name = cleanPersonName(match[1]);
    if (name)
      founders.push({ name, role: "Founder / CEO", confidence: "low" });
  }
  return mergeFounders(founders);
}

function titleCaseRole(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "ceo" || normalized.includes("chief executive"))
    return "CEO";
  if (/co[\s-]?founder/.test(normalized)) return "Co-founder";
  return "Founder";
}

function jsonLdFounders($: cheerio.CheerioAPI) {
  const founders: FounderRecord[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      const data = JSON.parse($(element).text()) as unknown;
      const nodes = Array.isArray(data) ? data : [data];
      const visit = (value: unknown, relation = "") => {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const type = String(record["@type"] ?? "");
        const jobTitle = String(record.jobTitle ?? "");
        const name = typeof record.name === "string" ? record.name : "";
        const hasLeadershipRole = /founder|chief executive|ceo/i.test(jobTitle);
        const isFounderRelation = /founder/i.test(relation);
        if (
          name &&
          type.toLowerCase() === "person" &&
          (hasLeadershipRole || isFounderRelation)
        ) {
          const cleanName = cleanPersonName(name);
          if (!cleanName) return;
          founders.push({
            name: cleanName,
            role: hasLeadershipRole
              ? titleCaseRole(jobTitle)
              : isFounderRelation
                ? "Founder"
                : undefined,
            bio:
              typeof record.description === "string"
                ? cleanText(record.description)
                : undefined,
            confidence: "high",
          });
        }
        Object.entries(record).forEach(([key, child]) => visit(child, key));
      };
      nodes.forEach((node) => visit(node));
    } catch {
      // Many sites include malformed JSON-LD. Other extraction paths remain useful.
    }
  });
  return mergeFounders(founders.filter((founder) => founder.name));
}

function scrapePage(html: string, url: string) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  const text = cleanText($("body").text()).slice(0, 180_000);
  const companyName =
    cleanText($("meta[property='og:site_name']").attr("content")) ||
    cleanText($("title").first().text()).split(/\s+[|—–-]\s+/)[0];
  const description =
    cleanText($("meta[name='description']").attr("content")) ||
    cleanText($("meta[property='og:description']").attr("content"));
  const logo = absoluteUrl(
    $("meta[property='og:image']").attr("content") ||
      $("link[rel~='icon']").first().attr("href"),
    url,
  );
  const channels: ContactChannels = {};
  const relevantLinks: string[] = [];

  $("a[href]").each((_, element) => {
    const href = absoluteUrl($(element).attr("href"), url);
    if (!href) return;
    const host = safeHost(href);
    const label = cleanText($(element).text()).toLowerCase();
    if (
      (host === "x.com" || host.endsWith(".x.com") || host.includes("twitter.com")) &&
      !channels.x
    )
      channels.x = href;
    if (host.includes("linkedin.com/company") && !channels.linkedin)
      channels.linkedin = href;
    if (
      /contact|support|get in touch|联系我们|联系/u.test(
        `${label} ${new URL(href).pathname}`,
      ) &&
      !channels.contactForm
    )
      channels.contactForm = href;
    if (
      safeHost(href) === safeHost(url) &&
      /about|team|people|company|contact|leadership|founder|关于|团队|联系/u.test(
        `${label} ${new URL(href).pathname}`,
      )
    )
      relevantLinks.push(href);
  });

  return {
    companyName,
    description,
    logo,
    emails: extractEmails($, text),
    founders: mergeFounders(
      [...jsonLdFounders($), ...extractFoundersFromText(text)],
    ),
    channels,
    text,
    relevantLinks: uniqueBy(relevantLinks, (link) => link).slice(0, 4),
  };
}

async function scrapeWebsite(website: string): Promise<ScrapeBundle> {
  const first = await safeFetchHtml(website);
  const home = scrapePage(first.html, first.finalUrl);
  const bundle: ScrapeBundle = {
    companyName: home.companyName,
    description: home.description,
    logo: home.logo,
    emails: [...home.emails],
    founders: [...home.founders],
    channels: { ...home.channels },
    sources: [
      {
        title: home.companyName || safeHost(first.finalUrl),
        url: first.finalUrl,
        snippet: home.description,
        sourceType: "official",
      },
    ],
    text: home.text,
  };

  const pages = await Promise.allSettled(
    home.relevantLinks.slice(0, 3).map(async (link) => {
      const fetched = await safeFetchHtml(link);
      return { page: scrapePage(fetched.html, fetched.finalUrl), url: fetched.finalUrl };
    }),
  );

  for (const item of pages) {
    if (item.status !== "fulfilled") continue;
    const { page, url } = item.value;
    bundle.emails.push(...page.emails);
    bundle.founders.push(...page.founders);
    bundle.text += ` ${page.text}`;
    bundle.channels.x ||= page.channels.x;
    bundle.channels.linkedin ||= page.channels.linkedin;
    bundle.channels.contactForm ||= page.channels.contactForm;
    bundle.sources.push({
      title: cleanText(new URL(url).pathname.replaceAll("/", " ")) || "Company page",
      url,
      sourceType: "official",
    });
  }

  bundle.emails = uniqueBy(bundle.emails, (email) => email);
  bundle.founders = mergeFounders(bundle.founders);
  bundle.sources = uniqueBy(bundle.sources, (source) => source.url);
  return bundle;
}

function profileTitleName(hit: SearchHit) {
  if (
    hit.sourceType === "linkedin" &&
    !/^\/in\//i.test(new URL(hit.url).pathname)
  )
    return "";
  if (!["linkedin", "x"].includes(hit.sourceType)) return "";

  return cleanText(hit.title)
    .replace(/\s*\(@[^)]+\).*$/u, "")
    .split(/\s+(?:[|—–-])\s+/u)[0]
    .replace(/^(?:Dr|Mr|Mrs|Ms)\.?\s+/i, "")
    .trim();
}

function founderFromProfileHit(hit: SearchHit): FounderRecord | undefined {
  const candidate = profileTitleName(hit);
  if (!candidate) return undefined;
  const name = cleanPersonName(candidate, `${hit.sourceType} search result`);
  if (!name) return undefined;
  const roleMatch = `${hit.title} ${hit.snippet}`.match(
    /\b(co[\s-]?founder|founder|chief executive officer|ceo)\b/i,
  );
  return {
    name,
    role: roleMatch ? titleCaseRole(roleMatch[1]) : undefined,
    linkedin: hit.sourceType === "linkedin" ? hit.url : undefined,
    x: hit.sourceType === "x" ? hit.url : undefined,
    confidence:
      hit.sourceType === "linkedin" && Boolean(roleMatch) ? "medium" : "low",
  };
}

function unverifiedFounderFromProfileHit(
  hit: SearchHit,
): FounderRecord | undefined {
  const candidate = profileTitleName(hit);
  if (!candidate || hasCjk(candidate)) return undefined;
  const words = candidate.split(/\s+/);
  if (
    words.length < 2 ||
    words.length > 4 ||
    words.some((word) => !/^[\p{L}'’-]+$/u.test(word)) ||
    /^(?:he|she|it|they|we|this|that)$/i.test(words[0]) ||
    /\b(?:said|was|were|is|are|manages?|managed|founder|company|team|official)\b/i.test(
      candidate,
    )
  )
    return undefined;

  const titleCased = words
    .map((word) =>
      word
        .split(/([-’'])/u)
        .map((part) =>
          /^[-’']$/u.test(part)
            ? part
            : `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1).toLocaleLowerCase()}`,
        )
        .join(""),
    )
    .join(" ");
  const name = cleanPersonName(titleCased, `${hit.sourceType} fallback result`);
  if (!name) return undefined;
  const roleMatch = `${hit.title} ${hit.snippet}`.match(
    /\b(co[\s-]?founder|founder|chief executive officer|ceo)\b/i,
  );
  return {
    name,
    role: roleMatch ? titleCaseRole(roleMatch[1]) : undefined,
    linkedin: hit.sourceType === "linkedin" ? hit.url : undefined,
    x: hit.sourceType === "x" ? hit.url : undefined,
    confidence: "low",
    unverified: true,
  };
}

function founderSignalsFromHits(hits: SearchHit[]) {
  const profileHits = hits.filter((hit) =>
    ["linkedin", "x", "crunchbase", "wellfound"].includes(hit.sourceType),
  );
  const directProfileFounders = profileHits
    .map(founderFromProfileHit)
    .filter((founder): founder is FounderRecord => Boolean(founder));
  const textFounders = extractFoundersFromText(
    hits.map((hit) => `${hit.title}. ${hit.snippet}`).join(" "),
  ).map((founder) => {
    const matching = profileHits.find((hit) =>
      `${hit.title} ${hit.snippet}`
        .toLowerCase()
        .includes(founder.name.toLowerCase()),
    );
    return {
      ...founder,
      linkedin: matching?.sourceType === "linkedin" ? matching.url : undefined,
      x: matching?.sourceType === "x" ? matching.url : undefined,
    };
  });
  let founders = mergeFounders([...directProfileFounders, ...textFounders]);
  if (!founders.length) {
    founders = mergeFounders(
      profileHits
        .map(unverifiedFounderFromProfileHit)
        .filter((founder): founder is FounderRecord => Boolean(founder)),
    );
  }
  return {
    founders,
    channels: {
      linkedin: profileHits.find((hit) => hit.sourceType === "linkedin")?.url,
      x: profileHits.find((hit) => hit.sourceType === "x")?.url,
    } satisfies ContactChannels,
  };
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || hasCjk(name)) return undefined;
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

async function hunterEnrich(domain: string, founders: FounderRecord[]) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) throw new Error("HUNTER_API_KEY is not configured");
  const domainParams = new URLSearchParams({ domain, api_key: key });
  const response = await fetch(
    `https://api.hunter.io/v2/domain-search?${domainParams}`,
    { signal: AbortSignal.timeout(12_000), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Hunter domain search returned ${response.status}`);
  const payload = (await response.json()) as {
    data?: {
      emails?: Array<{
        value?: string;
        first_name?: string;
        last_name?: string;
        position?: string;
      }>;
    };
    errors?: Array<{ details?: string }>;
  };
  const emails = payload.data?.emails ?? [];
  const founderMatch = emails.find((email) =>
    /founder|chief executive|ceo|owner/i.test(email.position ?? ""),
  );
  if (founderMatch?.value) {
    return { email: founderMatch.value, source: "Hunter" } satisfies EnrichmentCandidate;
  }

  for (const founder of founders.slice(0, 3)) {
    const parts = splitName(founder.name);
    if (!parts) continue;
    const params = new URLSearchParams({
      domain,
      first_name: parts.firstName,
      last_name: parts.lastName,
      api_key: key,
    });
    const finderResponse = await fetch(
      `https://api.hunter.io/v2/email-finder?${params}`,
      { signal: AbortSignal.timeout(12_000), cache: "no-store" },
    );
    if (!finderResponse.ok) continue;
    const finderPayload = (await finderResponse.json()) as {
      data?: { email?: string };
    };
    if (finderPayload.data?.email) {
      return {
        email: finderPayload.data.email,
        source: "Hunter",
      } satisfies EnrichmentCandidate;
    }
  }

  const firstAvailable = emails.find((email) => email.value)?.value;
  return firstAvailable
    ? ({ email: firstAvailable, source: "Hunter" } satisfies EnrichmentCandidate)
    : undefined;
}

async function apolloEnrich(
  domain: string,
  companyName: string,
  founders: FounderRecord[],
) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error("APOLLO_API_KEY is not configured");
  for (const founder of founders.slice(0, 3)) {
    const parts = splitName(founder.name);
    if (!parts) continue;
    const response = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": key,
      },
      body: JSON.stringify({
        first_name: parts.firstName,
        last_name: parts.lastName,
        organization_name: companyName,
        domain,
        reveal_personal_emails: false,
      }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error("Apollo quota is exhausted");
      continue;
    }
    const payload = (await response.json()) as {
      person?: { email?: string; linkedin_url?: string; title?: string };
    };
    if (payload.person?.linkedin_url && !founder.linkedin) {
      founder.linkedin = payload.person.linkedin_url;
    }
    if (payload.person?.email) {
      return {
        email: payload.person.email,
        source: "Apollo",
      } satisfies EnrichmentCandidate;
    }
  }
  return undefined;
}

async function hunterVerify(email: string) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) throw new Error("HUNTER_API_KEY is not configured");
  const params = new URLSearchParams({ email, api_key: key });
  const response = await fetch(
    `https://api.hunter.io/v2/email-verifier?${params}`,
    { signal: AbortSignal.timeout(12_000), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Hunter verifier returned ${response.status}`);
  const payload = (await response.json()) as {
    data?: { status?: string; result?: string; score?: number };
  };
  return ["valid", "deliverable"].includes(
    (payload.data?.status ?? payload.data?.result ?? "").toLowerCase(),
  );
}

function bestScrapedEmail(
  emails: string[],
  founders: FounderRecord[],
): string | undefined {
  const nameTokens = founders
    .flatMap((founder) => founder.name.toLowerCase().split(/\s+/))
    .filter((token) => token.length > 2);
  return [...emails].sort((a, b) => {
    const score = (email: string) => {
      const local = email.split("@")[0];
      let value = nameTokens.some((token) => local.includes(token)) ? 5 : 0;
      if (/^(hello|contact|info|team|press|support|partners)/.test(local)) value += 2;
      if (/noreply|no-reply|privacy|legal|abuse/.test(local)) value -= 8;
      return value;
    };
    return score(b) - score(a);
  })[0];
}

function guessedEmail(domain: string, founder?: FounderRecord) {
  if (!founder) return undefined;
  const parts = splitName(founder.name);
  if (!parts) return undefined;
  const clean = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return `${clean(parts.firstName)}.${clean(parts.lastName)}@${domain}`;
}

function inferSegment(text: string, evidenceCount: number) {
  if (evidenceCount === 0) {
    return {
      value: "Ambiguous" as const,
      reasoning:
        "No public source evidence was available, so RED AI cannot classify this project yet.",
    };
  }
  const normalized = text.toLowerCase();
  const matches = WEB3_TERMS.filter((term) => normalized.includes(term));
  if (matches.length >= 2) {
    return {
      value: "Web3" as const,
      reasoning: `Web3 signals include ${matches.slice(0, 3).join(", ")}.`,
    };
  }
  if (matches.length === 1) {
    return {
      value: "Ambiguous" as const,
      reasoning: `Only one Web3-adjacent signal was found (${matches[0]}), so the classification needs a quick manual check.`,
    };
  }
  return {
    value: "Non-Web3" as const,
    reasoning: "The available description and source snippets do not show crypto or blockchain signals.",
  };
}

function inferRegion(text: string, query: string) {
  const normalized = `${query} ${text}`.toLowerCase();
  const asiaMatch = ASIAN_TERMS.find((term) => normalized.includes(term));
  const chinaMatch = CHINA_TERMS.find((term) => normalized.includes(term));
  if (chinaMatch || hasCjk(query)) {
    return {
      value: "China / Greater China",
      isAsian: true,
      isChinese: true,
      reasoning: `Chinese-language or location signal detected${chinaMatch ? ` (${chinaMatch})` : ""}; local-language follow-up channels may work better.`,
    };
  }
  if (asiaMatch) {
    const labels: Record<string, string> = {
      singapore: "Singapore",
      japan: "Japan",
      tokyo: "Japan",
      korea: "South Korea",
      seoul: "South Korea",
      taiwan: "Taiwan",
      vietnam: "Vietnam",
      indonesia: "Indonesia",
      india: "India",
      bangalore: "India",
    };
    return {
      value: labels[asiaMatch] ?? "Asia",
      isAsian: true,
      isChinese: false,
      reasoning: `An Asia-based location signal was found (${asiaMatch}).`,
    };
  }
  return {
    value: "Not confidently determined",
    isAsian: false,
    isChinese: false,
    reasoning: "No reliable location signal appeared in the available public sources.",
  };
}

function inferFunding(hits: SearchHit[]) {
  const fresh = [...hits].sort((a, b) => Number(Boolean(b.date)) - Number(Boolean(a.date)));
  const signal = fresh.find((hit) =>
    /pre-seed|seed round|series [a-e]|raised|funding|financing|融资|获投|天使轮/i.test(
      `${hit.title} ${hit.snippet}`,
    ),
  );
  if (!signal) return "No funding data found";
  const text = cleanText(`${signal.title} — ${signal.snippet}`);
  return signal.date ? `${text} (${signal.date})` : text;
}

function humanConfidence(
  founders: FounderRecord[],
  email: EmailRecord,
  hasOfficialSite: boolean,
  sourceCount: number,
) {
  if (
    hasOfficialSite &&
    founders.length > 0 &&
    email.status === "Verified" &&
    sourceCount >= 3
  )
    return "High confidence: the company, leadership, and email are supported by an official site plus corroborating sources.";
  if (founders.length > 0 && email.status !== "Not found")
    return "Moderate confidence: the founder signal is plausible and an email was found, but review the cited sources before outreach.";
  if (hasOfficialSite)
    return "Partial confidence: the project identity looks sound, but leadership or direct email evidence is incomplete.";
  return "Low confidence: public evidence is thin or ambiguous, so treat this as a lead for manual follow-up rather than a confirmed record.";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runResearch(
  rawQuery: string,
  emit: EmitStage,
): Promise<ResearchResult> {
  const query = cleanText(rawQuery).slice(0, 160);

  if (!process.env.SERPAPI_KEY) {
    emit(
      stage(
        "search",
        "warning",
        "Search provider is not configured for this deployment",
      ),
    );
    throw new Error(
      "RED AI cannot search yet because SERPAPI_KEY is missing. Add it in Vercel → Project Settings → Environment Variables, then redeploy.",
    );
  }

  const cacheKey = query.toLocaleLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) {
    emit(stage("search", "complete", "Found a session cache match"));
    emit(stage("website", "complete", "Reused previous site findings"));
    emit(stage("profiles", "complete", "Reused previous profile findings"));
    emit(stage("enrichment", "complete", "No provider credits used"));
    emit(stage("verification", "complete", "Reused previous verification"));
    emit(stage("synthesis", "complete", "Brief restored"));
    return { ...cached, cached: true };
  }

  const issues: string[] = [];
  emit(stage("search", "running", "Running English and local-language query variants"));
  const search = await searchWeb(query);
  issues.push(...search.errors.map((message) => `Web search: ${message}`));
  emit(
    stage(
      "search",
      search.hits.length ? "complete" : "warning",
      search.hits.length
        ? `${search.hits.length} public results collected`
        : "No search results were available",
    ),
  );

  const websiteHit = pickWebsite(search.hits, query);
  let scraped: ScrapeBundle | undefined;
  emit(stage("website", "running", "Looking for team, about, contact, and footer details"));
  if (websiteHit && websiteScore(websiteHit, query) > -50) {
    try {
      scraped = await scrapeWebsite(websiteHit.url);
      emit(
        stage(
          "website",
          "complete",
          `${scraped.sources.length} official page${scraped.sources.length === 1 ? "" : "s"} checked`,
        ),
      );
    } catch (error) {
      issues.push(`Company site: ${errorMessage(error)}`);
      emit(stage("website", "warning", "The likely company site could not be fully scraped"));
    }
  } else {
    emit(stage("website", "warning", "No reliable company domain was established"));
  }

  emit(stage("profiles", "running", "Cross-checking founder and social profile evidence"));
  const profileSignals = founderSignalsFromHits(search.hits);
  const founders = mergeFounders(
    [...(scraped?.founders ?? []), ...profileSignals.founders],
  ).slice(0, 8);
  const channels: ContactChannels = {
    x: scraped?.channels.x ?? profileSignals.channels.x,
    linkedin: scraped?.channels.linkedin ?? profileSignals.channels.linkedin,
    contactForm: scraped?.channels.contactForm,
  };
  emit(
    stage(
      "profiles",
      founders.length || channels.x || channels.linkedin ? "complete" : "warning",
      founders.length
        ? `${founders.length} leadership signal${founders.length === 1 ? "" : "s"} found`
        : "No named founder was confidently extracted",
    ),
  );

  const website = scraped?.sources[0]?.url ?? websiteHit?.url;
  const domain = website ? rootDomain(website) : undefined;
  let emailValue: string | undefined = bestScrapedEmail(
    scraped?.emails ?? [],
    founders,
  );
  let emailSource: EmailRecord["source"] = emailValue
    ? "Scraped from site"
    : "Not found";

  emit(stage("enrichment", "running", "Using paid providers only if public scraping came up short"));
  if (!emailValue && domain) {
    let candidate: EnrichmentCandidate | undefined;
    if (process.env.HUNTER_API_KEY) {
      try {
        candidate = await hunterEnrich(domain, founders);
      } catch (error) {
        issues.push(`Hunter: ${errorMessage(error)}`);
      }
    }
    if (!candidate && process.env.APOLLO_API_KEY) {
      try {
        candidate = await apolloEnrich(
          domain,
          scraped?.companyName || query,
          founders,
        );
      } catch (error) {
        issues.push(`Apollo: ${errorMessage(error)}`);
      }
    }
    if (candidate) {
      emailValue = candidate.email;
      emailSource = candidate.source;
    } else {
      emailValue = guessedEmail(domain, founders[0]);
      emailSource = emailValue ? "Pattern-guessed" : "Not found";
    }
  }
  emit(
    stage(
      "enrichment",
      emailValue ? "complete" : "warning",
      emailValue
        ? emailSource === "Scraped from site"
          ? "A public site email was already available"
          : `${emailSource} produced a contact candidate`
        : domain
          ? "No provider returned an email"
          : "Skipped because no reliable domain was found",
    ),
  );

  let emailStatus: EmailRecord["status"] = emailValue ? "Likely" : "Not found";
  emit(stage("verification", "running", "Checking deliverability and source quality"));
  if (emailValue && process.env.HUNTER_API_KEY) {
    try {
      emailStatus = (await hunterVerify(emailValue)) ? "Verified" : "Likely";
      emit(
        stage(
          "verification",
          "complete",
          emailStatus === "Verified"
            ? "Hunter marked this address deliverable"
            : "Address remains plausible but unverified",
        ),
      );
    } catch (error) {
      issues.push(`Email verification: ${errorMessage(error)}`);
      emit(stage("verification", "warning", "Verification was unavailable; marked Likely"));
    }
  } else if (emailValue) {
    emit(
      stage(
        "verification",
        "complete",
        "Hunter is optional and not configured; email remains marked Likely",
      ),
    );
  } else {
    emit(stage("verification", "warning", "No email candidate to verify"));
  }

  emit(stage("synthesis", "running", "Ranking fresh evidence and writing the confidence note"));
  const sourceRecords: SourceRecord[] = uniqueBy(
    [
      ...(scraped?.sources ?? []),
      ...search.hits.slice(0, 10).map<SourceRecord>((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        sourceType: hit.sourceType,
      })),
    ],
    (source) => source.url,
  ).slice(0, 12);
  const evidenceText = [
    query,
    scraped?.description,
    scraped?.text,
    ...search.hits.map((hit) => `${hit.title} ${hit.snippet}`),
  ]
    .filter(Boolean)
    .join(" ");
  const email: EmailRecord = {
    value: emailValue,
    status: emailStatus,
    source: emailSource,
  };
  const result: ResearchResult = {
    query,
    searchedAt: new Date().toISOString(),
    cached: false,
    company: {
      name: scraped?.companyName || search.hits[0]?.title || query,
      description:
        scraped?.description ||
        search.hits.find((hit) => hit.snippet)?.snippet ||
        "No reliable one-line company description was found.",
      website,
      domain,
      logo: scraped?.logo,
    },
    segment: inferSegment(evidenceText, sourceRecords.length),
    region: inferRegion(evidenceText, query),
    founders,
    email,
    channels,
    fundingSignal: inferFunding(search.hits),
    confidenceNote: humanConfidence(
      founders,
      email,
      Boolean(scraped),
      sourceRecords.length,
    ),
    sources: sourceRecords,
    issues: uniqueBy(issues, (item) => item),
  };

  cache.set(cacheKey, result);
  if (cache.size > 100) cache.delete(cache.keys().next().value as string);
  emit(stage("synthesis", "complete", "Research brief ready"));
  return result;
}
