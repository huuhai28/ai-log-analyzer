# AI Log Analyzer

[![CI](https://github.com/huuhai28/ai-log-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/huuhai28/ai-log-analyzer/actions/workflows/ci.yml)

Bộ **observability + phân tích log bằng AI** chạy bằng một lệnh `docker compose up`: thu log và metrics
của ứng dụng Docker, cảnh báo khi có sự cố, rồi để **n8n tự động gọi AI đọc log và đề xuất cách xử lý**.

> **EN —** A one-command observability stack (ELK, Prometheus, Alertmanager, Grafana) plus an n8n workflow that,
> on every alert or every 30 minutes, pulls the relevant error logs from Elasticsearch, redacts secrets, asks an LLM
> (OpenAI Responses API) for a root-cause summary and stores/sends the result.

Mặc định giám sát project **[web-platform](https://github.com/huuhai28/web-platform)** (FastAPI ghi log JSON có
request ID và có `/metrics`), nhưng dùng được cho bất kỳ app nào chạy bằng Docker Compose.

## Luồng hoạt động

```text
                ┌─────────────── app (vd. web-platform) ───────────────┐
                │  container stdout (log JSON)        /metrics          │
                └──────────────┬────────────────────────┬──────────────┘
                               ▼                        ▼
                          Filebeat                  Prometheus ── rule: AppDown, HighErrorRate, HighLatencyP95
                               ▼                        │                 │
                          Logstash (parse JSON,         ▼                 ▼
                          chuẩn hóa level)           Grafana         Alertmanager
                               ▼                   (dashboard)            │ webhook
                        Elasticsearch ◄───────────────────────────────┐   ▼
                               │                                      │  n8n  ◄── hoặc tự quét mỗi 30 phút
                            Kibana                                    │   │ 1. lấy log lỗi 15 phút gần nhất
                                                                      │   │ 2. che mật khẩu / token / API key
                                                                      │   │ 3. hỏi AI: chuyện gì, vì sao, mức độ, cách xử lý
                                                                      └───┤ 4. lưu kết quả vào index ai-analysis
                                                                          └ 5. gửi Telegram (nếu cấu hình)
```

| Thành phần | Vai trò | Giao diện |
|---|---|---|
| Elasticsearch 8 | Lưu log (`portfolio-logs-*`) và kết quả AI (`ai-analysis`) | — |
| Logstash | Tách log JSON thành field, chuẩn hóa `level` cho cả log không phải JSON | — |
| Filebeat | Đọc log mọi container thuộc project được chọn (`WATCH_PROJECTS`) | — |
| Kibana | Tìm kiếm log, xem lịch sử phân tích AI | http://localhost:5601 |
| Prometheus | Thu metrics, đánh giá alert rule | http://localhost:9090 |
| Alertmanager | Gom và gửi cảnh báo sang n8n | http://localhost:9093 |
| Grafana | Dashboard dựng sẵn: request/s, tỉ lệ lỗi, p95 latency, log lỗi | http://localhost:3001 |
| n8n | Workflow tự động: log → AI → lưu/Telegram | http://localhost:5678 |

Tất cả giao diện chỉ mở trên `127.0.0.1`.

## Chạy

Yêu cầu: Docker với khoảng **2,5 GB RAM trống**. Nên chạy app cần giám sát trước (ví dụ `docker compose up -d`
trong repo web-platform).

```bash
cp .env.example .env        # điền OPENAI_API_KEY; Telegram nếu muốn
docker compose up -d
```

- **Kibana → Discover**: data view *Portfolio logs* đã tạo sẵn. Lọc theo `request_id` để thấy đường đi của một
  request qua nginx → FastAPI → Celery.
- **Grafana**: dashboard *App overview* mở ngay khi đăng nhập (`admin` / `GRAFANA_ADMIN_PASSWORD`).
- **n8n**: lần đầu mở sẽ yêu cầu tạo tài khoản chủ. Workflow *AI log analyzer* đã được nạp và bật sẵn.

### Thử một sự cố

```bash
# Tắt backend của app → sau ~1 phút Prometheus báo AppDown → Alertmanager → n8n → AI phân tích
docker compose -p personal-web-platform stop backend
```

Kết quả xuất hiện trong Kibana (data view *AI log analysis*), trong tab *Executions* của n8n, và trên Telegram nếu
đã cấu hình. Bật lại bằng `docker compose -p personal-web-platform start backend`.

## Workflow n8n được quản lý như code

Workflow không kéo thả tay rồi export, mà được sinh từ **[n8n/build-workflow.js](n8n/build-workflow.js)**:

```bash
node n8n/build-workflow.js        # sinh lại n8n/workflows/ai-log-analyzer.json
node --test "tests/**/*.test.mjs" # 8 test cho logic từng bước (không cần chạy n8n)
```

Khi khởi động, container n8n tự `import:workflow` và bật workflow, nên sửa code rồi `docker compose restart n8n`
là xong. CI kiểm tra file JSON trong repo luôn khớp với mã nguồn.

Những điểm đã xử lý:
- **Che bí mật trước khi gửi AI**: password, token, `Bearer …`, key dạng `sk-…`/`re_…`/`ghp_…` → `[REDACTED]`.
- **Không tốn tiền vô ích**: quét định kỳ mà không có lỗi thật thì dừng, không gọi AI.
- **AI lỗi vẫn không mất cảnh báo**: báo cáo vẫn được tạo kèm log gốc.
- **Prompt có cấu trúc**: chuyện gì xảy ra, nguyên nhân dựa trên bằng chứng (có request_id), mức độ, 2–3 bước xử lý.
  Không đủ dữ liệu thì phải nói rõ thay vì đoán.

## Cấu hình

| Biến (`.env`) | Mặc định | Ý nghĩa |
|---|---|---|
| `OPENAI_API_KEY` | *(trống)* | Thiếu thì workflow vẫn chạy, báo cáo ghi rõ "không gọi được AI" kèm log gốc |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Model dùng để phân tích |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Đổi nếu dùng dịch vụ tương thích OpenAI |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | *(trống)* | Gửi kết quả qua Telegram |
| `WATCH_PROJECTS` | `^(personal-web-platform\|personal-web-prod)$` | Regex compose project cần thu log |
| `SYSTEM_DESCRIPTION` | mô tả web-platform | Ngữ cảnh hệ thống cho AI |
| `LOG_WINDOW_MINUTES` | `15` | Lấy log bao nhiêu phút gần nhất |

Muốn giám sát app khác: đổi `WATCH_PROJECTS`, `SYSTEM_DESCRIPTION` và target trong
[prometheus/prometheus.yml](prometheus/prometheus.yml). App nên ghi log JSON một dòng có các field `level`,
`message`, `request_id`, `http.status_code` để Logstash và AI đọc tốt nhất.

## CI

GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) kiểm tra: `docker compose config`,
`promtool check config` (gồm alert rules), `amtool check-config`, Logstash `--config.test_and_exit`,
`filebeat test config`, workflow JSON khớp mã nguồn, dashboard JSON hợp lệ, và 8 test logic workflow.

## Cấu trúc

```text
ai-log-analyzer/
├── docker-compose.yml
├── .env.example
├── elk/
│   ├── filebeat/filebeat.yml          # thu log container theo compose project
│   ├── logstash/pipeline/logstash.conf
│   └── kibana/setup.sh                # index template + data view
├── prometheus/prometheus.yml, alerts.yml
├── alertmanager/alertmanager.yml      # → webhook n8n
├── grafana/                           # datasource + dashboard dựng sẵn
├── n8n/
│   ├── build-workflow.js              # mã nguồn workflow
│   └── workflows/ai-log-analyzer.json # file n8n import (sinh tự động)
└── tests/workflow.test.mjs
```

## Ghi chú bảo mật

Đây là cấu hình **lab**: Elasticsearch tắt xác thực và mọi cổng chỉ bind `127.0.0.1`. Nếu đưa lên server, cần bật
`xpack.security`, đặt mật khẩu cho Kibana/Grafana/n8n và đặt sau reverse proxy có HTTPS.
