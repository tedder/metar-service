#!/bin/sh
# One-time AWS setup for .github/workflows/deploy.yml: the GitHub OIDC provider (if the account has
# none) and the role `metar-service-github-deploy`, which only a job in this repo's `production`
# environment can assume. Safe to rerun: existing pieces are kept and the policies are rewritten.
#   AWS_PROFILE=... CF_DISTRIBUTION_ID=E... ./deploy/setup-aws.sh
# Prints the role ARN to store as the environment secret AWS_ROLE_ARN.
set -eu
cd "$(dirname "$0")/iam"
: "${CF_DISTRIBUTION_ID:?set CF_DISTRIBUTION_ID (the distribution with the /metar* behavior)}"
ROLE=metar-service-github-deploy
ACCOUNT=$(aws sts get-caller-identity --region us-east-1 --query Account --output text)
OIDC_ARN="arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for f in trust permissions; do
  sed -e "s/\${AWS_ACCOUNT_ID}/${ACCOUNT}/g" -e "s/\${CF_DISTRIBUTION_ID}/${CF_DISTRIBUTION_ID}/g" "$f.json" > "$tmp/$f.json"
  if grep -q '\${' "$tmp/$f.json"; then echo "unfilled placeholder in $f.json" >&2; exit 1; fi
done

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "OIDC provider exists"
else
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com --tags Key=purpose,Value=github-actions >/dev/null
  echo "OIDC provider created"
fi

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$tmp/trust.json"
  echo "role exists; trust policy updated"
else
  aws iam create-role --role-name "$ROLE" --max-session-duration 3600 \
    --description "GitHub Actions deploy for tedder/metar-service (environment production only)" \
    --assume-role-policy-document "file://$tmp/trust.json" >/dev/null
  echo "role created"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name deploy --policy-document "file://$tmp/permissions.json"
echo "permissions policy set"
aws iam get-role --role-name "$ROLE" --query Role.Arn --output text
