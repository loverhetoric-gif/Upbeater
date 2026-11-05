# Upbeater のクラウド Runner（Google Cloud Run Jobs で、Linux のジョブを 1 件だけ実行して終わる）
# 組み立て：リポジトリの直下で docker build -f cloud-runner/Dockerfile .（cloud-runner/deploy.sh が Cloud Build で行う）
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY runner/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=cloud" -o /upbeater-runner .

# よく使う道具を入れておく（特定の言語・アプリに寄せない。足りない道具は各ジョブの手順で入れる）
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git git-lfs openssh-client gnupg jq unzip zip xz-utils bzip2 zstd \
      build-essential pkg-config python3 python3-pip python3-venv nodejs npm openjdk-17-jdk-headless \
      sudo procps file rsync \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1001 -s /bin/bash runner \
    && echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner
COPY --from=build /upbeater-runner /usr/local/bin/upbeater-runner
USER runner
WORKDIR /home/runner
# Hub がトークン等を環境変数で渡す（UPBEATER_HUB_URL・UPBEATER_RUNNER_ID・UPBEATER_RUNNER_TOKEN・UPBEATER_RUNNER_LABELS）
ENTRYPOINT ["/usr/local/bin/upbeater-runner", "run"]
