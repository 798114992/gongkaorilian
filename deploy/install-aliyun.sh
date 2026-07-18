#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="https://github.com/798114992/gongkaorilian.git"
APP_ROOT="/opt/gongkaorilian"
APP_DIR="${APP_ROOT}/app"
DATA_DIR="${APP_ROOT}/data"
BACKUP_DIR="${APP_ROOT}/backups"
ENV_FILE="/etc/gongkaorilian.env"
SERVICE_FILE="/etc/systemd/system/gongkaorilian.service"
NGINX_FILE="/etc/nginx/sites-available/gongkaorilian"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nginx openssl sqlite3 build-essential python3

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pnpm@11.9.0

if ! id gongkao >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/gongkao --shell /bin/bash gongkao
fi
install -d -o gongkao -g gongkao "${APP_ROOT}" "${DATA_DIR}" "${DATA_DIR}/media" "${BACKUP_DIR}"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  runuser -u gongkao -- git clone --depth 1 --branch main "${REPOSITORY_URL}" "${APP_DIR}"
else
  runuser -u gongkao -- git -C "${APP_DIR}" pull --ff-only origin main
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  ADMIN_TOKEN="$(openssl rand -hex 20)"
  INTERNAL_JOB_SECRET="$(openssl rand -hex 32)"
  cat >"${ENV_FILE}" <<EOF
NODE_ENV=production
PORT=3000
ADMIN_TOKEN=${ADMIN_TOKEN}
INTERNAL_JOB_SECRET=${INTERNAL_JOB_SECRET}
SQLITE_PATH=${DATA_DIR}/gongkaorilian.sqlite
MEDIA_PATH=${DATA_DIR}/media
RUNTIME_SCHEMA_BOOTSTRAP=migrated
PAYMENT_TEST_MODE=false
EOF
  chmod 600 "${ENV_FILE}"
  printf '%s\n' "${ADMIN_TOKEN}" >"/root/gongkaorilian-initial-admin-password.txt"
  chmod 600 "/root/gongkaorilian-initial-admin-password.txt"
fi

runuser -u gongkao -- bash -lc "cd '${APP_DIR}' && pnpm install --frozen-lockfile && pnpm run build:node"

cat >"${SERVICE_FILE}" <<EOF
[Unit]
Description=Gongkao Rilian web application
After=network.target

[Service]
Type=simple
User=gongkao
Group=gongkao
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/pnpm run start:node
Restart=always
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

cat >"${NGINX_FILE}" <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sfn "${NGINX_FILE}" /etc/nginx/sites-enabled/gongkaorilian
rm -f /etc/nginx/sites-enabled/default

cat >/usr/local/sbin/gongkaorilian-backup <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
STAMP="\$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"
sqlite3 "${DATA_DIR}/gongkaorilian.sqlite" ".backup '${BACKUP_DIR}/gongkaorilian-\${STAMP}.sqlite'"
find "${BACKUP_DIR}" -type f -name 'gongkaorilian-*.sqlite' -mtime +14 -delete
EOF
chmod 750 /usr/local/sbin/gongkaorilian-backup

cat >/etc/systemd/system/gongkaorilian-backup.service <<'EOF'
[Unit]
Description=Backup Gongkao Rilian database

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/gongkaorilian-backup
EOF

cat >/etc/systemd/system/gongkaorilian-backup.timer <<'EOF'
[Unit]
Description=Daily Gongkao Rilian database backup

[Timer]
OnCalendar=*-*-* 03:20:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat >/usr/local/sbin/gongkaorilian-update <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
runuser -u gongkao -- git -C "${APP_DIR}" pull --ff-only origin main
runuser -u gongkao -- bash -lc "cd '${APP_DIR}' && pnpm install --frozen-lockfile && pnpm run build:node"
systemctl restart gongkaorilian
curl --fail --silent --show-error --retry 10 --retry-delay 2 http://127.0.0.1:3000/ >/dev/null
echo "Gongkao Rilian updated successfully."
EOF
chmod 750 /usr/local/sbin/gongkaorilian-update

nginx -t
systemctl daemon-reload
systemctl enable --now gongkaorilian
systemctl enable --now nginx
systemctl enable --now gongkaorilian-backup.timer

curl --fail --silent --show-error --retry 20 --retry-delay 2 http://127.0.0.1:3000/ >/dev/null
curl --fail --silent --show-error --retry 5 --retry-delay 2 http://127.0.0.1:3000/api/app >/dev/null

echo "DEPLOYMENT_OK"
echo "Initial admin password is stored in /root/gongkaorilian-initial-admin-password.txt"
