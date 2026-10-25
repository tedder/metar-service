#!/bin/sh
# SQS queue for poll events, and the IAM permissions around it. Safe to run again.
#   AWS_PROFILE=pjnet ./deploy/setup-sqs.sh
# - queue metar-poll-events in us-west-2 (standard, 1-day retention, long polling 20 s)
# - the Lambda@Edge execution role may only SendMessage to it
# - IAM user metar-poll-watch may only Receive/Delete/GetQueueAttributes on it
# The consumer's access key is not created here (the secret would be printed). On nuc11 it lives in
# ~/compose/metar-poll-watch/aws-credentials ([default] profile, mode 600), mounted into the
# metar-poll-watch container. To rotate: create a key, write the file, restart the container, delete
# the old key.
set -eu
REGION=us-west-2
ACCOUNT=${ACCOUNT:-257269553028}
Q=metar-poll-events
ARN=arn:aws:sqs:$REGION:$ACCOUNT:$Q
EXEC_ROLE=metar-service-lambda-edge
USER=metar-poll-watch

aws sqs create-queue --region $REGION --queue-name $Q \
  --attributes MessageRetentionPeriod=86400,ReceiveMessageWaitTimeSeconds=20 --query QueueUrl --output text

aws iam put-role-policy --role-name $EXEC_ROLE --policy-name sqs-send-poll-events --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:SendMessage","Resource":"'$ARN'"}]}'

aws iam get-user --user-name $USER >/dev/null 2>&1 || aws iam create-user --user-name $USER \
  --tags Key=purpose,Value=metar-poll-watch-nuc11 >/dev/null
aws iam put-user-policy --user-name $USER --policy-name consume-poll-events --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes"],"Resource":"'$ARN'"}]}'
echo "done"
