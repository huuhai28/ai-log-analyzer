// Test logic các Code node trong workflow n8n — không cần chạy n8n.
// Chạy: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = JSON.parse(readFileSync(new URL("../n8n/workflows/ai-log-analyzer.json", import.meta.url), "utf8"));

/** Chạy một Code node giống n8n: có $input, $env, $('Tên node'), this.helpers. */
async function run(name, { input = {}, env = {}, nodes = {}, helpers = {} } = {}) {
  const node = wf.nodes.find((n) => n.name === name);
  assert.ok(node, `không có node ${name}`);
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }] };
  const $ = (n) => ({ first: () => ({ json: nodes[n] }) });
  const fn = new Function("$input", "$env", "$", `return (async function () { ${node.parameters.jsCode} }).call(this);`);
  return fn.call({ helpers }, $input, env, $);
}

const ALERT = {
  body: {
    alerts: [{ labels: { alertname: "HighErrorRate", severity: "warning" },
      annotations: { summary: "Tỉ lệ lỗi 5xx > 5%", description: "12% request lỗi" }, startsAt: "2026-11-06T07:00:00Z" }],
  },
};
const hit = (src) => ({ _source: { "@timestamp": "2026-11-06T07:01:00Z", service: "portfolio-api", ...src } });

test("workflow: đủ node và nối đúng thứ tự", () => {
  const names = wf.nodes.map((n) => n.name);
  for (const n of ["Alertmanager webhook", "Every 30 minutes", "Build context", "Search error logs", "Prepare prompt",
    "Ask AI", "Build report", "Save to Elasticsearch", "Notify Telegram"]) assert.ok(names.includes(n), n);
  assert.equal(wf.connections["Prepare prompt"].main[0][0].node, "Ask AI");
  assert.equal(wf.nodes.find((n) => n.name === "Ask AI").onError, "continueRegularOutput");
});

test("Build context: cảnh báo từ Alertmanager → truy vấn log 15 phút", async () => {
  const [out] = await run("Build context", { input: ALERT, env: { LOG_WINDOW_MINUTES: "15" } });
  assert.equal(out.json.source, "alertmanager");
  assert.equal(out.json.alerts[0].name, "HighErrorRate");
  assert.equal(out.json.esQuery.query.bool.filter[0].range["@timestamp"].gte, "now-15m");
});

test("Build context: không có body → quét định kỳ", async () => {
  const [out] = await run("Build context", { input: { timestamp: "x" } });
  assert.equal(out.json.source, "schedule");
});

test("Prepare prompt: quét định kỳ không có lỗi → dừng, không gọi AI", async () => {
  const out = await run("Prepare prompt", {
    input: { hits: { hits: [hit({ level: "WARNING", message: "slow" })] } },
    nodes: { "Build context": { source: "schedule", alerts: [], minutes: 15 } },
  });
  assert.deepEqual(out, []);
});

test("Prepare prompt: che mật khẩu / token / API key trước khi gửi AI", async () => {
  const [out] = await run("Prepare prompt", {
    input: { hits: { hits: [
      hit({ level: "ERROR", message: "db login failed password=SuperSecret123 for user app", request_id: "abc123" }),
      hit({ level: "ERROR", message: "upstream said Authorization: Bearer eyJhbGciOi.secret.sig", "http.status_code": 500 }),
      hit({ level: "ERROR", message: "openai key sk-proj-AAAAAAAAAAAAAAAA leaked" }),
    ] } },
    env: { OPENAI_MODEL: "test-model", SYSTEM_DESCRIPTION: "web demo" },
    nodes: { "Build context": { source: "alertmanager", alerts: ALERT.body.alerts.map((a) => ({ name: a.labels.alertname, severity: "warning" })), minutes: 15 } },
  });
  const prompt = out.json.requestBody.input;
  assert.equal(out.json.requestBody.model, "test-model");
  assert.equal(out.json.errorCount, 3);
  assert.match(prompt, /web demo/);
  assert.match(prompt, /HighErrorRate/);
  assert.match(prompt, /rid=abc123/);
  assert.doesNotMatch(prompt, /SuperSecret123/);
  assert.doesNotMatch(prompt, /eyJhbGciOi/);
  assert.doesNotMatch(prompt, /sk-proj-AAAA/);
});

const PREPARED = { source: "alertmanager", alerts: [{ name: "AppDown", severity: "critical" }], logCount: 2, errorCount: 2,
  minutes: 15, logExcerpt: "2026 [ERROR] api 500 /api/x", requestBody: { model: "m" } };

test("Build report: đọc output của OpenAI Responses API", async () => {
  const [out] = await run("Build report", {
    input: { output: [{ type: "message", content: [{ type: "output_text", text: "DB mất kết nối" }] }] },
    nodes: { "Prepare prompt": PREPARED },
  });
  assert.equal(out.json.doc.ai_ok, true);
  assert.equal(out.json.doc.analysis, "DB mất kết nối");
  assert.match(out.json.telegramText, /AppDown \(critical\)/);
});

test("Build report: AI lỗi → vẫn có báo cáo kèm log gốc", async () => {
  const [out] = await run("Build report", { input: { error: { message: "401 Unauthorized" } }, nodes: { "Prepare prompt": PREPARED } });
  assert.equal(out.json.doc.ai_ok, false);
  assert.match(out.json.doc.analysis, /401 Unauthorized/);
  assert.match(out.json.doc.analysis, /\/api\/x/);
});

test("Notify Telegram: chưa cấu hình → bỏ qua; có cấu hình → gọi Bot API", async () => {
  const [skipped] = await run("Notify Telegram", {});
  assert.match(skipped.json.telegram, /skipped/);

  const calls = [];
  const [sent] = await run("Notify Telegram", {
    env: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" },
    nodes: { "Build report": { telegramText: "hello" } },
    helpers: { httpRequest: async (opts) => { calls.push(opts); return { ok: true }; } },
  });
  assert.equal(sent.json.telegram, "sent");
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:abc/sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: "42", text: "hello", disable_web_page_preview: true });
});
