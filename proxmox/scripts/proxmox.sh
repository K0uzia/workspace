#!/usr/bin/env bash

# =============== Proxmox Backend Installer & Manager ===============
# Version 11.5 : backup pg_dump avant maj | compose up --build (pas de down sur maj)
# Debian 13 Trixie
#
# Sans argument + terminal interactif → menu (mise à jour vs purge légère).
# La base PostgreSQL vit dans le volume Docker : il n'est ni recréé (maj) ni
# supprimé (purge menu). Aucun "docker compose down -v" dans les flux normaux.
#
# Effacer DÉFINITIVEMENT les données PostgreSQL (rare, à éviter) :
#   I_ACCEPT_DESTROY_ALL_DATABASE_DATA=YES_I_UNDERSTAND sudo bash proxmox/scripts/proxmox.sh destroy-db-volume
#
# import.sql : racine du repo ou IMPORT_SQL_PATH= ; SKIP_IMPORT_SQL=1 pour ignorer
# (Générer import.sql là où les PDFs sont, commit/push, puis pull sur le CT — le CT n’a pas besoin des PDFs.)
# Avant mise à jour : pg_dump → proxmox/docker/backups/pre_update_*.sql.gz
#   SKIP_BACKUP_BEFORE_UPDATE=1 pour désactiver | BACKUP_KEEP_COUNT=7 (rétention)

set -euo pipefail
IFS=$'\n\t'

# =============== Configuration ===============
DB_NAME_DEFAULT="workspace_db"
DB_USER_DEFAULT="Admin"
DB_PASS_DEFAULT="lacapsule"
DB_PORT_DEFAULT=5432
API_PORT_DEFAULT=4000

# =============== Colors ===============
CYAN="\033[0;36m"; BLUE="\033[0;34m"; GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; RESET="\033[0m"; BOLD="\033[1m"

# =============== Paths ===============
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

find_repo_root() {
  # 1) override explicite
  if [[ -n "${WORKSPACE_REPO_ROOT:-}" && -d "${WORKSPACE_REPO_ROOT}/proxmox/app" && -d "${WORKSPACE_REPO_ROOT}/proxmox/docker" ]]; then
    echo "${WORKSPACE_REPO_ROOT}"
    return 0
  fi

  # 2) déterministe: uniquement relatif au script (évite de pointer vers un autre checkout → DB "vide")
  local candidate
  candidate="$(cd "$SCRIPT_DIR/../.." && pwd)"
  if [[ -d "$candidate/proxmox/app" && -d "$candidate/proxmox/docker" ]]; then
    echo "$candidate"
    return 0
  fi

  # Pas de fallback "magique" : on préfère échouer plutôt que de déployer sur un autre répertoire.
  err "Impossible de déterminer REPO_ROOT depuis le script ($candidate). Fix: export WORKSPACE_REPO_ROOT=/chemin/vers/workspace (doit contenir proxmox/app et proxmox/docker)."
}

REPO_ROOT="$(find_repo_root)"
DOCKER_DIR="$REPO_ROOT/proxmox/docker"
APP_SRC_DIR="$REPO_ROOT/proxmox/app"

# Compat si le repo est posé directement sous /usr/proxmox (sans sous-dossier proxmox/)
if [[ ! -d "$APP_SRC_DIR" && -d "$REPO_ROOT/app" && -d "$REPO_ROOT/docker" ]]; then
  DOCKER_DIR="$REPO_ROOT/docker"
  APP_SRC_DIR="$REPO_ROOT/app"
fi

SERVICE_NAME="proxmox-backend"
GLOBAL_CLI="/usr/local/bin/proxmox"
CLI_SOURCE="/usr/local/lib/proxmox-cli.sh"
ENV_FILE="$DOCKER_DIR/.env"

# =============== Logging ===============
log() { echo -e "${CYAN}[proxmox]${RESET} $*"; }
info() { echo -e "${BLUE}INFO${RESET} $*"; }
ok() { echo -e "${GREEN}OK${RESET}   $*"; }
warn() { echo -e "${YELLOW}WARN${RESET} $*"; }
err() { echo -e "${RED}ERR${RESET}  $*"; exit 1; }

# =============== Helpers ===============
require_root() {
  if [[ $EUID -ne 0 ]]; then err "Ce script doit être exécuté en tant que root."; fi
}

get_ip() { hostname -I | awk '{print $1}'; }

# Arrêt compose SANS -v : le volume nommé (ex. proxmox_postgres_data) reste sur le disque du CT.
stop_and_clean() {
  warn "Arrêt des services Proxmox (docker compose down — volumes DB conservés, pas de -v)..."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true

  if [[ -f "$DOCKER_DIR/docker-compose.yml" ]]; then
    cd "$DOCKER_DIR"
    docker compose down --remove-orphans 2>/dev/null || true
  fi

  info "Volume PostgreSQL Docker : inchangé (aucune suppression, aucune recréation)."
  ok "Arrêt terminé."
}

# Purge « disque » sans toucher aux volumes persistants (donc pas à la DB).
cmd_purge_safe() {
  require_root
  log "=== PURGE LÉGÈRE (caches Docker / images pendantes) — volume PostgreSQL intact ==="
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker absent — rien à faire."
    return 0
  fi
  info "Builder cache Docker (orphelins)..."
  docker builder prune -f 2>/dev/null || true
  info "Images Docker non utilisées (dangling uniquement, pas d'image prune -a)..."
  docker image prune -f 2>/dev/null || true
  info "Conteneurs arrêtés orphelins (sans toucher aux volumes nommés du projet)..."
  docker container prune -f 2>/dev/null || true
  warn "docker volume prune volontairement omis — les données PostgreSQL restent."
  ok "Purge légère terminée. La base sur le volume Docker du CT n'a pas été modifiée."
}

# Destruction explicite du volume DB — hors menu, variable d'environnement obligatoire.
cmd_destroy_db_volume() {
  require_root
  if [[ "${I_ACCEPT_DESTROY_ALL_DATABASE_DATA:-}" != "YES_I_UNDERSTAND" ]]; then
    err "Refusé : pour supprimer le volume PostgreSQL, exporter exactement I_ACCEPT_DESTROY_ALL_DATABASE_DATA=YES_I_UNDERSTAND puis relancer destroy-db-volume."
  fi
  warn "=== DESTRUCTION DU VOLUME POSTGRES (données irrécupérables) ==="
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  if [[ -f "$DOCKER_DIR/docker-compose.yml" ]]; then
    cd "$DOCKER_DIR"
    docker compose down -v --remove-orphans 2>/dev/null || true
  fi
  for vol in proxmox_postgres_data workspace_postgres_data; do
    if docker volume inspect "$vol" &>/dev/null; then
      warn "Suppression du volume : $vol"
      docker volume rm "$vol" 2>/dev/null || true
    fi
  done
  info "Prune Docker agressive (post-destruction volume)..."
  docker image prune -a -f 2>/dev/null || true
  docker builder prune -a -f 2>/dev/null || true
  ok "Volume DB supprimé. Une prochaine install recréera une base vide sur un volume neuf."
}

ensure_paths() {
  if [[ ! -d "$APP_SRC_DIR" ]]; then
    err "Répertoire source introuvable: $APP_SRC_DIR (REPO_ROOT=$REPO_ROOT). Astuce: export WORKSPACE_REPO_ROOT=/chemin/vers/workspace"
  fi
  mkdir -p "$DOCKER_DIR"
  mkdir -p "$(dirname "$CLI_SOURCE")"
  mkdir -p "$DOCKER_DIR/logs"
}

git_update() {
  if [[ -d "$REPO_ROOT/.git" ]]; then
    info "Mise à jour du dépôt Git..."
    cd "$REPO_ROOT"
    git fetch --all
    git reset --hard origin/proxmox || git reset --hard origin/main || true
  fi
}

generate_env() {
  info "Génération de la configuration (.env)"
  local ct_ip=$(get_ip)
  local jwt_secret
  jwt_secret=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)
  [[ -z "$jwt_secret" ]] && jwt_secret="change-me-$(date +%s)-$(openssl rand -hex 8 2>/dev/null || echo fallback)"
  local admin_token
  admin_token=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p -c 48)
  [[ -z "$admin_token" ]] && admin_token="admin-$(date +%s)"

  cat > "$ENV_FILE" <<EOF
# Configuration générée automatiquement par proxmox.sh — rien à modifier pour démarrer
NODE_ENV=production
API_PORT=${API_PORT_DEFAULT}
PORT=${API_PORT_DEFAULT}
LOG_LEVEL=info
SERVER_HOST=0.0.0.0
WS_PORT=${API_PORT_DEFAULT}

# CORS : client Electron depuis ce CT ou le réseau local
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://${ct_ip}:3000,http://${ct_ip},http://localhost

# JWT (généré à l'install)
JWT_SECRET=${jwt_secret}

# Token d'accès à la page de monitoring/admin (généré à l'install)
ADMIN_TOKEN=${admin_token}

# Base de données (Docker)
DB_HOST=db
DB_PORT=${DB_PORT_DEFAULT}
DB_NAME=${DB_NAME_DEFAULT}
DB_USER=${DB_USER_DEFAULT}
DB_PASSWORD=${DB_PASS_DEFAULT}
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_IDLE_TIMEOUT=30000
DB_CONNECTION_TIMEOUT=2000

# Compose
COMPOSE_PROJECT_NAME=proxmox
EOF

  echo ""
  info "Configuration email (envoi de PDF par mail depuis la réception)"
  if [[ -t 0 ]] && read -r -p "Configurer l'email maintenant ? [o/N] " reply && [[ "$reply" =~ ^[oOyY] ]]; then
    local mail_from="noreply@localhost"
    local smtp_host="localhost"
    local smtp_port="25"
    local smtp_secure="false"
    local smtp_user=""
    local smtp_pass=""
    read -r -p "Adresse expéditeur (MAIL_FROM) [$mail_from]: " input && [[ -n "$input" ]] && mail_from="$input"
    read -r -p "Serveur SMTP (SMTP_HOST) [$smtp_host]: " input && [[ -n "$input" ]] && smtp_host="$input"
    read -r -p "Port SMTP (SMTP_PORT) [$smtp_port]: " input && [[ -n "$input" ]] && smtp_port="$input"
    read -r -p "SMTP sécurisé (TLS) ? [o/N]: " input && [[ "$input" =~ ^[oOyY] ]] && smtp_secure="true"
    read -r -p "Utilisateur SMTP (vide si aucun): " smtp_user
    read -r -s -p "Mot de passe SMTP (vide si aucun): " smtp_pass; echo ""
    cat >> "$ENV_FILE" <<MAILEOF

# Email (configuré lors de l'install)
MAIL_FROM=${mail_from}
SMTP_HOST=${smtp_host}
SMTP_PORT=${smtp_port}
SMTP_SECURE=${smtp_secure}
SMTP_USER=${smtp_user}
SMTP_PASS=${smtp_pass}
MAILEOF
    ok "Email enregistré dans .env"
  else
    cat >> "$ENV_FILE" <<'EOF'

# Email (défaut — pas d'envoi réel)
MAIL_FROM=noreply@localhost
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EOF
    ok "Config générée (IP: $ct_ip). Email non configuré (défaut localhost)."
  fi
}

# =============== SQL Script (FIX: Support start & start_time) ===============
prepare_sql_script() {
  cat <<'SQLEOF' > /tmp/proxmox_schema.sql
\c workspace_db

-- 1. Création standard
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255),
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(50),
  title VARCHAR(255) NOT NULL,
  start TIMESTAMP NOT NULL,       -- Colonne principale (pour GET)
  "end" TIMESTAMP NOT NULL,       -- Colonne principale
  start_time TIMESTAMP GENERATED ALWAYS AS (start) STORED,    -- Alias pour Init
  end_time TIMESTAMP GENERATED ALWAYS AS ("end") STORED,    -- Alias pour Init
  description TEXT,
  location VARCHAR(255),
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username VARCHAR(50),
  text TEXT NOT NULL,
  conversation_id INTEGER,
  is_read BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lots (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255),
  item_count INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'received',
  received_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP,
  recovered_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lot_items (
  id SERIAL PRIMARY KEY,
  lot_id INTEGER REFERENCES lots(id) ON DELETE CASCADE,
  serial_number VARCHAR(255),
  type VARCHAR(50),
  marque_id INTEGER,
  modele_id INTEGER,
  entry_type VARCHAR(50),
  entry_date DATE,
  entry_time TIME,
  state VARCHAR(50),
  technician VARCHAR(255),
  state_changed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marques (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS modeles (
  id SERIAL PRIMARY KEY,
  marque_id INTEGER REFERENCES marques(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shortcut_categories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  order_index INTEGER,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS shortcuts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  url VARCHAR(255) NOT NULL,
  category_id INTEGER REFERENCES shortcut_categories(id) ON DELETE SET NULL,
  order_index INTEGER,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Migrations Unifiées
-- Fix Users password
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password') THEN
        ALTER TABLE users RENAME COLUMN "password" TO password_hash;
    END IF;
END $$;

-- Fix Events (Support des deux noms)
DO $$ BEGIN
    -- Si on a V9 (start_time existe) mais pas start -> Renommer en start
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='start_time') 
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='start') THEN
        ALTER TABLE events RENAME COLUMN start_time TO start;
        ALTER TABLE events RENAME COLUMN end_time TO "end";
    END IF;

    -- Ajouter les colonnes générées si manquantes (Compatible V9 & V10)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='start_time') THEN
        ALTER TABLE events ADD COLUMN start_time TIMESTAMP GENERATED ALWAYS AS (start) STORED;
        ALTER TABLE events ADD COLUMN end_time TIMESTAMP GENERATED ALWAYS AS ("end") STORED;
    END IF;
END $$;

-- Ajout Colonnes manquantes standard
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE shortcuts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE shortcut_categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS state VARCHAR(50);
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS technician VARCHAR(255);
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMP;
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE marques ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE modeles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Rôles utilisateurs
UPDATE users SET role = 'admin' WHERE username = 'sandersonn' AND (role IS NULL OR role = 'user');

-- Migration hash : les anciens hashes SHA256 (64 chars hex) sont incompatibles avec bcrypt.
-- On les invalide pour forcer la réinitialisation du mot de passe via le panel admin.
UPDATE users SET password_hash = NULL
  WHERE password_hash IS NOT NULL
    AND LENGTH(password_hash) = 64
    AND password_hash ~ '^[0-9a-f]+$';

-- Fix is_read, Lots, Shortcuts
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'received';
ALTER TABLE lots ADD COLUMN IF NOT EXISTS item_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS received_at TIMESTAMP DEFAULT NOW();
ALTER TABLE lots ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMP;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS pdf_path VARCHAR(1024);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE lots ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE shortcuts ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES shortcut_categories(id) ON DELETE CASCADE;

-- 3. Index
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_shortcuts_user_id ON shortcuts(user_id);
CREATE INDEX IF NOT EXISTS idx_shortcuts_category_id ON shortcuts(category_id);
CREATE INDEX IF NOT EXISTS idx_lots_user_id ON lots(user_id);
CREATE INDEX IF NOT EXISTS idx_lot_items_lot_id ON lot_items(lot_id);

-- 4. Table pour le monitoring des erreurs clients Electron
CREATE TABLE IF NOT EXISTS client_errors (
    id SERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_version TEXT,
    platform TEXT,
    error_type TEXT NOT NULL,
    error_message TEXT NOT NULL,
    error_stack TEXT,
    context TEXT,
    user_message TEXT,
    url TEXT,
    user_agent TEXT,
    timestamp TIMESTAMP DEFAULT NOW(),
    resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP,
    resolved_by TEXT,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_client_errors_timestamp ON client_errors(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_client_id ON client_errors(client_id);
CREATE INDEX IF NOT EXISTS idx_client_errors_error_type ON client_errors(error_type);
CREATE INDEX IF NOT EXISTS idx_client_errors_resolved ON client_errors(resolved);
CREATE INDEX IF NOT EXISTS idx_client_errors_type_timestamp ON client_errors(error_type, timestamp DESC);

-- Config Applications et Dossiers (persistant pour le client)
CREATE TABLE IF NOT EXISTS app_presets (
  id SERIAL PRIMARY KEY,
  preset_key VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_presets_key ON app_presets(preset_key);

CREATE TABLE IF NOT EXISTS app_preset_apps (
  id SERIAL PRIMARY KEY,
  app_preset_id INTEGER NOT NULL REFERENCES app_presets(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  command VARCHAR(500) NOT NULL,
  icon VARCHAR(100) DEFAULT 'fa-rocket',
  args TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_preset_apps_preset ON app_preset_apps(app_preset_id);

CREATE TABLE IF NOT EXISTS folder_globals (
  id SERIAL PRIMARY KEY,
  blacklist TEXT,
  ignore_suffixes TEXT,
  ignore_extensions TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS folder_presets (
  id SERIAL PRIMARY KEY,
  preset_key VARCHAR(100) NOT NULL UNIQUE,
  base_path VARCHAR(1024) NOT NULL DEFAULT '',
  blacklist TEXT,
  ignore_suffixes TEXT,
  ignore_extensions TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_folder_presets_key ON folder_presets(preset_key);
SQLEOF
}

# Schéma applicatif complet (commandes, disques, dons, prêts, …) — source de vérité dans le repo
APP_SCHEMA_SQL="$APP_SRC_DIR/src/db/schema.sql"

# Sauvegarde logique avant mise à jour (même volume / conteneurs mis à jour, pas recréés vides).
# Appeler depuis $DOCKER_DIR ; n'utilise pas docker compose down.
backup_postgres_before_update() {
  local out_dir="$DOCKER_DIR/backups"
  mkdir -p "$out_dir"
  local ts f
  ts="$(date +%Y%m%d_%H%M%S)"
  f="$out_dir/pre_update_${ts}.sql.gz"
  info "Sauvegarde PostgreSQL (avant mise à jour) → $f"

  if ! docker compose ps --services --status running 2>/dev/null | grep -qx 'db'; then
    info "Conteneur db non démarré — démarrage minimal pour pg_dump..."
    docker compose up -d db 2>/dev/null || true
  fi

  local w
  for w in {1..40}; do
    if docker compose exec -T db pg_isready -U "$DB_USER_DEFAULT" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! docker compose exec -T db pg_isready -U "$DB_USER_DEFAULT" >/dev/null 2>&1; then
    warn "PostgreSQL indisponible — impossible de sauvegarder. Vérifie la stack ou lance : docker compose up -d db"
    return 1
  fi

  if docker compose exec -T db pg_dump -U "$DB_USER_DEFAULT" -d "$DB_NAME_DEFAULT" --no-owner --no-acl 2>/dev/null | gzip -c >"$f"; then
    if [[ -s "$f" ]]; then
      ok "Backup OK ($(du -h "$f" 2>/dev/null | awk '{print $1}' || echo '?'))"
    else
      rm -f "$f"
      warn "pg_dump vide — fichier supprimé."
      return 1
    fi
  else
    rm -f "$f"
    warn "pg_dump a échoué."
    return 1
  fi

  local keep="${BACKUP_KEEP_COUNT:-7}"
  if [[ "$keep" =~ ^[0-9]+$ ]] && [[ "$keep" -ge 1 ]]; then
    ls -1t "$out_dir"/pre_update_*.sql.gz 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do
      [[ -z "$old" ]] && continue
      rm -f "$old"
      info "Rotation sauvegardes : suppression $(basename "$old")"
    done
  fi
  return 0
}

# À appeler depuis $DOCKER_DIR avec le service db déjà up.
apply_db_schemas_and_import() {
  if [[ -f "$APP_SCHEMA_SQL" ]]; then
    info "Schéma applicatif : $APP_SCHEMA_SQL"
    if docker compose exec -T db psql -U "$DB_USER_DEFAULT" -d "$DB_NAME_DEFAULT" -v ON_ERROR_STOP=1 < "$APP_SCHEMA_SQL"; then
      ok "Schéma applicatif appliqué."
    else
      warn "Schéma applicatif : erreur (voir ci-dessus). Poursuite avec migrations embarquées."
    fi
  else
    warn "Fichier introuvable : $APP_SCHEMA_SQL (tables commandes/disques/dons/prêts peuvent manquer pour import.sql)."
  fi

  docker compose exec -T db psql -U "$DB_USER_DEFAULT" -d "$DB_NAME_DEFAULT" < /tmp/proxmox_schema.sql && ok "Migrations embarquées (proxmox_schema) OK." || warn "Migrations embarquées : erreur partielle."

  if [[ "${SKIP_IMPORT_SQL:-}" == "1" ]]; then
    info "SKIP_IMPORT_SQL=1 — aucun import SQL fichier."
  else
    local import_file="${IMPORT_SQL_PATH:-$REPO_ROOT/import.sql}"
    if [[ -f "$import_file" ]]; then
      info "Injection SQL (données) : $import_file"
      if docker compose exec -T db psql -U "$DB_USER_DEFAULT" -d "$DB_NAME_DEFAULT" -v ON_ERROR_STOP=1 < "$import_file"; then
        ok "import.sql appliqué."
      else
        warn "import.sql : échec (contraintes uniques, doublons, ou schéma incomplet). Les données déjà présentes ne sont pas effacées."
      fi
    else
      info "Pas de fichier import ($import_file). Aucune injection. Générer puis copier import.sql à la racine du workspace ou définir IMPORT_SQL_PATH."
    fi
  fi
}

run_db_setup() {
  prepare_sql_script
  info "Configuration de la base de données..."
  if command -v docker >/dev/null 2>&1; then
    cd "$DOCKER_DIR"
    local max_attempts=3
    local attempt=1
    local ok=false
    while [[ $attempt -le $max_attempts ]]; do
      info "Tentative $attempt/$max_attempts : démarrage PostgreSQL (pull Docker Hub si besoin)..."
      if docker compose up -d db; then
        ok=true
        break
      fi
      if [[ $attempt -lt $max_attempts ]]; then
        warn "Échec (réseau ?). Nouvelle tentative dans 15 s..."
        sleep 15
        attempt=$((attempt + 1))
      else
        err "Impossible de démarrer la base de données."
        echo ""
        echo -e "${YELLOW}Cause probable : le CT ne peut pas joindre Docker Hub (registry-1.docker.io).${RESET}"
        echo "  - Vérifier l'accès internet / DNS du conteneur."
        echo "  - Réessayer plus tard : sudo bash proxmox/scripts/proxmox.sh install"
        echo "  - Ou lancer uniquement la DB après coup : cd proxmox/docker && docker compose up -d db"
        exit 1
      fi
    done
    info "Attente PostgreSQL..."
    for i in {1..30}; do
      if docker compose exec -T db pg_isready -U "$DB_USER_DEFAULT" >/dev/null 2>&1; then
        ok "PostgreSQL prêt"; break
      fi
      echo -n "."; sleep 1
    done
    echo
    sleep 2
    apply_db_schemas_and_import
    docker compose down
  fi
  rm -f /tmp/proxmox_schema.sql
}

npm_build() {
  info "Build Node.js..."
  cd "$APP_SRC_DIR"
  npm install --legacy-peer-deps && npm run build
  ok "Build terminé."
}

docker_build_images() {
  info "Construction images..."
  cd "$DOCKER_DIR"
  docker compose build --no-cache
  ok "Images prêtes."
}

install_systemd() {
  info "Configuration Systemd..."
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Proxmox Backend (Docker)
After=network-online.target docker.service
Wants=network-online.target docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${DOCKER_DIR}
ExecStart=/usr/bin/docker compose up -d
# stop (pas down) : garde réseau/volumes, évite de tout démonter comme un « nouveau déploiement »
ExecStop=/usr/bin/docker compose stop
TimeoutStartSec=0
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  ok "Service activé."
}

# =============== CLI Installation ===============
install_cli() {
  info "Installation CLI (V11.1 - Logs Docker)..."
  cat > "$CLI_SOURCE" <<'CLISCRIPT'
#!/usr/bin/env bash
set -euo pipefail

CYAN=$'\033[0;36m'; BLUE=$'\033[0;34m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; RESET=$'\033[0m'; BOLD=$'\033[1m'

ok() { echo -e "${GREEN}OK${RESET}   $*"; }
warn() { echo -e "${YELLOW}WARN${RESET} $*"; }
err() { echo -e "${RED}ERR${RESET}  $*"; }
header() { echo -e "${CYAN}${BOLD}$*${RESET}"; }

SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ -L "$SCRIPT_PATH" ]]; then SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"; fi

# Trouver le répertoire workspace (chercher proxmox/docker depuis plusieurs chemins possibles)
REPO_ROOT=""
for possible_root in "/root/workspace" "$HOME/workspace" "/home/$(whoami)/workspace" "$(dirname "$SCRIPT_PATH")/../.."; do
  if [[ -d "$possible_root/proxmox/docker" ]]; then
    REPO_ROOT="$(cd "$possible_root" && pwd)"
    break
  fi
done

# Si toujours pas trouvé, essayer de remonter depuis le script
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
  # Vérifier que c'est bien le bon répertoire
  if [[ ! -d "$REPO_ROOT/proxmox/docker" ]]; then
    REPO_ROOT=""
  fi
fi

# Si toujours pas trouvé, utiliser le chemin par défaut
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="/root/workspace"
fi

DOCKER_DIR="$REPO_ROOT/proxmox/docker"
SERVICE_NAME="proxmox-backend"
API_URL="http://localhost:4000"

# Vérifier que le répertoire Docker existe
if [[ ! -d "$DOCKER_DIR" ]]; then
  err "Répertoire Docker introuvable: $DOCKER_DIR. REPO_ROOT=$REPO_ROOT"
fi

get_api_name() {
  docker ps -a --format "{{.Names}}" | grep -E "workspace-proxmox|proxmox.*api" | head -1
}
get_db_name() {
  docker ps -a --format "{{.Names}}" | grep -E "workspace-db|proxmox.*db" | head -1
}

show_diagnostics() {
  echo ""
  header "=== DIAGNOSTIC DOCKER ==="
  api_name=$(get_api_name)
  db_name=$(get_db_name)
  
  echo "1. Conteneurs détectés :"
  docker ps -a --filter "name=proxmox" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" || true
  echo ""
  
  echo "2. Logs API (${api_name:-Inconnu}) :"
  if [[ -n "$api_name" ]]; then
    docker logs "$api_name" --tail 50
  else
    warn "Impossible de trouver le conteneur API."
  fi
  echo ""
  
  echo "3. Logs DB (${db_name:-Inconnu}) :"
  if [[ -n "$db_name" ]]; then
    docker logs "$db_name" --tail 20
  else
    warn "Impossible de trouver le conteneur DB."
  fi
  echo ""
}

draw_table_header() {
  local border="+-------------------------+-------------------------+"
  echo "$border"
  printf "| %-23s | %-23s |\n" "$1" "$2"
  echo "$border"
}

draw_table_row() {
  printf "| %-23s | %-23b |\n" "$1" "$2"
}

draw_table_footer() {
  echo "+-------------------------+-------------------------+"
}

status_table() {
  set +e  # Désactiver erreur immédiate pour cette fonction
  api_name=$(get_api_name)
  db_name=$(get_db_name)
  
  api_status="${RED}STOPPED${RESET}"
  db_status="${RED}STOPPED${RESET}"
  sys_status=$(systemctl is-active proxmox-backend 2>/dev/null || echo "unknown")
  ip=$(hostname -I | awk '{print $1}')
  
  if [[ -n "$api_name" ]] && docker inspect "$api_name" --format '{{.State.Status}}' 2>/dev/null | grep -iq "running"; then api_status="${GREEN}RUNNING${RESET}"; fi
  if [[ -n "$db_name" ]] && docker inspect "$db_name" --format '{{.State.Status}}' 2>/dev/null | grep -iq "running"; then db_status="${GREEN}RUNNING${RESET}"; fi

  if curl -fsS "$API_URL/api/health" >/dev/null 2>&1; then 
    web_status="${GREEN}ONLINE${RESET}"; 
  else 
    web_status="${RED}OFFLINE${RESET}"; 
  fi
  ws_status="$web_status"
  set -e  # Réactiver erreur immédiate

  echo -e "\n${CYAN}${BOLD}=== Proxmox Backend Status ===${RESET}\n"
  draw_table_header "Service" "État"
  draw_table_row "Systemd" "${sys_status^^}"
  draw_table_row "Container API" "$api_status"
  draw_table_row "Container DB" "$db_status"
  draw_table_row "API HTTP" "$web_status"
  draw_table_row "WebSocket" "$ws_status"
  draw_table_row "Accès" "http://$ip:4000"
  draw_table_footer
  echo
}

show_endpoints() {
  ip=$(hostname -I | awk '{print $1}')
  echo -e "\n${CYAN}${BOLD}=== Endpoints API (GET / POST) ===${RESET}\n"
  draw_table_header "Méthode" "URL"
  local endpoints=(
    "GET:/api/health"
    "GET:/api/metrics"
    "GET:/api/monitoring/stats"
    "GET:/api/agenda/events"
    "GET:/api/agenda/events/:id"
    "POST:/api/agenda/events"
    "PUT:/api/agenda/events/:id"
    "DELETE:/api/agenda/events/:id"
    "POST:/api/auth/login"
    "POST:/api/auth/register"
    "POST:/api/auth/logout"
    "GET:/api/auth/verify"
    "GET:/api/events"
    "POST:/api/events"
    "GET:/api/messages"
    "POST:/api/messages"
    "GET:/api/lots"
    "POST:/api/lots"
    "GET:/api/lots/:id"
    "PUT:/api/lots/:id"
    "POST:/api/lots/:id/pdf"
    "GET:/api/lots/:id/pdf"
    "POST:/api/lots/:id/email"
    "GET:/api/shortcuts"
    "POST:/api/shortcuts"
    "GET:/api/shortcuts/categories"
    "POST:/api/shortcuts/categories"
    "GET:/api/marques"
    "GET:/api/marques/all"
    "POST:/api/marques"
    "GET:/api/marques/:id/modeles"
    "POST:/api/modeles"
  )
  for ep in "${endpoints[@]}"; do
    IFS=':' read -r method route <<< "$ep"
    draw_table_row "$method" "http://$ip:4000$route"
  done
  draw_table_footer
  echo -e "\nWebSocket: ws://$ip:4000  ou  ws://$ip:4000/ws"
  echo
}

run_tests() {
  set +e
  local user="AdminTest"
  local pass="AdminTest@123"
  local token=""

  echo -e "\n${CYAN}--- [TEST API CLIENT COMPLET] ---${RESET}\n"

  echo "1. Configuration utilisateur de test..."
  curl -s -X POST "$API_URL/api/auth/register" -H "Content-Type: application/json" -d "{\"username\":\"$user\",\"password\":\"$pass\"}" >/dev/null
  ok "Utilisateur $user prêt"

  echo "2. Authentification..."
  token=$(curl -s -X POST "$API_URL/api/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"$user\",\"password\":\"$pass\"}" | grep -o '"token":"[^"]*"' | cut -d '"' -f4)
  if [[ -z "$token" ]]; then 
    echo -e "${RED}Login FAIL${RESET}"; 
    show_diagnostics
    return 1; 
  fi
  ok "Login OK"

  declare -A endpoints
  endpoints[GET]="/api/health /api/metrics /api/monitoring/stats /api/events /api/messages /api/lots /api/shortcuts /api/shortcuts/categories /api/marques /api/marques/all /api/agenda/events /api/auth/verify"
  endpoints[POST]="/api/auth/login /api/auth/logout /api/auth/verify /api/events /api/messages /api/lots /api/shortcuts /api/shortcuts/categories /api/marques"

  local protected="/api/metrics /api/monitoring/stats /api/events /api/messages /api/lots /api/shortcuts /api/shortcuts/categories /api/marques /api/marques/all /api/agenda/events /api/auth/logout /api/auth/verify"

  echo "3. Tests des Endpoints..."
  for method in GET POST; do
    for ep in ${endpoints[$method]}; do
      [[ -z "$ep" ]] && continue
      local url="$API_URL$ep"
      local http_code="000"
      
      local extra_args=()
      if [[ " $protected " == *" $ep "* && -n "$token" ]]; then
        extra_args+=(-H "Authorization: Bearer $token")
      fi
      
      if [[ "$ep" == "/api/events" || "$ep" == "/api/messages" || "$ep" == "/api/shortcuts" || "$ep" == "/api/shortcuts/categories" ]]; then
        url+="?userId=1"
      fi

      if [[ "$method" == "POST" ]]; then
        local data="{}"
        case "$ep" in
          "/api/auth/login") data="{\"username\":\"$user\",\"password\":\"$pass\"}" ;;
          "/api/auth/logout") data="{}" ;;
          "/api/auth/verify") data="{}" ;;
          "/api/events") data="{\"title\":\"Test Auto\",\"start\":\"2026-01-01T10:00:00Z\",\"end\":\"2026-01-01T11:00:00Z\",\"description\":\"Test\",\"location\":\"Salle Test\"}" ;;
          "/api/marques") data="{\"name\":\"TestMarque\"}" ;;
          "/api/messages") data="{\"text\":\"Test cleanup\",\"pseudo\":\"AdminTest\"}" ;;
          "/api/lots") data="{\"itemCount\":1,\"description\":\"Lot Test API\"}" ;;
          "/api/shortcuts") data="{\"title\":\"API Test\",\"url\":\"https://test.local\"}" ;;
          "/api/shortcuts/categories") data="{\"name\":\"Catégorie API\"}" ;;
        esac

        http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" -H "Content-Type: application/json" "${extra_args[@]}" -d "$data")
      else
        http_code=$(curl -s -o /dev/null -w "%{http_code}" "$url" "${extra_args[@]}")
      fi
      
      if [[ "$http_code" == "200" || "$http_code" == "201" || "$http_code" == "204" ]]; then
        echo -e "${GREEN}OK${RESET}   $method $ep"
      else
        echo -e "${RED}FAIL${RESET} $method $ep ($http_code)"
      fi
    done
  done

  echo "4. Nettoyage..."
  ok "Tests terminés."
  set -e
}

cmd="${1:-status}"
case "$cmd" in
  start)
    header "Démarrage Systemd..."
    systemctl start proxmox-backend
    echo "Attente de stabilisation (5s)..."
    sleep 5
    is_running=false
    api_name=$(get_api_name)
    if [[ -n "$api_name" ]] && docker inspect "$api_name" --format '{{.State.Status}}' 2>/dev/null | grep -iq "running"; then
      is_running=true
    fi
    
    if [[ "$is_running" == "false" ]]; then
      echo -e "${RED}!!! ERREUR : Le conteneur API ne démarre pas !!!${RESET}"
      echo -e "${YELLOW}Lancement du diagnostic automatique...${RESET}"
      show_diagnostics
    else
      status_table
    fi
    ;;
  stop) systemctl stop proxmox-backend && ok "Arrêté." ;;
  restart) 
    systemctl restart proxmox-backend 
    sleep 5 
    status_table 
    ;;
  rebuild)
    cd "$DOCKER_DIR" && docker compose build --no-cache && systemctl restart proxmox-backend && sleep 5 && status_table
    ;;
  # MODIFIE : Affiche les logs Docker (Requêtes / Réponses) au lieu de Systemd
  logs)
    shift || true
    api_name=$(get_api_name)
    if [[ -z "$api_name" ]]; then
      err "Impossible de trouver le conteneur API."
    fi
    if [[ "${1:-}" == "live" ]]; then
      docker logs -f "$api_name"
    else
      docker logs --tail 100 "$api_name"
    fi
    ;;
  status) 
    status_table || true
    ;;
  endpoints) show_endpoints ;;
  debug|diag) show_diagnostics ;;
  test-api|api-test) run_tests ;;
  help|--help|-h)
    echo "Usage: proxmox [start|stop|restart|rebuild|logs|status|endpoints|debug|test-api]"
    echo "  logs     : Affiche les logs Docker (Requêtes HTTP, etc)"
    echo "  logs live: Affiche les logs Docker en continu"
    echo "  endpoints: Liste tous les endpoints API (GET/POST/PUT/DELETE) et WebSocket"
    ;;
  *) 
    status_table || true
    ;;
esac
CLISCRIPT

  chmod +x "$CLI_SOURCE"
  ln -sf "$CLI_SOURCE" "$GLOBAL_CLI"
  ok "CLI installée."
}

# =============== Main ===============
cmd_install() {
  require_root
  log "=== INSTALLATION / RÉPARATION (volume PostgreSQL Docker conservé) ==="
  stop_and_clean
  ensure_paths
  git_update
  if [[ -f "$ENV_FILE" ]]; then
    info "Fichier .env existant — conservation (JWT, ADMIN_TOKEN, mot de passe DB). Pour tout régénérer : rm \"$ENV_FILE\" puis relancer install."
  else
    generate_env
  fi
  npm_build
  docker_build_images
  run_db_setup
  install_systemd
  install_cli
  ok "Installation terminée."
  echo ""
  echo -e "${GREEN}Pour démarrer le serveur :${RESET}  ${BOLD}proxmox start${RESET}"
  echo -e "Puis statut / logs :  ${BOLD}proxmox status${RESET}  |  ${BOLD}proxmox logs${RESET}"
  echo -e "${YELLOW}Base PostgreSQL :${RESET} toujours sur le même volume Docker du CT (non recréé)."
  echo ""
}

cmd_start() { /usr/local/bin/proxmox start; }
cmd_stop() { require_root; systemctl stop "$SERVICE_NAME"; ok "Arrêté."; }
cmd_restart() { require_root; systemctl restart "$SERVICE_NAME"; sleep 3; /usr/local/bin/proxmox status; }
cmd_status() { /usr/local/bin/proxmox status; }
cmd_test() { /usr/local/bin/proxmox test-api; }
cmd_menu() {
  require_root
  while true; do
    echo ""
    log "=== Proxmox backend (sur le CT) — choisir une action ==="
    echo -e "  ${BOLD}1${RESET}  ${GREEN}Mise à jour${RESET} — backup PostgreSQL, Git, build panel/API, puis docker compose up --build (sans down)."
    echo "      → ${BOLD}Volume PostgreSQL${RESET} inchangé ; conteneurs mis à jour (même projet, pas de stack neuve)."
    echo ""
    echo -e "  ${BOLD}2${RESET}  ${YELLOW}Purge légère${RESET} — caches Docker (builder, images pendantes, conteneurs orphelins)."
    echo "      → ${BOLD}Aucune${RESET} suppression du volume où la base est enregistrée (pas de docker volume rm / prune des volumes)."
    echo ""
    echo -e "  ${BOLD}3${RESET}  ${BLUE}Installation / réparation complète${RESET} — build images, schéma DB, systemd, CLI (comme une 1ʳᵉ install mais DB conservée)."
    echo ""
    echo -e "  ${BOLD}q${RESET}  Quitter"
    echo ""
    read -r -p "Choix [1-3 ou q] : " choice || true
    case "${choice:-}" in
      1) cmd_update; break ;;
      2) cmd_purge_safe; break ;;
      3) cmd_install; break ;;
      q|Q) info "Au revoir."; exit 0 ;;
      *) warn "Choix invalide (tape 1, 2, 3 ou q)." ;;
    esac
  done
}

# Mise à jour : backup → Git → build → compose up --build (pas de systemctl restart / compose down)
cmd_update() {
  require_root
  log "=== MISE À JOUR (backup DB + Git + build + compose up --build + migrations) ==="
  ensure_paths
  cd "$DOCKER_DIR"

  if [[ "${SKIP_BACKUP_BEFORE_UPDATE:-}" == "1" ]]; then
    info "SKIP_BACKUP_BEFORE_UPDATE=1 — aucune sauvegarde pg_dump."
  else
    backup_postgres_before_update || warn "Pas de backup fichier — poursuite de la mise à jour."
  fi

  git_update
  if [[ ! -f "$ENV_FILE" ]]; then
    generate_env
  else
    info ".env conservé."
  fi
  npm_build

  cd "$DOCKER_DIR"
  info "Mise à jour des conteneurs : docker compose up -d --build (rebuild + redémarrage, sans compose down)..."
  docker compose up -d --build --remove-orphans

  if systemctl is-enabled "$SERVICE_NAME" &>/dev/null && ! systemctl is-active "$SERVICE_NAME" &>/dev/null; then
    info "Service systemd inactif — marquage actif (oneshot déjà « actif » si déjà démarré manuellement)."
    systemctl start "$SERVICE_NAME" 2>/dev/null || true
  fi

  info "Attente PostgreSQL..."
  local i
  for i in {1..45}; do
    if docker compose exec -T db pg_isready -U "$DB_USER_DEFAULT" >/dev/null 2>&1; then
      ok "PostgreSQL prêt"
      break
    fi
    echo -n "."
    sleep 1
  done
  echo
  sleep 2
  prepare_sql_script
  apply_db_schemas_and_import
  rm -f /tmp/proxmox_schema.sql
  ok "Mise à jour terminée. Sauvegardes : $DOCKER_DIR/backups/ — vérifier : proxmox status"
}

if [[ $# -eq 0 ]]; then
  if [[ -t 0 ]]; then
    cmd_menu
    exit 0
  fi
  echo "Usage: $0 <commande>   (sans TTY : pas de menu interactif)" >&2
  set -- help
fi

COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  install) cmd_install "$@" ;;
  menu) cmd_menu ;;
  purge|purge-safe) cmd_purge_safe ;;
  destroy-db-volume) cmd_destroy_db_volume ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  test-api|api-test) cmd_test ;;
  update) cmd_update ;;
  help|--help|-h)
    echo "Usage: $0 [menu|update|purge|install|destroy-db-volume|start|stop|restart|status|test-api|help]"
    echo ""
    echo "  (sans argument, en terminal)  menu interactif — mise à jour ou purge légère, sans toucher au volume PostgreSQL."
    echo "  update              Backup pg_dump, Git + build, compose up --build, migrations + import.sql."
    echo "  purge               Nettoie caches/images Docker orphelins (ne supprime pas la DB)."
    echo "  install             Installation ou réparation complète (volume DB inchangé)."
    echo "  destroy-db-volume   SUPPRIME le volume PostgreSQL (données perdues). Nécessite :"
    echo "                      I_ACCEPT_DESTROY_ALL_DATABASE_DATA=YES_I_UNDERSTAND"
    ;;
  *) echo "Usage: $0 [menu|update|purge|install|start|stop|restart|status|test-api|help]" >&2; exit 1 ;;
esac