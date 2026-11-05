#!/usr/bin/env bash
# Upbeater のクラウド Runner を Google Cloud Run Jobs に用意する（何度実行してもよい。課金が発生する）
#
#   sh cloud-runner/deploy.sh <GCP のプロジェクト ID（課金が有効なもの）> [リージョン（既定 asia-northeast1）]
#
# 1. 必要な API を有効にし、イメージの置き場所（Artifact Registry）を作る
# 2. Cloud Build でイメージを組み立てる（この PC に docker は要らない）
# 3. Cloud Run Job を作る・更新する
# 4. Hub が Job を起動するためのサービスアカウントを作り、その Job の起動だけを許す
# 5. サービスアカウントの鍵を Hub の Secret（GCP_SERVICE_ACCOUNT_KEY）に入れる（画面・ファイルに残さない）
set -euo pipefail
PROJECT="${1:?GCP のプロジェクト ID を指定してください}"
REGION="${2:-asia-northeast1}"
JOB="upbeater-runner"
REPO_AR="upbeater"
SA="upbeater-hub"
SA_EMAIL="$SA@$PROJECT.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO_AR/runner:latest"
g() { gcloud --project "$PROJECT" --quiet "$@"; }
say() { echo "・$*"; }

say "API を有効にします"
g services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com >/dev/null

say "イメージの置き場所を用意します"
g artifacts repositories describe "$REPO_AR" --location "$REGION" >/dev/null 2>&1 ||
  g artifacts repositories create "$REPO_AR" --location "$REGION" --repository-format docker >/dev/null

say "イメージを組み立てます（Cloud Build・数分かかります）"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/runner"
# Runner の部品とコンテナの定義だけを送る（組み立て済みの実行ファイル・秘密情報は送らない）
(cd "$ROOT/runner" && tar --exclude ./upbeater-runner -cf - .) | (cd "$TMP/runner" && tar -xf -)
cp "$ROOT/cloud-runner/Dockerfile" "$TMP/Dockerfile"
g builds submit "$TMP" --tag "$IMAGE" --region "$REGION" >/dev/null

say "Cloud Run Job を用意します"
ARGS=(--image "$IMAGE" --region "$REGION" --tasks 1 --max-retries 0 --task-timeout 3h --cpu 4 --memory 8Gi)
if g run jobs describe "$JOB" --region "$REGION" >/dev/null 2>&1; then
  g run jobs update "$JOB" "${ARGS[@]}" >/dev/null
else
  g run jobs create "$JOB" "${ARGS[@]}" >/dev/null
fi

say "Hub 用のサービスアカウントを用意します"
g iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 ||
  g iam service-accounts create "$SA" --display-name "Upbeater Hub（クラウド Runner の起動）" >/dev/null
# この Job の起動（環境変数の上書きつき）だけを許す
g run jobs add-iam-policy-binding "$JOB" --region "$REGION" --member "serviceAccount:$SA_EMAIL" --role roles/run.developer >/dev/null

say "鍵を Hub の Secret に入れます（古い鍵は消します）"
for k in $(g iam service-accounts keys list --iam-account "$SA_EMAIL" --managed-by user --format "value(name)"); do
  g iam service-accounts keys delete "$k" --iam-account "$SA_EMAIL" >/dev/null
done
umask 077
KEY="$TMP/key.json"
g iam service-accounts keys create "$KEY" --iam-account "$SA_EMAIL" >/dev/null
(cd "$ROOT/hub" && CI=1 npx wrangler secret put GCP_SERVICE_ACCOUNT_KEY <"$KEY" >/dev/null)
rm -f "$KEY"

echo
echo "できました。hub/wrangler.jsonc の vars に次を入れて公開してください："
echo "  \"GCP_PROJECT\": \"$PROJECT\", \"GCP_REGION\": \"$REGION\", \"CLOUD_RUN_JOB\": \"$JOB\""
