/**
 * PostgreSQL Database Connection
 * Phase 2: Database layer
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Database configuration
const dbConfig = {
  user: process.env.DB_USER || 'workspace',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'workspace',
  password: process.env.DB_PASSWORD || 'devpass',
  port: parseInt(process.env.DB_PORT || '5432'),
  
  // Connection pool settings (Phase 5 optimization)
  max: parseInt(process.env.DB_POOL_MAX || '10'),
  min: parseInt(process.env.DB_POOL_MIN || '2'),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '2000'),
};

// Create connection pool
export const pool = new Pool(dbConfig);

// Handle pool errors
pool.on('error', (err: Error) => {
  console.error('Unexpected database pool error:', err);
});

// Test connection
export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    console.log('✅ PostgreSQL connected:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL connection error:', error);
    return false;
  }
}

// Query helper with error handling
export async function query<T extends Record<string, any> = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    
    if (duration > 100) {
      console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
    }
    
    return result;
  } catch (error) {
    console.error('Database query error:', error);
    console.error('Query:', text);
    console.error('Params:', params);
    throw error;
  }
}

// Transaction helper
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Initialize database schema
export async function initializeDatabase(): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');

    console.log('🔄 Initializing database schema...');
    await query(schema);
    console.log('✅ Database schema initialized');

    // Migrations pour colonnes ajoutées après coup (bases existantes)
    const migrations = [
      'ALTER TABLE lots ADD COLUMN IF NOT EXISTS pdf_path VARCHAR(1024)',
      'ALTER TABLE lots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP',
      'ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP',
      `CREATE TABLE IF NOT EXISTS disques_sessions (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        name VARCHAR(255),
        pdf_path VARCHAR(1024),
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_disques_sessions_date ON disques_sessions(date DESC)`,
      `CREATE TABLE IF NOT EXISTS disques_session_disks (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_disques_session_disks_session_id ON disques_session_disks(session_id)`,
      'ALTER TABLE disques_sessions ADD COLUMN IF NOT EXISTS name VARCHAR(255)',
      'ALTER TABLE disques_sessions ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMP',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS start TIMESTAMP',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS "end" TIMESTAMP',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS username VARCHAR(255)',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS color VARCHAR(50)',
      'ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS os VARCHAR(20) DEFAULT \'linux\'',
      'ALTER TABLE shortcuts ADD COLUMN IF NOT EXISTS type VARCHAR(50)',
      'ALTER TABLE shortcuts ADD COLUMN IF NOT EXISTS path TEXT',
      `CREATE TABLE IF NOT EXISTS commande_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_commande_products_name ON commande_products(name)',
      `CREATE TABLE IF NOT EXISTS commande_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_commande_categories_name ON commande_categories(name)',
      'ALTER TABLE commandes ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
      'ALTER TABLE commandes ADD COLUMN IF NOT EXISTS category VARCHAR(255)',
      'CREATE INDEX IF NOT EXISTS idx_commandes_user_id ON commandes(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_commandes_category ON commandes(category)',
      'ALTER TABLE commande_lignes ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC(12,2)',
      'ALTER TABLE commande_lignes ADD COLUMN IF NOT EXISTS link TEXT',
      `CREATE TABLE IF NOT EXISTS dons (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        lot_name VARCHAR(255),
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        pdf_path VARCHAR(1024),
        lines JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_dons_date ON dons(date DESC)',
      'CREATE INDEX IF NOT EXISTS idx_dons_created_at ON dons(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_dons_user_id ON dons(user_id)',
      `CREATE TABLE IF NOT EXISTS prets_materiel (
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
      )`,
      'CREATE INDEX IF NOT EXISTS idx_prets_materiel_date_debut ON prets_materiel(date_debut DESC)',
      'CREATE INDEX IF NOT EXISTS idx_prets_materiel_created_at ON prets_materiel(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_prets_materiel_user_id ON prets_materiel(user_id)'
    ];
    for (const sql of migrations) {
      try {
        await query(sql);
      } catch (migErr: any) {
        if (migErr?.code !== '42701') {
          console.warn('Migration (non bloquante):', (migErr as Error).message);
        }
      }
    }
    try {
      await query(`UPDATE events SET start = start_time, "end" = end_time WHERE (start IS NULL OR "end" IS NULL) AND start_time IS NOT NULL AND end_time IS NOT NULL`);
    } catch (backfillErr: any) {
      if (backfillErr?.code !== '42703') console.warn('Backfill events start/end (optionnel):', (backfillErr as Error).message);
    }
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    throw error;
  }
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  await pool.end();
  console.log('✅ Database pool closed');
}

// Export pool for direct access if needed
export default pool;
