#!/bin/sh
# Chạy một lần sau khi Kibana sẵn sàng: tạo index template + data view để mở Kibana là có log ngay.
set -eu
ES=http://elasticsearch:9200
KB=http://kibana:5601

echo "Chờ Elasticsearch..."
until curl -fsS "$ES/_cluster/health?wait_for_status=yellow&timeout=5s" >/dev/null; do sleep 3; done

# Template: index 1 shard, 0 replica (single node), các field hay lọc là keyword
curl -fsS -X PUT "$ES/_index_template/portfolio-logs" -H 'Content-Type: application/json' -d '{
  "index_patterns": ["portfolio-logs-*"],
  "template": {
    "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "level": { "type": "keyword" },
        "service": { "type": "keyword" },
        "request_id": { "type": "keyword" },
        "message": { "type": "text" },
        "http.status_code": { "type": "integer" },
        "http.route": { "type": "keyword" },
        "duration_ms": { "type": "float" }
      }
    }
  }
}' >/dev/null && echo "index template OK"

curl -fsS -X PUT "$ES/_index_template/ai-analysis" -H 'Content-Type: application/json' -d '{
  "index_patterns": ["ai-analysis*"],
  "template": { "settings": { "number_of_shards": 1, "number_of_replicas": 0 } }
}' >/dev/null && echo "ai-analysis template OK"

echo "Chờ Kibana..."
until curl -fsS "$KB/api/status" | grep -q '"level":"available"'; do sleep 5; done

for spec in "portfolio-logs:portfolio-logs-*:Portfolio logs" "ai-analysis:ai-analysis*:AI log analysis"; do
  id=${spec%%:*}; rest=${spec#*:}; pattern=${rest%%:*}; name=${rest#*:}
  curl -fsS -X POST "$KB/api/data_views/data_view" -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
    -d "{\"override\": true, \"data_view\": {\"id\": \"$id\", \"title\": \"$pattern\", \"name\": \"$name\", \"timeFieldName\": \"@timestamp\"}}" >/dev/null \
    && echo "data view $name OK"
done
curl -fsS -X POST "$KB/api/data_views/default" -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
  -d '{"data_view_id": "portfolio-logs", "force": true}' >/dev/null && echo "default data view OK"
