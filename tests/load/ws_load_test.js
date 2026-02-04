const WebSocket = require("ws");
const { generateMockEmails } = require("./email_generator");

const BASE_URL = process.env.CORTEX_SERVER_URL || "http://localhost:5001";
const WS_URL = process.env.CORTEX_WS_URL
  ? process.env.CORTEX_WS_URL
  : `${BASE_URL.replace(/^http/i, "ws")}/tbird-sync/ws`;

const THROUGHPUT_TARGET = Number(process.env.WS_THROUGHPUT_TARGET || 50);
const HTTP_RATIO_TARGET = Number(process.env.WS_HTTP_RATIO_TARGET || 2);
const MEM_GROWTH_MB_TARGET = Number(process.env.WS_MEM_GROWTH_MB_TARGET || 10);

if (typeof fetch !== "function") {
  throw new Error("Fetch API not available. Use Node 18+ or provide a fetch polyfill.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function ensureCleanState() {
  const status = await httpJson("GET", "/tbird-sync/status");
  if (status.pending_count > 0) {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const next = await httpJson("GET", "/tbird-sync/status");
      if (next.pending_count === 0) break;
      await sleep(500);
    }
  }
  const refreshed = await httpJson("GET", "/tbird-sync/status");
  if (refreshed.pending_count > 0) {
    throw new Error("Pending commands already in queue; clear before running load tests");
  }

  if (refreshed.connection && refreshed.connection.connected) {
    const start = Date.now();
    while (Date.now() - start < 35000) {
      const next = await httpJson("GET", "/tbird-sync/status");
      if (!(next.connection && next.connection.connected)) break;
      await sleep(1000);
    }
  }

  const final = await httpJson("GET", "/tbird-sync/status");
  if (final.connection && final.connection.connected) {
    throw new Error("tbird-sync extension already connected; load tests require exclusive access");
  }
}

async function queueCommands(count, prefix, concurrency = 20) {
  let index = 0;
  const ids = [];

  async function worker() {
    while (index < count) {
      const i = index;
      index += 1;
      const messageId = `<${prefix}-${i}@example.com>`;
      const payload = { action: "get_status", messageId };
      const data = await httpJson("POST", "/tbird-sync/queue", payload);
      ids.push(String(data.id || ""));
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return ids;
}

class MockWsClient {
  constructor({ resultFactory, commandFilter } = {}) {
    this.ws = null;
    this.seen = new Set();
    this.processed = [];
    this.latenciesMs = [];
    this.commandFilter = commandFilter || (() => true);
    this.resultFactory = resultFactory || this.defaultResultFactory.bind(this);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on("open", () => resolve());
      this.ws.on("message", (data) => this.handleMessage(data));
      this.ws.on("error", (err) => reject(err));
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }

  async handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (_err) {
      return;
    }

    if (msg.type === "ping") {
      this.send({ type: "pong", data: { timestamp: Date.now() } });
      return;
    }

    if (msg.type === "commands" || msg.type === "command") {
      const commands = msg.type === "command"
        ? [msg.data || msg.command || msg]
        : (msg.commands || msg.data || []);
      for (const cmd of commands) {
        await this.handleCommand(cmd);
      }
    }
  }

  async handleCommand(cmd) {
    if (!cmd || !cmd.id) return;
    const id = String(cmd.id);
    if (this.seen.has(id)) return;
    if (!this.commandFilter(cmd)) return;

    this.seen.add(id);
    const start = Date.now();
    const result = this.resultFactory(cmd);
    this.send({ type: "results", results: [result], data: [result] });
    this.processed.push(id);
    this.latenciesMs.push(Date.now() - start);
  }

  defaultResultFactory(cmd) {
    return {
      id: cmd.id,
      action: cmd.action,
      success: true,
      result: { ok: true }
    };
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  async waitForProcessed(count, timeoutMs) {
    const start = Date.now();
    while (this.processed.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout waiting for ${count} processed commands`);
      }
      await sleep(50);
    }
  }
}

function p95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(0.95 * (sorted.length - 1));
  return sorted[idx];
}

async function processViaHttpPolling(expectedCount, pollIntervalMs = 3000) {
  const seen = new Set();
  let processed = 0;
  const start = Date.now();

  while (processed < expectedCount) {
    const data = await httpJson("GET", "/tbird-sync/pending");
    const commands = Array.isArray(data.commands) ? data.commands : [];

    const newCommands = [];
    for (const cmd of commands) {
      const id = cmd && cmd.id ? String(cmd.id) : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      newCommands.push(cmd);
    }

    if (newCommands.length) {
      const results = newCommands.map((cmd) => ({
        id: cmd.id,
        action: cmd.action,
        success: true,
        result: { ok: true }
      }));
      await httpJson("POST", "/tbird-sync/complete", { results });
      processed += newCommands.length;
    }

    if (processed < expectedCount) {
      await sleep(pollIntervalMs);
    }
  }

  return (Date.now() - start) / 1000;
}

async function testEmailProcessingThroughput() {
  await ensureCleanState();

  const emails = generateMockEmails(500);
  const client = new MockWsClient({
    resultFactory: (cmd) => ({
      id: cmd.id,
      action: cmd.action,
      success: true,
      result: emails.shift() || {}
    })
  });
  await client.connect();

  const start = Date.now();
  await queueCommands(500, "ws-load");
  await client.waitForProcessed(500, 120000);
  const durationSec = (Date.now() - start) / 1000;
  const throughput = 500 / Math.max(durationSec, 0.001);

  client.close();

  console.log("");
  console.log("Test 7: Email Processing Throughput");
  console.log(`  Throughput: ${throughput.toFixed(2)} emails/sec`);
  console.log(`  Latency p95: ${p95(client.latenciesMs).toFixed(2)} ms`);
  if (throughput < THROUGHPUT_TARGET) {
    throw new Error(`Throughput below target: ${throughput.toFixed(2)} < ${THROUGHPUT_TARGET}`);
  }
  return throughput;
}

async function testHttpFallbackPerformance() {
  await ensureCleanState();

  const client = new MockWsClient();
  await client.connect();
  const wsStart = Date.now();
  await queueCommands(100, "ws-http-a");
  await client.waitForProcessed(100, 60000);
  const wsDuration = (Date.now() - wsStart) / 1000;
  client.close();

  await ensureCleanState();
  await queueCommands(100, "ws-http-b");
  const httpDuration = await processViaHttpPolling(100, 3000);

  const ratio = httpDuration / Math.max(wsDuration, 0.001);

  console.log("");
  console.log("Test 8: HTTP Fallback Performance");
  console.log(`  WS duration: ${wsDuration.toFixed(2)}s`);
  console.log(`  HTTP duration: ${httpDuration.toFixed(2)}s`);
  console.log(`  Ratio (HTTP/WS): ${ratio.toFixed(2)}x`);
  if (ratio < HTTP_RATIO_TARGET) {
    throw new Error(`HTTP fallback not slower enough: ratio ${ratio.toFixed(2)}x < ${HTTP_RATIO_TARGET}x`);
  }
}

async function testMemoryLeaks() {
  await ensureCleanState();

  if (global.gc) {
    global.gc();
  }
  const startMem = process.memoryUsage().heapUsed;

  const client = new MockWsClient();
  await client.connect();
  await queueCommands(1000, "ws-mem");
  await client.waitForProcessed(1000, 180000);
  client.close();

  if (global.gc) {
    global.gc();
  }
  const endMem = process.memoryUsage().heapUsed;
  const deltaMb = (endMem - startMem) / (1024 * 1024);

  console.log("");
  console.log("Test 9: Memory Leak Detection");
  console.log(`  Heap delta: ${deltaMb.toFixed(2)} MB`);

  if (deltaMb > MEM_GROWTH_MB_TARGET) {
    throw new Error(`Memory growth too high: ${deltaMb.toFixed(2)} MB > ${MEM_GROWTH_MB_TARGET} MB`);
  }
}

async function testReconnectionBackoff() {
  const targetUrl = process.env.WS_BACKOFF_TEST_URL || "ws://127.0.0.1:59999/tbird-sync/ws";
  const expected = [1000, 2000, 4000, 8000, 16000, 30000];
  const actual = [];

  let attempts = 0;
  let lastAttempt = Date.now();

  async function tryConnect() {
    attempts += 1;
    const ws = new WebSocket(targetUrl);
    ws.on("open", () => {
      ws.close();
    });
    ws.on("error", () => {
      ws.close();
    });
    ws.on("close", () => {
      const now = Date.now();
      actual.push(now - lastAttempt);
      lastAttempt = now;
      if (attempts >= expected.length) return;
      const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
      setTimeout(tryConnect, delay);
    });
  }

  tryConnect();

  const maxWait = expected.reduce((a, b) => a + b, 0) + 5000;
  const start = Date.now();
  while (actual.length < expected.length && Date.now() - start < maxWait) {
    await sleep(100);
  }

  console.log("");
  console.log("Test 10: Reconnection Backoff Timing");

  if (actual.length < expected.length) {
    throw new Error("Did not capture all backoff intervals");
  }

  for (let i = 0; i < expected.length; i += 1) {
    const tolerance = Math.max(250, expected[i] * 0.2);
    const diff = Math.abs(actual[i] - expected[i]);
    console.log(`  Attempt ${i + 1}: expected ${expected[i]}ms, actual ${actual[i]}ms`);
    if (diff > tolerance) {
      throw new Error(`Backoff deviation too large at attempt ${i + 1}`);
    }
  }
}

async function main() {
  console.log("========================================");
  console.log("WebSocket Load Test Report");
  console.log("========================================");

  try {
    await testEmailProcessingThroughput();
    await testHttpFallbackPerformance();
    await testMemoryLeaks();
    await testReconnectionBackoff();
    console.log("");
    console.log("All load tests passed.");
  } catch (err) {
    console.error("");
    console.error("Load tests failed:", err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
