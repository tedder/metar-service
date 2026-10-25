#!/bin/sh
# CloudWatch metric filters and alarms for the metar-service Lambda@Edge replica logs.
#   AWS_PROFILE=pjnet ./deploy/setup-alarms.sh
# Safe to run again: put-metric-filter and put-metric-alarm replace what is there.
#
# Lambda@Edge logs in the region that served the request, under /aws/lambda/us-east-1.<name>.
# All traffic so far lands in us-west-2 (checked 2026-10-24: only us-west-2 and us-east-1 have
# the log group, and us-east-1 only has smoke-test invocations). If another region shows up,
# run this with REGION set to it, with an SNS topic in that region.
#
# Alarms:
#   metar-service-errors  handler_error log lines (the 502s) plus the Lambda Errors metric
#                         (crashes and the 30 s timeout) is 2 or more in 15 minutes. A count, not a
#                         rate: only about 30 invocations an hour, so one failure would be 12%.
#   metar-service-oom     a REPORT line with "Error Type: Runtime.OutOfMemory": one is enough
#   metar-service-memory  Max Memory Used from the REPORT lines is 144 MB or more (90% of 160 MB)
set -eu
REGION=${REGION:-us-west-2}
ACCOUNT=${ACCOUNT:-257269553028}
TOPIC=${TOPIC:-arn:aws:sns:$REGION:$ACCOUNT:errors}   # email plus AWS Chatbot
GROUP=/aws/lambda/us-east-1.metar-service
FN=us-east-1.metar-service
MEM_LIMIT_MB=${MEM_LIMIT_MB:-160}
MEM_ALARM_MB=$(( MEM_LIMIT_MB * 9 / 10 ))

aws logs put-metric-filter --region "$REGION" --log-group-name "$GROUP" \
  --filter-name metar-handler-errors --filter-pattern '"handler_error"' \
  --metric-transformations metricName=HandlerErrors,metricNamespace=MetarService,metricValue=1,defaultValue=0

aws logs put-metric-filter --region "$REGION" --log-group-name "$GROUP" \
  --filter-name metar-max-memory \
  --filter-pattern '[type="REPORT", rl, rid, dl, d, du, bl1, bl2, b, bu, ml1, ml2, ms, msu, xl1, xl2, xl3, mem, memu, ...]' \
  --metric-transformations metricName=MaxMemoryUsedMB,metricNamespace=MetarService,metricValue='$mem'

aws logs put-metric-filter --region "$REGION" --log-group-name "$GROUP" \
  --filter-name metar-oom-kills --filter-pattern '"Error Type: Runtime.OutOfMemory"' \
  --metric-transformations metricName=OomKills,metricNamespace=MetarService,metricValue=1,defaultValue=0

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name metar-service-oom \
  --alarm-description "metar-service: the Lambda was killed for running out of memory (Runtime.OutOfMemory). Raise memory (aws lambda update-function-configuration), publish, repoint CloudFront." \
  --namespace MetarService --metric-name OomKills --statistic Sum --period 300 \
  --comparison-operator GreaterThanOrEqualToThreshold --threshold 1 --evaluation-periods 1 \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC" --ok-actions "$TOPIC"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name metar-service-errors \
  --alarm-description "metar-service: 2+ handler errors (502s) or Lambda errors in 15 min. Logs: $GROUP in $REGION" \
  --metrics '[
    {"Id":"h","MetricStat":{"Metric":{"Namespace":"MetarService","MetricName":"HandlerErrors"},"Period":900,"Stat":"Sum"},"ReturnData":false},
    {"Id":"l","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Errors","Dimensions":[{"Name":"FunctionName","Value":"'"$FN"'"}]},"Period":900,"Stat":"Sum"},"ReturnData":false},
    {"Id":"e","Expression":"FILL(h,0)+FILL(l,0)","Label":"errors","ReturnData":true}]' \
  --comparison-operator GreaterThanOrEqualToThreshold --threshold 2 --evaluation-periods 1 \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC" --ok-actions "$TOPIC"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name metar-service-memory \
  --alarm-description "metar-service: Max Memory Used reached ${MEM_ALARM_MB} MB of ${MEM_LIMIT_MB} MB. Raise memory (aws lambda update-function-configuration), publish, repoint CloudFront." \
  --namespace MetarService --metric-name MaxMemoryUsedMB --statistic Maximum --period 900 \
  --comparison-operator GreaterThanOrEqualToThreshold --threshold "$MEM_ALARM_MB" --evaluation-periods 1 \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC"

echo "done: filters and alarms in $REGION, notifying $TOPIC"
