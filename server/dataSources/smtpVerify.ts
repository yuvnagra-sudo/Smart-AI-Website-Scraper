/**
 * SMTP Handshake Email Verification
 *
 * Probes email addresses via SMTP RCPT TO to check if they're deliverable.
 * Uses Google DNS-over-HTTPS for MX lookups (Node.js dns.resolveMx() fails
 * on Railway and many containerized environments due to blocked port 53).
 *
 * Cost: Free (no external API for SMTP; Google DoH is free and unlimited).
 * Timeout: ~6s connect + 12s conversation per domain.
 *
 * Catch-all detection: probes 3 random gibberish addresses. If ALL 3 are
 * accepted (250), the domain is a catch-all and we can't trust RCPT TO.
 */

import * as net from "net";
import * as dns from "dns/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SMTP_PORTS = [25, 587, 465];
const CONNECT_TIMEOUT_MS = 6_000;
const CONVERSATION_TIMEOUT_MS = 12_000;

// Only prefixes that actually convert for outreach — ranked by effectiveness.
const GENERIC_PREFIXES = [
  "info",
  "hello",
  "contact",
  "office",
  "admin",
  "team",
  "general",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmtpVerifyResult {
  email: string;
  catchAll: boolean;
  mxHost: string;
  port: number;
}

export interface FieldResult {
  value: string;
  confidence: number;
  sourceUrl?: string;
}

// ---------------------------------------------------------------------------
// DNS MX Lookup — Google DoH with Node.js dns fallback
// ---------------------------------------------------------------------------

/**
 * Resolve MX records using Google DNS-over-HTTPS first (works everywhere),
 * falling back to Node.js native dns.resolveMx() if Google is unreachable.
 */
async function resolveMxRecords(domain: string): Promise<Array<{ exchange: string; priority: number }>> {
  // Try Google DNS-over-HTTPS first (works on Railway, Docker, etc.)
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        Status: number;
        Answer?: Array<{ name: string; type: number; data: string }>;
      };
      if (json.Status === 0 && json.Answer) {
        const mxAnswers = json.Answer.filter(a => a.type === 15);
        return mxAnswers.map(a => {
          // data format: "10 mx1.example.com."
          const parts = a.data.split(/\s+/);
          const priority = parseInt(parts[0], 10) || 0;
          const exchange = (parts[1] || "").replace(/\.$/, ""); // strip trailing dot
          return { exchange, priority };
        }).filter(m => m.exchange.length > 0);
      }
    }
  } catch {
    console.log(`[smtpVerify] Google DoH failed, trying native DNS`);
  }

  // Fallback to Node.js native (may fail in containers)
  try {
    return await dns.resolveMx(domain);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Gating — only run if ALL email fields are still empty
// ---------------------------------------------------------------------------

export function shouldRunSmtpFallback(
  sections: Array<{ key: string; label: string }>,
  fieldResults: Record<string, FieldResult | undefined>,
): boolean {
  const emailSections = sections.filter(s =>
    /email/i.test(s.key + " " + s.label),
  );
  if (emailSections.length === 0) return false;
  return emailSections.every(s => !fieldResults[s.key]?.value?.trim());
}

// ---------------------------------------------------------------------------
// SMTP protocol helpers
// ---------------------------------------------------------------------------

function connectSmtp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`SMTP connect timeout to ${host}:${port}`));
    });
  });
}

function readLine(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP read timeout"));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\r\n") || data.includes("\n")) {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        resolve(data.trim());
      }
    };
    socket.on("data", onData);
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function writeLine(socket: net.Socket, line: string): void {
  socket.write(line + "\r\n");
}

/** Run SMTP conversation and return RCPT TO response code for the given address. */
async function testAddress(
  mxHost: string,
  port: number,
  address: string,
): Promise<number | null> {
  let socket: net.Socket | null = null;
  try {
    socket = await connectSmtp(mxHost, port);

    // Read greeting
    const greeting = await readLine(socket, CONVERSATION_TIMEOUT_MS);
    if (!greeting.startsWith("220")) { socket.destroy(); return null; }

    // EHLO
    writeLine(socket, "EHLO probe.local");
    const ehloResp = await readLine(socket, CONVERSATION_TIMEOUT_MS);
    if (!ehloResp.startsWith("250")) { socket.destroy(); return null; }

    // MAIL FROM
    writeLine(socket, "MAIL FROM: <probe@probe.local>");
    const mailResp = await readLine(socket, CONVERSATION_TIMEOUT_MS);
    if (!mailResp.startsWith("250")) { socket.destroy(); return null; }

    // RCPT TO — this is the test
    writeLine(socket, `RCPT TO: <${address}>`);
    const rcptResp = await readLine(socket, CONVERSATION_TIMEOUT_MS);
    const code = parseInt(rcptResp.slice(0, 3), 10);

    // QUIT
    writeLine(socket, "QUIT");

    socket.destroy();
    return isNaN(code) ? null : code;
  } catch {
    socket?.destroy();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Catch-all detection — 3 random probes for reliability
// ---------------------------------------------------------------------------

/**
 * Test 3 random gibberish addresses. If ALL 3 return 250, the domain
 * accepts anything (catch-all). A single rejection means it's real filtering.
 */
async function isCatchAllDomain(
  mxHost: string,
  port: number,
  domain: string,
): Promise<boolean> {
  const probes = [
    `zz_probe_xk7q2m_${Date.now()}@${domain}`,
    `zz_probe_j9f3pw_${Date.now() + 1}@${domain}`,
    `zz_probe_m4v8nt_${Date.now() + 2}@${domain}`,
  ];

  let acceptCount = 0;
  for (const probe of probes) {
    const code = await testAddress(mxHost, port, probe);
    if (code === 250) acceptCount++;
  }

  const isCatchAll = acceptCount === 3;
  if (isCatchAll) {
    console.log(`[smtpVerify] ${domain} is catch-all (${acceptCount}/3 gibberish accepted)`);
  }
  return isCatchAll;
}

// ---------------------------------------------------------------------------
// Shared SMTP setup (MX lookup + port finding)
// ---------------------------------------------------------------------------

async function setupSmtp(domain: string): Promise<{ mxHost: string; port: number; catchAll: boolean } | null> {
  const mxRecords = await resolveMxRecords(domain);
  if (mxRecords.length === 0) {
    console.log(`[smtpVerify] No MX records for ${domain}`);
    return null;
  }

  mxRecords.sort((a, b) => a.priority - b.priority);
  const mxHost = mxRecords[0].exchange;

  // Find a working port
  let workingPort: number | null = null;
  for (const port of SMTP_PORTS) {
    try {
      const socket = await connectSmtp(mxHost, port);
      socket.destroy();
      workingPort = port;
      break;
    } catch {
      continue;
    }
  }

  if (!workingPort) {
    console.log(`[smtpVerify] Cannot connect to ${mxHost} on any SMTP port`);
    return null;
  }

  const catchAll = await isCatchAllDomain(mxHost, workingPort, domain);
  return { mxHost, port: workingPort, catchAll };
}

// ---------------------------------------------------------------------------
// Main function — generic email verification
// ---------------------------------------------------------------------------

export async function smtpVerifyGenericEmail(
  domain: string,
): Promise<SmtpVerifyResult | null> {
  const cleanDomain = domain.replace(/^www\./, "").toLowerCase();

  const smtp = await setupSmtp(cleanDomain);
  if (!smtp) return null;

  if (smtp.catchAll) {
    const email = `${GENERIC_PREFIXES[0]}@${cleanDomain}`;
    console.log(`[smtpVerify] Catch-all — returning ${email}`);
    return { email, catchAll: true, mxHost: smtp.mxHost, port: smtp.port };
  }

  // Test generic prefixes in order
  for (const prefix of GENERIC_PREFIXES) {
    const email = `${prefix}@${cleanDomain}`;
    const code = await testAddress(smtp.mxHost, smtp.port, email);
    if (code === 250) {
      console.log(`[smtpVerify] Verified: ${email} on ${smtp.mxHost}:${smtp.port}`);
      return { email, catchAll: false, mxHost: smtp.mxHost, port: smtp.port };
    }
  }

  console.log(`[smtpVerify] No generic emails accepted for ${cleanDomain}`);
  return null;
}

// ---------------------------------------------------------------------------
// Name-based email verification
// ---------------------------------------------------------------------------

/**
 * When we have a person's name but no email, generate common email patterns
 * from their name + domain and SMTP-verify each one until we find a hit.
 */
export async function smtpVerifyPersonEmail(
  firstName: string,
  lastName: string,
  domain: string,
): Promise<SmtpVerifyResult | null> {
  if (!firstName || !lastName) return null;

  const cleanDomain = domain.replace(/^www\./, "").toLowerCase();
  const first = firstName.toLowerCase().replace(/[^a-z]/g, "");
  const last = lastName.toLowerCase().replace(/[^a-z]/g, "");

  if (!first || !last) return null;

  const fi = first[0];

  // Patterns ordered by prevalence in corporate environments
  const patterns = [
    `${first}.${last}`,       // john.smith@ — most common globally
    `${first}`,               // john@ — common at small companies
    `${fi}${last}`,           // jsmith@ — common at large corps
    `${first}${last}`,        // johnsmith@ — common alias
    `${fi}.${last}`,          // j.smith@
    `${last}.${first}`,       // smith.john@ — finance/legal
    `${first}_${last}`,       // john_smith@
    `${first}-${last}`,       // john-smith@
  ];

  console.log(`[smtpVerify] Probing ${patterns.length} name patterns for ${first} ${last} @ ${cleanDomain}`);

  const smtp = await setupSmtp(cleanDomain);
  if (!smtp) return null;

  if (smtp.catchAll) {
    // Catch-all: return the most common pattern (firstname.lastname@)
    const email = `${patterns[0]}@${cleanDomain}`;
    console.log(`[smtpVerify] Catch-all — returning ${email} for ${first} ${last}`);
    return { email, catchAll: true, mxHost: smtp.mxHost, port: smtp.port };
  }

  // Test each pattern
  for (const pattern of patterns) {
    const email = `${pattern}@${cleanDomain}`;
    const code = await testAddress(smtp.mxHost, smtp.port, email);
    if (code === 250) {
      console.log(`[smtpVerify] Verified person email: ${email} on ${smtp.mxHost}:${smtp.port}`);
      return { email, catchAll: false, mxHost: smtp.mxHost, port: smtp.port };
    }
  }

  console.log(`[smtpVerify] No name-based emails accepted for ${first} ${last} @ ${cleanDomain}`);
  return null;
}
