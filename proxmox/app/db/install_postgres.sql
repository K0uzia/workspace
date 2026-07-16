-- Script d'installation PostgreSQL pour Proxmox Backend
-- À exécuter en tant que superutilisateur PostgreSQL (ex: psql -U postgres)

-- 1. Créer l'utilisateur (adapter le mot de passe)
CREATE USER proxmox_user WITH PASSWORD 'proxmox_password';

-- 2. Créer la base de données
CREATE DATABASE proxmox_db OWNER proxmox_user;

-- 3. Accorder les droits
GRANT ALL PRIVILEGES ON DATABASE proxmox_db TO proxmox_user;

\c proxmox_db

-- 4. Créer les tables principales

-- Table utilisateurs
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Table événements (agenda)
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(50),
  title VARCHAR(255) NOT NULL,
  start TIMESTAMP NOT NULL,
  "end" TIMESTAMP NOT NULL,
  description TEXT,
  location VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Table messages (chat)
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username VARCHAR(50),
  text TEXT NOT NULL,
  conversation_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Table lots (réception)
CREATE TABLE IF NOT EXISTS lots (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  item_count INTEGER,
  description TEXT,
  status VARCHAR(50),
  received_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

-- Table lot_items
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
  deleted_at TIMESTAMP
);

-- Soft-delete migrations (bases déjà installées)
ALTER TABLE lots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Table marques
CREATE TABLE IF NOT EXISTS marques (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL
);

-- Table modèles
CREATE TABLE IF NOT EXISTS modeles (
  id SERIAL PRIMARY KEY,
  marque_id INTEGER REFERENCES marques(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL
);

-- Table catégories de raccourcis
CREATE TABLE IF NOT EXISTS shortcut_categories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  order_index INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Table raccourcis
CREATE TABLE IF NOT EXISTS shortcuts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  url VARCHAR(255) NOT NULL,
  category_id INTEGER REFERENCES shortcut_categories(id) ON DELETE SET NULL,
  order_index INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes et optimisations
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_lot_items_lot_id ON lot_items(lot_id);
CREATE INDEX IF NOT EXISTS idx_shortcuts_user_id ON shortcuts(user_id);

-- Fin du script
