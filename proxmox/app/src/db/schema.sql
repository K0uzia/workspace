-- PostgreSQL Schema for Workspace Application
-- Phase 2: Database Migration

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Marques table (Brands for reception materials) - CREATE EARLY for references
CREATE TABLE IF NOT EXISTS marques (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marques_name ON marques(name);

-- Modeles table (Models for reception materials) - CREATE EARLY for references
CREATE TABLE IF NOT EXISTS modeles (
  id SERIAL PRIMARY KEY,
  marque_id INTEGER NOT NULL REFERENCES marques(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modeles_marque_id ON modeles(marque_id);
CREATE INDEX IF NOT EXISTS idx_modeles_name ON modeles(name);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  conversation_id VARCHAR(255),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_is_read ON messages(is_read);

-- Events table (Agenda)
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  location VARCHAR(255),
  attendees TEXT[], -- Array of user IDs or emails
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP -- Soft delete
);

CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time);
CREATE INDEX IF NOT EXISTS idx_events_end_time ON events(end_time);
CREATE INDEX IF NOT EXISTS idx_events_deleted_at ON events(deleted_at) WHERE deleted_at IS NULL;

-- Activity Logs table
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(255) NOT NULL,
  details TEXT,
  ip_address VARCHAR(45),
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_metadata ON activity_logs USING gin(metadata);

-- Shortcut categories table
CREATE TABLE IF NOT EXISTS shortcut_categories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_shortcut_categories_user_id ON shortcut_categories(user_id);
CREATE INDEX IF NOT EXISTS idx_shortcut_categories_order_index ON shortcut_categories(order_index);

-- Shortcuts table
CREATE TABLE IF NOT EXISTS shortcuts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES shortcut_categories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(100),
  url TEXT,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shortcuts_user_id ON shortcuts(user_id);
CREATE INDEX IF NOT EXISTS idx_shortcuts_order_index ON shortcuts(order_index);

-- Lots table (Réception)
CREATE TABLE IF NOT EXISTS lots (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'received',
  item_count INTEGER NOT NULL,
  description TEXT,
  received_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP,
  recovered_at TIMESTAMP,
  pdf_path VARCHAR(1024),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lots_user_id ON lots(user_id);
CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(status);
CREATE INDEX IF NOT EXISTS idx_lots_received_at ON lots(received_at DESC);

-- Lot items table (Individual items in a lot)
CREATE TABLE IF NOT EXISTS lot_items (
  id SERIAL PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  serial_number VARCHAR(255),
  type VARCHAR(100),
  marque_id INTEGER REFERENCES marques(id) ON DELETE SET NULL,
  modele_id INTEGER REFERENCES modeles(id) ON DELETE SET NULL,
  entry_type VARCHAR(50) DEFAULT 'manual',
  entry_date DATE,
  entry_time TIME,
  state VARCHAR(50),
  technician VARCHAR(255),
  state_changed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lot_items_lot_id ON lot_items(lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_items_serial_number ON lot_items(serial_number);
CREATE INDEX IF NOT EXISTS idx_lot_items_marque_id ON lot_items(marque_id);
CREATE INDEX IF NOT EXISTS idx_lot_items_modele_id ON lot_items(modele_id);

-- Disques shreddés (traçabilité sessions + disques)
CREATE TABLE IF NOT EXISTS disques_sessions (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  name VARCHAR(255),
  pdf_path VARCHAR(1024),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disques_sessions_date ON disques_sessions(date DESC);
CREATE INDEX IF NOT EXISTS idx_disques_sessions_created_at ON disques_sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS disques_session_disks (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES disques_sessions(id) ON DELETE CASCADE,
  serial VARCHAR(255) NOT NULL,
  marque VARCHAR(255),
  modele VARCHAR(255),
  size VARCHAR(100),
  disk_type VARCHAR(50),
  interface VARCHAR(50),
  shred VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disques_session_disks_session_id ON disques_session_disks(session_id);

-- Migration: name pour lots disques (déploiements existants)
ALTER TABLE IF EXISTS disques_sessions
  ADD COLUMN IF NOT EXISTS name VARCHAR(255);

-- Sessions table (for JWT/session management)
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(500) NOT NULL,
  refresh_token VARCHAR(500),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- =====================================================
-- Migrations pour déploiements existants (idempotent)
-- =====================================================
ALTER TABLE IF EXISTS lots
  ADD COLUMN IF NOT EXISTS name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS item_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

ALTER TABLE IF EXISTS lot_items
  ALTER COLUMN serial_number DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS state VARCHAR(50),
  ADD COLUMN IF NOT EXISTS technician VARCHAR(255),
  ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Add category_id to shortcuts if missing (for existing deployments)
ALTER TABLE IF EXISTS shortcuts
  ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES shortcut_categories(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_shortcuts_category_id ON shortcuts(category_id);

-- Application settings (key/value store for server config, e.g. SMTP)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Client errors and issues (auto-captured JS errors + manual feedback/issues)
CREATE TABLE IF NOT EXISTS client_errors (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(255),
  client_version VARCHAR(50),
  platform VARCHAR(50),
  error_type VARCHAR(100),
  error_message TEXT,
  error_stack TEXT,
  context TEXT,
  user_message TEXT,
  url TEXT,
  user_agent TEXT,
  timestamp TIMESTAMPTZ DEFAULT now(),
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_errors_timestamp ON client_errors(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_resolved ON client_errors(resolved);
CREATE INDEX IF NOT EXISTS idx_client_errors_type ON client_errors(error_type);

-- Config Applications (presets + apps) — persistant en base pour le client
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

-- Produits de commande (Réception - onglet Commande)
CREATE TABLE IF NOT EXISTS commande_products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commande_products_name ON commande_products(name);

-- Catégories de commande
CREATE TABLE IF NOT EXISTS commande_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commande_categories_name ON commande_categories(name);

-- Commandes (entête + lignes) — réception onglet Commande
CREATE TABLE IF NOT EXISTS commandes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(255),
  category VARCHAR(255),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  pdf_path VARCHAR(1024),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE IF EXISTS commandes
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_commandes_date ON commandes(date DESC);
CREATE INDEX IF NOT EXISTS idx_commandes_created_at ON commandes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commandes_user_id ON commandes(user_id);
CREATE INDEX IF NOT EXISTS idx_commandes_category ON commandes(category);

CREATE TABLE IF NOT EXISTS commande_lignes (
  id SERIAL PRIMARY KEY,
  commande_id INTEGER NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
  commande_product_id INTEGER REFERENCES commande_products(id) ON DELETE SET NULL,
  product_name VARCHAR(255),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2),
  shipping_cost NUMERIC(12,2),
  link TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commande_lignes_commande_id ON commande_lignes(commande_id);

-- Dons (réception)
CREATE TABLE IF NOT EXISTS dons (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  lot_name VARCHAR(255),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  pdf_path VARCHAR(1024),
  lines JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE IF EXISTS dons
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lot_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS pdf_path VARCHAR(1024),
  ADD COLUMN IF NOT EXISTS lines JSONB DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_dons_date ON dons(date DESC);
CREATE INDEX IF NOT EXISTS idx_dons_created_at ON dons(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dons_user_id ON dons(user_id);

-- Prêts matériel (réception — fiche PDF + lignes JSON)
CREATE TABLE IF NOT EXISTS prets_materiel (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reference VARCHAR(255),
  borrower_type VARCHAR(20) NOT NULL DEFAULT 'personne',
  borrower_name VARCHAR(255) NOT NULL,
  borrower_contact VARCHAR(255),
  date DATE NOT NULL,
  date_debut DATE NOT NULL,
  date_fin DATE NOT NULL,
  remuneration_gratuit BOOLEAN NOT NULL DEFAULT true,
  remuneration_montant NUMERIC(12,2),
  pdf_path VARCHAR(1024),
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prets_materiel_date_debut ON prets_materiel(date_debut DESC);
CREATE INDEX IF NOT EXISTS idx_prets_materiel_created_at ON prets_materiel(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prets_materiel_user_id ON prets_materiel(user_id);

-- Entrées réception (traçabilité entrées manuelles / lots / disques)
CREATE TABLE IF NOT EXISTS entrees (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  type VARCHAR(50) NOT NULL DEFAULT 'manual',
  lot_id INTEGER REFERENCES lots(id) ON DELETE SET NULL,
  disque_session_id INTEGER REFERENCES disques_sessions(id) ON DELETE SET NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entrees_date ON entrees(date DESC);
CREATE INDEX IF NOT EXISTS idx_entrees_type ON entrees(type);
CREATE INDEX IF NOT EXISTS idx_entrees_lot_id ON entrees(lot_id);
CREATE INDEX IF NOT EXISTS idx_entrees_disque_session_id ON entrees(disque_session_id);

-- Config Dossiers (presets + globals) — persistant en base pour le client
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

-- =====================================================
-- Migrations : colonne OS (lot_items), type/path (shortcuts)
-- =====================================================
ALTER TABLE IF EXISTS lot_items
  ADD COLUMN IF NOT EXISTS os VARCHAR(20) DEFAULT 'linux';

ALTER TABLE IF EXISTS shortcuts
  ADD COLUMN IF NOT EXISTS type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS path TEXT;
