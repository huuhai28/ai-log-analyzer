// Mã nguồn của workflow n8n "AI log analyzer". Sửa logic ở đây rồi chạy:
//   node n8n/build-workflow.js
// để sinh lại n8n/workflows/ai-log-analyzer.json (file mà n8n import khi khởi động).
// Viết bằng JS thay vì kéo thả trên giao diện → review được trong Git, test được (tests/workflow.test.mjs).
const { createHash } = require("crypto");
// ID cố định theo tên node → chạy lại script ra đúng file cũ (CI kiểm tra được file JSON có khớp mã nguồn)
const stableId = (seed) => {
  const h = createHash("sha1").update(seed).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
};
const fs = require("fs");
const path = require("path");

const repo = path.join(__dirname, "..");
const code = (name, position, jsCode) => ({ parameters: { jsCode }, id: stableId(name), name, type: "n8n-nodes-base.code", typeVersion: 2, position });
const http = (name, position, parameters, extra = {}) => ({ parameters: { options: {}, ...parameters }, id: stableId(name), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position, ...extra });

const buildContext = String.raw`// Xác định nguồn kích hoạt và dựng truy vấn Elasticsearch lấy log lỗi/cảnh báo gần đây
const item = $input.first().json;
const alerts = item.body?.alerts ?? [];
const minutes = Number($env.LOG_WINDOW_MINUTES || 15);
const esQuery = {
  size: 60,
  sort: [{ "@timestamp": "desc" }],
  query: {
    bool: {
      filter: [{ range: { "@timestamp": { gte: "now-" + minutes + "m" } } }],
      should: [
        { terms: { level: ["ERROR", "CRITICAL", "WARNING"] } },
        { range: { "http.status_code": { gte: 500 } } },
      ],
      minimum_should_match: 1,
    },
  },
};
return [{
  json: {
    source: alerts.length ? "alertmanager" : "schedule",
    alerts: alerts.map((a) => ({
      name: a.labels?.alertname, severity: a.labels?.severity,
      summary: a.annotations?.summary, description: a.annotations?.description, startsAt: a.startsAt,
    })),
    minutes,
    esQuery,
  },
}];`;

const preparePrompt = String.raw`// Gom log thành đoạn văn ngắn, che bí mật, dựng prompt cho AI.
// Quét định kỳ mà không có lỗi thật → dừng luôn (không tốn tiền gọi AI).
const ctx = $('Build context').first().json;
const hits = $input.first().json.hits?.hits ?? [];
const status = (s) => s['http.status_code'] ?? s.http?.status_code;
const errors = hits.filter((h) => h._source.level === 'ERROR' || h._source.level === 'CRITICAL' || status(h._source) >= 500);
if (ctx.source === 'schedule' && errors.length === 0) return [];

const redact = (t) => String(t ?? '')
  .replace(/(bearer\s+)[\w.~+/=-]+/gi, '$1[REDACTED]')
  .replace(/((?:password|passwd|secret|token|api[_-]?key)["'\s:=]+)[^\s"',}]+/gi, '$1[REDACTED]')
  .replace(/\b(re|sk|ghp|glpat)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]');

const lines = hits.slice(0, 60).map(({ _source: s }) => {
  const route = s['http.route'] ?? s['url.path'] ?? '';
  const stack = s['error.stack'] ? '\n    ' + redact(s['error.stack']).slice(0, 600).replace(/\n/g, '\n    ') : '';
  return [s['@timestamp'], '[' + s.level + ']', s.service ?? s.compose_service ?? '?', status(s) ?? '', route,
    'rid=' + (s.request_id ?? '-'), redact(s.message).slice(0, 300)].join(' ') + stack;
});

const alertText = ctx.alerts.length
  ? ctx.alerts.map((a) => '- ' + a.name + ' [' + a.severity + ']: ' + (a.summary ?? '') + ' ' + (a.description ?? '')).join('\n')
  : '(không có — đây là lần quét định kỳ)';

const prompt = [
  'Bạn là kỹ sư SRE. Hệ thống đang giám sát: ' + ($env.SYSTEM_DESCRIPTION || 'ứng dụng web chạy bằng Docker') + '.',
  '',
  'CẢNH BÁO:',
  alertText,
  '',
  'LOG ' + ctx.minutes + ' PHÚT GẦN NHẤT (' + hits.length + ' dòng, mới nhất trước):',
  lines.join('\n') || '(không có log lỗi nào trong khoảng thời gian này)',
  '',
  'Hãy trả lời bằng tiếng Việt, tối đa 200 từ, theo đúng 4 mục:',
  '1. Chuyện gì đang xảy ra (1–2 câu)',
  '2. Nguyên nhân khả dĩ nhất, dựa trên bằng chứng trong log (trích request_id nếu có)',
  '3. Mức độ: thấp / trung bình / cao',
  '4. 2–3 bước kiểm tra hoặc khắc phục cụ thể (ví dụ lệnh docker compose cần chạy)',
  'Nếu log không đủ để kết luận, nói rõ là không đủ dữ liệu, đừng đoán.',
].join('\n');

return [{
  json: {
    ...ctx,
    logCount: hits.length,
    errorCount: errors.length,
    logExcerpt: lines.slice(0, 15).join('\n'),
    requestBody: { model: $env.OPENAI_MODEL || 'gpt-4.1-mini', input: prompt, max_output_tokens: 700 },
  },
}];`;

const buildReport = String.raw`// Lấy câu trả lời của AI (OpenAI Responses API). AI lỗi → vẫn tạo báo cáo kèm log gốc để không mất cảnh báo.
const ctx = $('Prepare prompt').first().json;
const r = $input.first().json;
let analysis = r.output_text;
if (!analysis && Array.isArray(r.output)) {
  analysis = r.output.flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n');
}
const aiOk = Boolean(analysis);
if (!aiOk) {
  const reason = r.error?.message ?? (typeof r.error === 'string' ? r.error : 'không có phản hồi');
  analysis = '⚠️ Không gọi được AI (' + reason + '). Log gốc:\n' + ctx.logExcerpt;
}
const title = ctx.alerts.length
  ? ctx.alerts.map((a) => a.name + ' (' + a.severity + ')').join(', ')
  : 'Quét định kỳ: ' + ctx.errorCount + ' lỗi trong ' + ctx.minutes + ' phút';
return [{
  json: {
    doc: {
      '@timestamp': new Date().toISOString(),
      source: ctx.source,
      title,
      alerts: ctx.alerts,
      log_count: ctx.logCount,
      error_count: ctx.errorCount,
      window_minutes: ctx.minutes,
      model: ctx.requestBody.model,
      ai_ok: aiOk,
      analysis,
    },
    telegramText: ('🔎 ' + title + '\n\n' + analysis).slice(0, 3900),
  },
}];`;

const notifyTelegram = String.raw`// Gửi Telegram nếu đã cấu hình TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID; không thì bỏ qua
const token = $env.TELEGRAM_BOT_TOKEN;
const chatId = $env.TELEGRAM_CHAT_ID;
if (!token || !chatId) return [{ json: { telegram: 'skipped — chưa cấu hình' } }];
const text = $('Build report').first().json.telegramText;
const res = await this.helpers.httpRequest({
  method: 'POST',
  url: 'https://api.telegram.org/bot' + token + '/sendMessage',
  body: { chat_id: chatId, text, disable_web_page_preview: true },
  json: true,
});
return [{ json: { telegram: res.ok ? 'sent' : 'failed' } }];`;

const nodes = [
  { parameters: { httpMethod: "POST", path: "alertmanager", options: {} }, id: stableId("Alertmanager webhook"), name: "Alertmanager webhook",
    type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], webhookId: stableId("webhook:alertmanager") },
  { parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 30 }] } }, id: stableId("Every 30 minutes"), name: "Every 30 minutes",
    type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 200] },
  code("Build context", [240, 100], buildContext),
  http("Search error logs", [480, 100], {
    method: "POST", url: "={{ $env.ES_URL }}/portfolio-logs-*/_search?ignore_unavailable=true&allow_no_indices=true",
    sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.esQuery) }}",
  }),
  code("Prepare prompt", [720, 100], preparePrompt),
  http("Ask AI", [960, 100], {
    method: "POST", url: "={{ ($env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/responses' }}",
    sendHeaders: true, headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $env.OPENAI_API_KEY }}" }] },
    sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.requestBody) }}",
    options: { timeout: 60000 },
  }, { onError: "continueRegularOutput" }),
  code("Build report", [1200, 100], buildReport),
  http("Save to Elasticsearch", [1440, 100], {
    method: "POST", url: "={{ $env.ES_URL }}/ai-analysis/_doc?refresh=true",
    sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.doc) }}",
  }, { onError: "continueRegularOutput" }),
  code("Notify Telegram", [1680, 100], notifyTelegram),
];

const chain = [["Alertmanager webhook", "Build context"], ["Every 30 minutes", "Build context"], ["Build context", "Search error logs"],
  ["Search error logs", "Prepare prompt"], ["Prepare prompt", "Ask AI"], ["Ask AI", "Build report"],
  ["Build report", "Save to Elasticsearch"], ["Save to Elasticsearch", "Notify Telegram"]];
const connections = {};
for (const [from, to] of chain) {
  connections[from] = connections[from] || { main: [[]] };
  connections[from].main[0].push({ node: to, type: "main", index: 0 });
}

module.exports = { nodes };
const workflow = { id: "aiLogAnalyzer001", name: "AI log analyzer", active: false, nodes, connections,
  settings: { executionOrder: "v1", saveDataErrorExecution: "all", saveDataSuccessExecution: "all" }, pinData: {} };
const out = path.join(repo, "n8n/workflows/ai-log-analyzer.json");
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + "\n");

// Kiểm tra cú pháp JS của từng Code node (bọc trong async function như n8n làm)
for (const n of nodes.filter((n) => n.type === "n8n-nodes-base.code")) {
  new Function("$input", "$env", "$", `return (async () => { ${n.parameters.jsCode} })()`);
}
console.log("workflow nodes:", nodes.length, "— Code nodes syntax OK");
