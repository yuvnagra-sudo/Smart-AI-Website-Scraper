/**
 * SMTP Handshake Generic Email Verifier
 *
 * Zero-cost fallback that checks whether common generic mailboxes exist at a
 * domain by performing a real SMTP conversation — without sending any email.
 *
 * Flow per address:
 *   1. DNS MX lookup → find the authoritative mail server
 *   2. TCP connect to MX host on port 25 (fallback: 587, then 465)
 *   3. EHLO → MAIL FROM → RCPT TO → QUIT
 *   4. Parse the RCPT TO response: 250 = exists, 550/551 = doesn't exist
 *
 * Catch-all detection:
 *   Before testing real addresses, we send RCPT TO for a clearly fake address
 *   (e.g. zz_smtp_probe_xyz@domain.com).  If the server accepts it, the domain
 *   is catch-all — we still return the first generic address but mark it
 *   `catchAll: true` so callers can decide whether to use it.
 *
 * Cost: $0.  No external API.  ~1–3 seconds per domain.
 *
 * Gate: Only fires when no email has been found by any upstream step.
 *       Returns null immediately if the domain has no MX record.
 *
 * Railway / hosting note:
 *   Many cloud providers block outbound port 25 to prevent spam abuse.
 *   The module automatically falls back to port 587 if port 25 is blocked.
 *   If all ports are blocked, it returns null gracefully (non-fatal).
 */

import net from "net";
import dns from "dns/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmtpVerifyResult {
  /** The verified (or catch-all) email address. */
  email: string;
  /** True if the server is a catch-all (accepts any address). */
  catchAll: boolean;
  /** The MX host that accepted the connection. */
  mxHost: string;
  /** The port used for the connection. */
  port: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Generic mailboxes to probe, in priority order. */
const GENERIC_PREFIXES = [
  "info",
  "hello",
  "contact",
  "team",
  "hi",
  "support",
  "help",
  "office",
  "admin",
  "mail",
];

/** Ports to try in order.
 *  Port 25  = standard SMTP relay.
 *  Port 587 = submission (open on most cloud hosts, uses STARTTLS over plain TCP).
 *  Port 465 (SMTPS) is intentionally excluded: it requires TLS from the first byte
 *  and cannot be probed with a plain TCP socket — it always times out or rejects. */
const SMTP_PORTS = [25, 587];

/** Total timeout per TCP connection attempt (ms). */
const CONNECT_TIMEOUT_MS = 6_000;

/** Total timeout for the full SMTP conversation (ms). */
const CONVERSATION_TIMEOUT_MS = 12_000;

/** Fake address used to detect catch-all servers. */
const PROBE_PREFIX = "zz_smtp_probe_noreply_xyz";

// ---------------------------------------------------------------------------
// Low-level SMTP helpers
// ---------------------------------------------------------------------------

/**
 * Open a raw TCP socket to `host:port` with a timeout.
 * Resolves with the connected socket or rejects on error/timeout.
 */
function openSocket(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect timeout to ${host}:${port}`));
    }, CONNECT_TIMEOUT_MS);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Perform a minimal SMTP conversation and return the RCPT TO response code.
 *
 * The conversation is:
 *   ← 220 greeting
 *   → EHLO probe.local
 *   ← 250 ...
 *   → MAIL FROM: <probe@probe.local>
 *   ← 250 ...
 *   → RCPT TO: <address>
 *   ← 250 | 4xx | 5xx
 *   → QUIT
 *
 * Returns the numeric SMTP response code for the RCPT TO command.
 * Throws on timeout or unexpected server behaviour.
 */
function smtpRcptCode(
  socket: net.Socket,
  address: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stage: "greeting" | "ehlo" | "mail_from" | "rcpt_to" | "quit" = "greeting";

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP conversation timeout"));
    }, CONVERSATION_TIMEOUT_MS);

    const send = (line: string) => socket.write(line + "\r\n");

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      // SMTP responses end with \r\n; multi-line responses end with "NNN " prefix
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const isFinal = line[3] === " " || line.length <= 3; // single-line or last of multi-line

        if (!isFinal) continue; // wait for the last line of a multi-line response

        if (stage === "greeting") {
          if (code === 220) {
            stage = "ehlo";
            send("EHLO probe.local");
          } else {
            cleanup();
            reject(new Error(`Unexpected greeting code: ${code}`));
          }
        } else if (stage === "ehlo") {
          if (code === 250) {
            stage = "mail_from";
            send("MAIL FROM: <probe@probe.local>");
          } else {
            cleanup();
            reject(new Error(`EHLO rejected: ${code}`));
          }
        } else if (stage === "mail_from") {
          if (code === 250) {
            stage = "rcpt_to";
            send(`RCPT TO: <${address}>`);
          } else {
            cleanup();
            reject(new Error(`MAIL FROM rejected: ${code}`));
          }
        } else if (stage === "rcpt_to") {
          stage = "quit";
          send("QUIT");
          cleanup();
          resolve(code);
        }
        // Ignore the QUIT response — we already resolved
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      // Give the socket a moment to flush QUIT before destroying
      setTimeout(() => socket.destroy(), 500);
    };

    socket.on("data", onData);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Test a single email address against `mxHost:port`.
 * Returns the RCPT TO response code, or null on connection/protocol failure.
 */
async function testAddress(
  mxHost: string,
  port: number,
  address: string,
): Promise<number | null> {
  let socket: net.Socket | null = null;
  try {
    socket = await openSocket(mxHost, port);
    return await smtpRcptCode(socket, address);
  } catch {
    return null;
  } finally {
    socket?.destroy();
  }
}

// ---------------------------------------------------------------------------
// MX resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the highest-priority MX host for a domain.
 * Returns null if no MX record exists.
 */
async function resolveMx(domain: string): Promise<string | null> {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return null;
    // Sort by priority (lower = higher priority)
    records.sort((a, b) => a.priority - b.priority);
    return records[0].exchange;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify generic email addresses at a domain via SMTP handshake.
 *
 * Only fires when no email has been found upstream.  Returns the first
 * verified address, or null if none could be confirmed (e.g. all ports
 * blocked, no MX record, or all addresses rejected).
 *
 * @param domain  - Bare domain, e.g. "acme.com" (no protocol, no path)
 * @returns SmtpVerifyResult or null
 */
export async function smtpVerifyGenericEmail(
  domain: string,
): Promise<SmtpVerifyResult | null> {
  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .toLowerCase()
    .trim();

  if (!cleanDomain || !cleanDomain.includes(".")) return null;

  // Step 1: Resolve MX record
  const mxHost = await resolveMx(cleanDomain);
  if (!mxHost) {
    console.log(`[smtpVerify] No MX record for ${cleanDomain} — skipping`);
    return null;
  }

  // Step 2: Find a working port
  let workingPort: number | null = null;
  for (const port of SMTP_PORTS) {
    // Quick TCP probe — just open a socket, don't do SMTP yet
    try {
      const socket = await openSocket(mxHost, port);
      socket.destroy();
      workingPort = port;
      break;
    } catch {
      // Try next port
    }
  }

  if (workingPort === null) {
    console.log(`[smtpVerify] All ports blocked for ${mxHost} (${cleanDomain}) — skipping`);
    return null;
  }

  // Step 3: Catch-all detection
  const probeAddress = `${PROBE_PREFIX}@${cleanDomain}`;
  const probeCode = await testAddress(mxHost, workingPort, probeAddress);
  const isCatchAll = probeCode === 250;

  if (isCatchAll) {
    // Server accepts everything — return the top-priority generic address
    // marked as catch-all so the caller can decide whether to use it.
    const email = `${GENERIC_PREFIXES[0]}@${cleanDomain}`;
    console.log(`[smtpVerify] ${cleanDomain} is catch-all — returning ${email} (catch-all)`);
    return { email, catchAll: true, mxHost, port: workingPort };
  }

  // Step 4: Test generic prefixes in priority order
  for (const prefix of GENERIC_PREFIXES) {
    const address = `${prefix}@${cleanDomain}`;
    const code = await testAddress(mxHost, workingPort, address);
    if (code === 250) {
      console.log(`[smtpVerify] ✅ Verified ${address} (SMTP 250)`);
      return { email: address, catchAll: false, mxHost, port: workingPort };
    }
    // 4xx = temporary failure (greylisting etc.) — treat as "maybe exists"
    if (code !== null && code >= 400 && code < 500) {
      console.log(`[smtpVerify] ${address} returned ${code} (greylisted?) — using it tentatively`);
      return { email: address, catchAll: false, mxHost, port: workingPort };
    }
    // 5xx = definitive rejection — try next prefix
  }

  console.log(`[smtpVerify] No generic address verified for ${cleanDomain}`);
  return null;
}

/**
 * Determine whether the SMTP fallback should be called.
 *
 * Skip if any email field already has a value — SMTP is purely a last resort.
 */
export function shouldRunSmtpFallback(
  sections: Array<{ key: string; label: string }>,
  fieldResults: Record<string, { value: string; confidence: number } | undefined>,
): boolean {
  const emailSections = sections.filter(s =>
    /email/i.test(s.key + " " + s.label),
  );
  if (emailSections.length === 0) return false;
  // Run only if ALL email fields are empty
  return emailSections.every(s => !fieldResults[s.key]?.value?.trim());
}
