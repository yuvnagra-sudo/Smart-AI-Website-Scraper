/**
 * SMTP Handshake Email Verification
 *
 * Last-resort fallback: connects to the domain's MX server and probes
 * generic email addresses (info@, hello@, contact@) via SMTP RCPT TO.
 *
 * Cost: Free (no external API).
 * Timeout: ~6s connect + 12s conversation per domain.
 *
 * Note: Cloud providers like Railway often block port 25. The function
 * gracefully falls back to ports 587 and 465, then returns null.
 */

import * as net from "net";
import * as dns from "dns/promises";
import type { AgentSection } from "../agentScraper";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SMTP_PORTS = [25, 587, 465];
const CONNECT_TIMEOUT_MS = 6_000;
const CONVERSATION_TIMEOUT_MS = 12_000;

// Only prefixes that actually convert for outreach — ranked by effectiveness.
// Removed: support, help, hi, mail (rarely forwarded to decision makers)
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
// Main function
// ---------------------------------------------------------------------------

export async function smtpVerifyGenericEmail(
  domain: string,
): Promise<SmtpVerifyResult | null> {
  const cleanDomain = domain.replace(/^www\./, "").toLowerCase();

  // DNS MX lookup
  let mxRecords: Array<{ exchange: string; priority: number }>;
  try {
    mxRecords = await dns.resolveMx(cleanDomain);
  } catch {
    console.log(`[smtpVerify] No MX records for ${cleanDomain}`);
    return null;
  }

  if (mxRecords.length === 0) return null;

  // Sort by priority (lower = preferred)
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

  // Catch-all detection — probe with a nonsense address
  const PROBE_PREFIX = "zz_smtp_probe_noreply_xyz";
  const probeAddress = `${PROBE_PREFIX}@${cleanDomain}`;
  const probeCode = await testAddress(mxHost, workingPort, probeAddress);
  const isCatchAll = probeCode === 250;

  if (isCatchAll) {
    const email = `${GENERIC_PREFIXES[0]}@${cleanDomain}`;
    console.log(`[smtpVerify] ${cleanDomain} is catch-all — returning ${email}`);
    return { email, catchAll: true, mxHost, port: workingPort };
  }

  // Test generic prefixes in order
  for (const prefix of GENERIC_PREFIXES) {
    const email = `${prefix}@${cleanDomain}`;
    const code = await testAddress(mxHost, workingPort, email);
    if (code === 250) {
      console.log(`[smtpVerify] Verified: ${email} on ${mxHost}:${workingPort}`);
      return { email, catchAll: false, mxHost, port: workingPort };
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
 *
 * Tries the most common corporate formats first:
 *   firstname.lastname@, firstname@, flastname@, firstnamelastname@, f.lastname@
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

  // DNS MX lookup
  let mxRecords: Array<{ exchange: string; priority: number }>;
  try {
    mxRecords = await dns.resolveMx(cleanDomain);
  } catch {
    console.log(`[smtpVerify] No MX records for ${cleanDomain}`);
    return null;
  }
  if (mxRecords.length === 0) return null;

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

  // Catch-all detection
  const probeCode = await testAddress(mxHost, workingPort, `zz_probe_noreply_xyz@${cleanDomain}`);
  if (probeCode === 250) {
    // Catch-all: return the most common pattern (firstname.lastname@)
    const email = `${patterns[0]}@${cleanDomain}`;
    console.log(`[smtpVerify] ${cleanDomain} is catch-all — returning ${email} for ${first} ${last}`);
    return { email, catchAll: true, mxHost, port: workingPort };
  }

  // Test each pattern
  for (const pattern of patterns) {
    const email = `${pattern}@${cleanDomain}`;
    const code = await testAddress(mxHost, workingPort, email);
    if (code === 250) {
      console.log(`[smtpVerify] Verified person email: ${email} on ${mxHost}:${workingPort}`);
      return { email, catchAll: false, mxHost, port: workingPort };
    }
  }

  console.log(`[smtpVerify] No name-based emails accepted for ${first} ${last} @ ${cleanDomain}`);
  return null;
}
