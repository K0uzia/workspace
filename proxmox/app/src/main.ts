import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { registerMonitoringRoutes, incrementMessageCount } from './api/monitoring';
import { registerClientErrorsRoutes } from './api/client-errors';
import { registerAdminRoutes } from './api/admin';
import { registerCompression } from './middleware/compression';
import { registerRateLimit } from './middleware/rate-limit';
import { registerMonitoring } from './middleware/monitoring';
import { globalMetrics } from './utils/metrics';
import { globalCache } from './utils/cache';
import { initServerLogBuffer, createPinoBufferStream } from './utils/server-log-buffer';
import { testConnection, initializeDatabase, query } from './db';
import { buildDisquesPdfPath } from './utils/disques-pdf';
import { resolvePdfFilePath, TEAM_BASE_PATH } from './utils/pdf-path';

// Load environment variables
dotenv.config();

// Capture stdout/stderr pour la page monitoring (historique 250 lignes)
initServerLogBuffer();

// Configuration
const nodeEnv = (process.env.NODE_ENV || 'development') as 'development' | 'production';
const proxmoxConfig = {
  port: parseInt(process.env.API_PORT || '4000', 10),
  host: process.env.SERVER_HOST || '0.0.0.0',
  wsPort: parseInt(process.env.WS_PORT || '4000', 10)
};

// Logger Pino : multistream = même process (pas de worker) → tous les logs vont à stdout ET au buffer monitoring
function createLoggerStreams() {
  const pino = require('pino') as typeof import('pino');
  const pinoPretty = require('pino-pretty') as (opts?: any) => NodeJS.WritableStream;
  const prettyStream = pinoPretty({
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname'
  });
  const bufferStream = createPinoBufferStream();
  return pino.multistream([
    { stream: prettyStream },
    { stream: bufferStream, level: 'trace' as const }
  ]);
}

// Initialize Fastify (logger = multistream pour Docker + page monitoring)
const fastify: FastifyInstance = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    stream: createLoggerStreams()
  },
  bodyLimit: 1048576 // 1MB
});

// Log every HTTP request (method, url, status, ms, ip)
fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
  const { method, url, ip } = request as any;
  const statusCode = reply.statusCode;
  const responseTime = (reply as any).getResponseTime ? (reply as any).getResponseTime() : (reply as any).elapsedTime || '-';
  fastify.log.info({ method, url, statusCode, responseTime, ip }, `HTTP ${method} ${url} ${statusCode} (${responseTime}ms) from ${ip}`);
});

// Type definitions for WebSocket context
interface WebSocketUser {
  id: string;
  username: string;
  socket: any;
  connectedAt: Date;
  ip?: string;
}

// Global state
const connectedUsers = new Map<string, WebSocketUser>();
const activeSessions = new Set<string>(); // usernames with an active session (one poste per compte)
let messageCount = 0;
const messageStartTime = Date.now();

/** Get the raw WebSocket for sending (supports both raw socket and @fastify/websocket wrapper). */
function getRawSocket(socketWrapper: any): { send: (data: string) => void; readyState?: number } | null {
  const raw = socketWrapper?.socket ?? socketWrapper;
  if (!raw || typeof raw.send !== 'function') return null;
  return raw;
}

/** Envoie un payload à une socket (send ou write selon l'API disponible). */
function sendToSocket(socketRef: any, payloadStr: string): boolean {
  const raw = getRawSocket(socketRef);
  if (!raw) return false;
  const ready = raw.readyState === undefined || raw.readyState === 1;
  if (!ready) return false;
  try {
    if (typeof raw.send === 'function') {
      raw.send(payloadStr);
      return true;
    }
    if (typeof (raw as any).write === 'function') {
      (raw as any).write(payloadStr);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/** Broadcast current user count to all connected WebSockets (used by WS close and HTTP logout). */
function broadcastUserCount() {
  const snapshot = Array.from(connectedUsers.values());
  const count = snapshot.length;
  const users = snapshot.map((u) => u.username);
  const payload = JSON.stringify({ type: 'userCount', count, users });
  for (const user of snapshot) {
    sendToSocket(user.socket, payload);
  }
}


// Register plugins
(async () => {
  try {
    // Initialize database connection
    console.log('🔄 Connecting to PostgreSQL...');
    const dbConnected = await testConnection();
    if (!dbConnected) {
      throw new Error('Failed to connect to database');
    }

    // Initialize database schema
    await initializeDatabase();

    // Phase 5: Performance optimization middlewares
    await registerCompression(fastify);
    await registerRateLimit(fastify);
    await registerMonitoring(fastify);

    // Security
    await fastify.register(helmet, {
      contentSecurityPolicy: false
    });

    // CORS : autoriser l'origine du client (web/Electron) pour POST /api/monitoring/errors (feedback).
    // Exemple : ALLOWED_ORIGINS=http://localhost:3000,https://app.example.com ou * pour tout autoriser.
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(o => o.trim());
    
    await fastify.register(cors, {
      origin: allowedOrigins.length === 1 && allowedOrigins[0] === '*' 
        ? true 
        : allowedOrigins,
      credentials: true
    });

    // WebSocket
    await fastify.register(websocket);

    // Register monitoring routes
    await registerMonitoringRoutes(fastify, connectedUsers);
    
    // Register client errors monitoring routes
    await registerClientErrorsRoutes(fastify);

    // Register admin routes
    await registerAdminRoutes(fastify);

    // Health check endpoint
    fastify.get('/api/health', async (request: FastifyRequest, reply: FastifyReply) => {
      const cacheStats = globalCache.stats();
      
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: nodeEnv,
        version: '2.0.0',
        cache: {
          size: cacheStats.size,
          maxSize: cacheStats.maxSize,
        },
        memory: {
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        },
      };
    });

    // Metrics endpoint (Phase 5)
    fastify.get('/api/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
      const metrics = globalMetrics.getMetrics();
      const cacheStats = globalCache.stats();
      
      return {
        ...metrics,
        cache: cacheStats,
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      };
    });

    // Favicon à la racine (pour raccourcis client et onglet navigateur)
    fastify.get('/favicon.ico', async (request: FastifyRequest, reply: FastifyReply) => {
      const faviconPath = path.join(__dirname, 'views', 'favicon.png');
      if (!fs.existsSync(faviconPath)) {
        reply.statusCode = 404;
        return { error: 'Not found' };
      }
      reply.header('Content-Type', 'image/png');
      return reply.send(fs.createReadStream(faviconPath));
    });

    // Auth routes (un seul poste par compte : refus si déjà connecté)
    fastify.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
      const { username, password } = request.body as { username: string; password: string };

      if (!username || !password) {
        reply.statusCode = 400;
        return { error: 'Username and password required' };
      }

      const normalizedUsername = String(username).trim().toLowerCase();

      let dbUser: { id: number; username: string; password_hash: string; role: string; created_at: string } | null = null;
      try {
        const result = await query(
          'SELECT id, username, password_hash, role, created_at FROM users WHERE LOWER(username) = $1 AND deleted_at IS NULL',
          [normalizedUsername]
        );
        dbUser = result.rows[0] || null;
      } catch (err) {
        fastify.log.error({ err }, 'login: DB error');
        reply.statusCode = 500;
        return { error: 'Erreur serveur' };
      }

      if (!dbUser) {
        reply.statusCode = 401;
        return { success: false, message: 'Identifiants incorrects' };
      }

      if (!dbUser.password_hash) {
        reply.statusCode = 401;
        return { success: false, message: 'Mot de passe non défini, contactez un administrateur' };
      }

      const passwordValid = await bcrypt.compare(String(password), dbUser.password_hash);
      if (!passwordValid) {
        reply.statusCode = 401;
        return { success: false, message: 'Identifiants incorrects' };
      }

      if (activeSessions.has(normalizedUsername)) {
        reply.statusCode = 200;
        return {
          success: false,
          code: 'ALREADY_LOGGED_IN',
          message: 'Compte déjà connecté sur un autre poste.'
        };
      }

      const jwtSecret = process.env.JWT_SECRET || 'changeme';
      const token = jwt.sign(
        { id: dbUser.id, username: dbUser.username, role: dbUser.role },
        jwtSecret,
        { expiresIn: '7d' }
      );
      activeSessions.add(normalizedUsername);

      return {
        success: true,
        token,
        user: {
          id: dbUser.id,
          username: dbUser.username,
          role: dbUser.role,
          createdAt: dbUser.created_at
        }
      };
    });

    fastify.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
      let normalizedUsername: string | null = null;
      const authHeader = (request.headers as any).authorization || (request.headers as any).Authorization;
      const token = typeof authHeader === 'string' ? authHeader.replace(/Bearer\s+/i, '').trim() : '';
      if (token) {
        try {
          const jwtSecret = process.env.JWT_SECRET || 'changeme';
          const decoded = jwt.verify(token, jwtSecret) as { username?: string };
          normalizedUsername = decoded.username ? String(decoded.username).trim().toLowerCase() : null;
        } catch {
          // ignore invalid token
        }
      }
      if (!normalizedUsername) {
        fastify.log.warn('logout: pas de token ou username (Authorization header manquant ?)');
      }
      if (normalizedUsername) {
        activeSessions.delete(normalizedUsername);
        const toRemove = Array.from(connectedUsers.entries()).filter(
          ([_, u]) => String(u.username).trim().toLowerCase() === normalizedUsername
        );
        for (const [id] of toRemove) {
          connectedUsers.delete(id);
        }
        for (const [, u] of toRemove) {
          try {
            const raw = getRawSocket(u.socket);
            if (raw && typeof (raw as any).terminate === 'function') (raw as any).terminate();
            else if (raw && typeof (raw as any).close === 'function') (raw as any).close();
          } catch {
            // ignore
          }
        }
        fastify.log.info({ username: normalizedUsername, removedSockets: toRemove.length }, 'logout: session et sockets supprimés');
      }
      broadcastUserCount();
      return { success: true, message: 'Logged out successfully' };
    });

    const handleVerifyToken = async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      const token = authHeader?.replace(/^Bearer\s+/i, '').trim();

      if (!token) {
        reply.statusCode = 401;
        return { error: 'Token manquant' };
      }

      let payload: { id?: number; username?: string; role?: string } = {};
      try {
        const jwtSecret = process.env.JWT_SECRET || 'changeme';
        payload = jwt.verify(token, jwtSecret) as { id: number; username: string; role: string };
      } catch {
        reply.statusCode = 401;
        return { error: 'Token invalide ou expiré' };
      }

      if (!payload.id) {
        reply.statusCode = 401;
        return { error: 'Token invalide' };
      }

      try {
        const result = await query(
          'SELECT id, username, role, created_at FROM users WHERE id = $1 AND deleted_at IS NULL',
          [payload.id]
        );
        const dbUser = result.rows[0];
        if (!dbUser) {
          reply.statusCode = 401;
          return { error: 'Utilisateur introuvable' };
        }
        return {
          valid: true,
          userId: dbUser.id,
          username: dbUser.username,
          role: dbUser.role,
          expiresAt: new Date((payload as any).exp * 1000).toISOString()
        };
      } catch (err) {
        fastify.log.error({ err }, 'verify: DB error');
        reply.statusCode = 500;
        return { error: 'Erreur serveur' };
      }
    };

    fastify.get('/api/auth/verify', handleVerifyToken);
    fastify.post('/api/auth/verify', handleVerifyToken);

    /** Récupère l'ID utilisateur depuis le JWT (Authorization: Bearer). Retourne null si absent ou invalide. */
    const getAuthUserId = (request: FastifyRequest): number | null => {
      const authHeader = (request.headers as any).authorization;
      const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
      if (!token) return null;
      try {
        const jwtSecret = process.env.JWT_SECRET || 'changeme';
        const payload = jwt.verify(token, jwtSecret) as { id?: number };
        return payload?.id != null ? Number(payload.id) : null;
      } catch {
        return null;
      }
    };

    const sendAuthRequired = (reply: FastifyReply) => {
      reply.statusCode = 401;
      return { error: 'Token manquant ou invalide', code: 'AUTH_REQUIRED', message: 'Authentification requise' };
    };

    fastify.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
      const { username, password } = request.body as { username: string; password: string };

      if (!username || !password) {
        reply.statusCode = 400;
        return { error: 'Username and password required' };
      }

      const trimmedUsername = String(username).trim();
      const trimmedPassword = String(password);

      if (trimmedUsername.length < 3 || trimmedUsername.length > 20) {
        reply.statusCode = 400;
        return { error: 'Le nom doit contenir entre 3 et 20 caractères' };
      }

      if (trimmedPassword.length < 6) {
        reply.statusCode = 400;
        return { error: 'Le mot de passe doit contenir au moins 6 caractères' };
      }

      const passwordHash = await bcrypt.hash(trimmedPassword, 12);

      let dbUser: { id: number; username: string; created_at: string } | null = null;
      try {
        const result = await query(
          `INSERT INTO users (username, password_hash, role, created_at)
           VALUES ($1, $2, 'user', NOW())
           RETURNING id, username, created_at`,
          [trimmedUsername, passwordHash]
        );
        dbUser = result.rows[0];
      } catch (err: any) {
        if (err?.code === '23505') {
          reply.statusCode = 409;
          return { success: false, message: 'Ce nom est déjà utilisé' };
        }
        fastify.log.error({ err }, 'register: DB error');
        reply.statusCode = 500;
        return { error: 'Erreur serveur' };
      }

      const jwtSecret = process.env.JWT_SECRET || 'changeme';
      const token = jwt.sign(
        { id: dbUser!.id, username: dbUser!.username, role: 'user' },
        jwtSecret,
        { expiresIn: '7d' }
      );

      return {
        success: true,
        token,
        user: {
          id: dbUser!.id,
          username: dbUser!.username,
          createdAt: dbUser!.created_at
        }
      };
    });

    // Events routes (Agenda)
    fastify.get('/api/events', async (request: FastifyRequest, reply: FastifyReply) => {
      // Récupérer l'userId du token ou query
      const userId = (request.query as any).userId || (request as any).userId || null;
      try {
        const result = await query(
          'SELECT id, user_id, username, title, start, "end", description, location, created_at FROM events WHERE user_id = $1 ORDER BY start DESC',
          [userId]
        );
        return { success: true, events: result.rows };
      } catch (error) {
        console.error('Error fetching events:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/events', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as any).userId || null;
      const username = (request as any).username || null;
      const { title, start, end, description, location } = request.body as any;
      if (!title || !start || !end) {
        reply.statusCode = 400;
        return { error: 'Title, start, and end are required' };
      }
      try {
        const result = await query(
          'INSERT INTO events (user_id, username, title, start, "end", description, location, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id, user_id, username, title, start, "end", description, location, created_at',
          [userId, username, title, start, end, description || null, location || null]
        );
        return { success: true, event: result.rows[0] };
      } catch (error) {
        console.error('Error creating event:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // Messages routes (Chat)
    fastify.get('/api/messages', async (request: FastifyRequest, reply: FastifyReply) => {
      const limit = Math.min(Number((request.query as any).limit) || 50, 200);

      try {
        const result = await query(
          'SELECT id, user_id, username, text, conversation_id, created_at FROM messages ORDER BY created_at DESC LIMIT $1',
          [limit]
        );

        return {
          success: true,
          messages: result.rows.map((m: any) => ({
            id: m.id,
            user_id: m.user_id,
            pseudo: m.username,
            message: m.text,
            conversation_id: m.conversation_id,
            created_at: m.created_at
          })),
          total: result.rows.length
        };
      } catch (error) {
        console.error('Error fetching messages:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/messages', async (request: FastifyRequest, reply: FastifyReply) => {
      const { text, pseudo, userId } = request.body as any;

      if (!text || !pseudo) {
        reply.statusCode = 400;
        return { error: 'Text and pseudo are required' };
      }

      try {
        const result = await query(
          'INSERT INTO messages (user_id, username, text, conversation_id, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, username, text, created_at',
          [userId || null, pseudo, text, null]
        );

        const msg = result.rows[0];

        messageCount++;
        incrementMessageCount();

        const wsPayload = {
          type: 'message:new',
          data: {
            id: msg.id,
            username: msg.username,
            pseudo: msg.username,
            text: msg.text,
            message: msg.text,
            createdAt: msg.created_at,
            created_at: msg.created_at
          }
        };
        const payloadStr = JSON.stringify(wsPayload);
        let sentCount = 0;
        for (const user of connectedUsers.values()) {
          if (sendToSocket(user.socket, payloadStr)) sentCount++;
        }
        const textPreview = String(msg.text || '').substring(0, 40) + (String(msg.text || '').length > 40 ? '…' : '');
        fastify.log.info(`[WS] broadcast message:new (HTTP) → ${sentCount}/${connectedUsers.size} client(s) | msg=${msg.id} | "${textPreview}"`);

        return { success: true, message: msg };
      } catch (error) {
        console.error('Error creating message:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // Shortcuts categories routes (protégées par JWT : userId depuis le token uniquement)
    fastify.get('/api/shortcuts/categories', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        reply.statusCode = 401;
        return { error: 'Token manquant ou invalide' };
      }
      try {
        const result = await query(
          'SELECT id, name, order_index, created_at FROM shortcut_categories WHERE user_id = $1 ORDER BY order_index ASC',
          [userId]
        );
        return { success: true, categories: result.rows };
      } catch (error) {
        console.error('Error fetching shortcut categories:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.get('/api/shortcuts/categories/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        reply.statusCode = 401;
        return { error: 'Token manquant ou invalide' };
      }
      const { id } = request.params as { id: string };
      try {
        const result = await query(
          'SELECT id, name, order_index, created_at FROM shortcut_categories WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Catégorie introuvable' };
        }
        return { success: true, category: result.rows[0] };
      } catch (error) {
        console.error('Error fetching shortcut category:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/shortcuts/categories', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        reply.statusCode = 401;
        return { error: 'Token manquant ou invalide' };
      }
      const { name } = request.body as any;
      if (!name || !name.trim()) {
        reply.statusCode = 400;
        return { error: 'Category name is required' };
      }
      try {
        const result = await query(
          'INSERT INTO shortcut_categories (user_id, name, order_index) VALUES ($1, $2, (SELECT COALESCE(MAX(order_index) + 1, 0) FROM shortcut_categories WHERE user_id = $1)) RETURNING id, name, order_index, created_at',
          [userId, name.trim()]
        );
        return { success: true, category: result.rows[0] };
      } catch (error: any) {
        console.error('Error creating shortcut category:', error);
        if (error.code === '23505') {
          reply.statusCode = 409;
          return { error: 'Category already exists for this user' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.put('/api/shortcuts/categories/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        reply.statusCode = 401;
        return { error: 'Token manquant ou invalide' };
      }
      const { id } = request.params as { id: string };
      const { name } = request.body as any;
      if (!name || !name.trim()) {
        reply.statusCode = 400;
        return { error: 'Category name is required' };
      }
      try {
        const result = await query(
          'UPDATE shortcut_categories SET name = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING id, name, order_index, created_at',
          [name.trim(), id, userId]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Catégorie introuvable' };
        }
        return { success: true, category: result.rows[0] };
      } catch (error) {
        console.error('Error updating shortcut category:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.delete('/api/shortcuts/categories/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        reply.statusCode = 401;
        return { error: 'Token manquant ou invalide' };
      }
      const { id } = request.params as { id: string };
      try {
        const result = await query(
          'DELETE FROM shortcut_categories WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Catégorie introuvable' };
        }
        return { success: true };
      } catch (error: any) {
        console.error('Error deleting shortcut category:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // Marques & Modèles (Réception)
    fastify.get('/api/marques', async () => {
      try {
        const result = await query('SELECT id, name FROM marques ORDER BY name');
        return { success: true, items: result.rows };
      } catch (error) {
        console.error('Error fetching marques:', error);
        return { success: false, error: 'Database error' };
      }
    });

    fastify.get('/api/marques/all', async () => {
      try {
        // Retourner toutes les marques avec leurs modèles
        const marquesResult = await query('SELECT id, name FROM marques ORDER BY name');
        const marques = marquesResult.rows;
        
        // Pour chaque marque, charger ses modèles
        const marquesAvecModeles = await Promise.all(marques.map(async (marque: { id: number; name: string }) => {
          const modelesResult = await query(
            'SELECT id, name, marque_id FROM modeles WHERE marque_id = $1 ORDER BY name',
            [marque.id]
          );
          return {
            ...marque,
            modeles: modelesResult.rows
          };
        }));
        
        return { success: true, items: marquesAvecModeles };
      } catch (error) {
        console.error('Error fetching marques/all:', error);
        return { success: false, error: 'Database error' };
      }
    });

    fastify.get('/api/marques/:marqueId/modeles', async (request: FastifyRequest, reply: FastifyReply) => {
      const { marqueId } = request.params as { marqueId: string };
      
      if (!marqueId) {
        reply.statusCode = 400;
        return { error: 'MarqueId is required' };
      }

      try {
        const marqueIdNum = parseInt(marqueId, 10);
        if (isNaN(marqueIdNum)) {
          reply.statusCode = 400;
          return { error: 'Invalid marqueId' };
        }
        
        const result = await query(
          'SELECT id, name, marque_id FROM modeles WHERE marque_id = $1 ORDER BY name',
          [marqueIdNum]
        );
        return {
          success: true,
          marqueId,
          modeles: result.rows
        };
      } catch (error) {
        console.error('Error fetching modeles:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/marques', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.body as any;
      if (!name || !name.trim()) {
        reply.statusCode = 400;
        return { error: 'Name is required' };
      }

      try {
        const result = await query(
          'INSERT INTO marques (name) VALUES ($1) RETURNING id, name',
          [name.trim()]
        );
        
        if (result.rows.length > 0) {
          return { success: true, ...result.rows[0] };
        } else {
          reply.statusCode = 500;
          return { error: 'Failed to create marque' };
        }
      } catch (error: any) {
        console.error('Error creating marque:', error);
        if (error.code === '23505') {
          reply.statusCode = 409;
          return { error: 'Marque already exists' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/marques/:marqueId/modeles', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.body as any;
      const { marqueId } = request.params as any;

      if (!name || !name.trim() || !marqueId) {
        reply.statusCode = 400;
        return { error: 'Name and marqueId are required' };
      }

      try {
        const marqueIdNum = parseInt(marqueId, 10);
        if (isNaN(marqueIdNum)) {
          reply.statusCode = 400;
          return { error: 'Invalid marqueId' };
        }
        
        const result = await query(
          'INSERT INTO modeles (marque_id, name) VALUES ($1, $2) RETURNING id, name, marque_id',
          [marqueIdNum, name.trim()]
        );
        
        if (result.rows.length > 0) {
          return { success: true, ...result.rows[0] };
        } else {
          reply.statusCode = 500;
          return { error: 'Failed to create modele' };
        }
      } catch (error) {
        console.error('Error creating modele:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // Agenda holidays (jours fériés / fêtes) - source Etalab
    // Source JSON par zone : https://etalab.github.io/jours-feries-france-data/json/<zone>.json
    fastify.get('/api/agenda/holidays', async (request: FastifyRequest, reply: FastifyReply) => {
      const { year: yearParam, zone: zoneParam } = request.query as { year?: string; zone?: string };
      const yearNum = parseInt(String(yearParam || '').trim(), 10);
      const zone = String(zoneParam || 'metropole').trim().toLowerCase();

      if (!yearParam || !Number.isFinite(yearNum) || yearNum < 1900 || yearNum > 2200) {
        reply.statusCode = 400;
        return { success: false, error: 'Invalid year' };
      }

      const ALLOWED_ZONES = new Set([
        'metropole',
        'alsace-moselle',
        'guadeloupe',
        'guyane',
        'la-reunion',
        'martinique',
        'mayotte',
        'nouvelle-caledonie',
        'polynesie-francaise',
        'saint-barthelemy',
        'saint-martin',
        'saint-pierre-et-miquelon',
        'wallis-et-futuna'
      ]);

      if (!ALLOWED_ZONES.has(zone)) {
        reply.statusCode = 400;
        return { success: false, error: 'Invalid zone' };
      }

      const cacheKey = `agenda:holidays:${zone}`;
      const cached = globalCache.get(cacheKey) as Record<string, string> | null;

      const loadZoneJson = async (): Promise<Record<string, string>> => {
        if (cached) return cached;
        const url = `https://etalab.github.io/jours-feries-france-data/json/${encodeURIComponent(zone)}.json`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) {
          throw new Error(`Etalab holidays fetch failed: HTTP ${res.status}`);
        }
        const data = (await res.json()) as any;
        if (!data || typeof data !== 'object') {
          throw new Error('Etalab holidays payload invalid');
        }
        // Cache 24h (les jours fériés changent rarement)
        globalCache.set(cacheKey, data as Record<string, string>, 60 * 60 * 24);
        return data as Record<string, string>;
      };

      const slugify = (s: string) => {
        return String(s || '')
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
          .slice(0, 80) || 'holiday';
      };

      try {
        const zoneJson = await loadZoneJson();
        const prefix = `${yearNum}-`;
        const events = Object.entries(zoneJson)
          .filter(([date]) => typeof date === 'string' && date.startsWith(prefix))
          .map(([date, title]) => {
            const safeTitle = String(title || '').trim() || 'Jour férié';
            return {
              id: `holiday:${date}:${slugify(safeTitle)}`,
              title: safeTitle,
              start: `${date}T00:00:00`,
              end: `${date}T23:59:00`,
              all_day: true,
              color: '#e74c3c',
              locked: true,
              source: 'holiday'
            };
          })
          .sort((a, b) => a.start.localeCompare(b.start));

        return { success: true, data: events };
      } catch (err: any) {
        fastify.log.error({ err, year: yearNum, zone }, 'GET /api/agenda/holidays error');
        reply.statusCode = 502;
        return { success: false, error: 'Holidays provider error', message: err?.message };
      }
    });

    // Agenda routes (stockage en BDD, même table events que /api/events)
    fastify.get('/api/agenda/events', async (request: FastifyRequest, reply: FastifyReply) => {
      const { start: startParam, end: endParam } = request.query as { start?: string; end?: string };
      try {
        let sql = 'SELECT id, user_id, username, title, start, "end", description, location, color, created_at FROM events WHERE 1=1';
        const params: any[] = [];
        let paramIndex = 1;
        if (startParam) {
          sql += ` AND "end" >= $${paramIndex}`;
          params.push(startParam);
          paramIndex++;
        }
        if (endParam) {
          sql += ` AND start <= $${paramIndex}`;
          params.push(endParam);
          paramIndex++;
        }
        sql += ' ORDER BY start ASC';
        const result = await query(sql, params);
        const events = (result.rows as any[]).map((row: any) => ({
          id: String(row.id),
          title: row.title,
          start: row.start,
          end: row.end,
          description: row.description || '',
          location: row.location || '',
          color: row.color || '',
          created_at: row.created_at
        }));
        return { success: true, data: events };
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/agenda/events error');
        reply.statusCode = 500;
        return { success: false, error: 'Database error', message: err?.message };
      }
    });

    fastify.post('/api/agenda/events', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body as any) || {};
      const title = body.title;
      const start = body.start || body.startTime;
      const end = body.end || body.endTime;
      const description = body.description || null;
      const location = body.location || null;
      const color = body.color || null;
      const userId = (request as any).userId || null;
      const username = (request as any).username || null;

      if (!title || !start || !end) {
        reply.statusCode = 400;
        return { success: false, error: 'Title, start and end are required' };
      }
      try {
        const result = await query(
          'INSERT INTO events (user_id, username, title, start, "end", description, location, color, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id, title, start, "end", description, location, color, created_at',
          [userId, username, title, start, end, description, location, color]
        );
        const row = result.rows[0] as any;
        const event = {
          id: String(row.id),
          title: row.title,
          start: row.start,
          end: row.end,
          description: row.description || '',
          location: row.location || '',
          color: row.color || '',
          created_at: row.created_at
        };
        return { success: true, data: event };
      } catch (err: any) {
        fastify.log.error({ err }, 'POST /api/agenda/events error');
        reply.statusCode = 500;
        return { success: false, error: 'Database error', message: err?.message };
      }
    });

    fastify.get('/api/agenda/events/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id) {
        reply.statusCode = 400;
        return { success: false, error: 'Invalid event id' };
      }
      try {
        const result = await query(
          'SELECT id, user_id, username, title, start, "end", description, location, color, created_at FROM events WHERE id = $1',
          [id]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { success: false, error: 'Event not found' };
        }
        const row = result.rows[0] as any;
        return {
          success: true,
          data: {
            id: String(row.id),
            title: row.title,
            start: row.start,
            end: row.end,
            description: row.description || '',
            location: row.location || '',
            color: row.color || '',
            created_at: row.created_at
          }
        };
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/agenda/events/:id error');
        reply.statusCode = 500;
        return { success: false, error: 'Database error', message: err?.message };
      }
    });

    fastify.put('/api/agenda/events/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};
      if (!id) {
        reply.statusCode = 400;
        return { success: false, error: 'Invalid event id' };
      }
      if (String(id).startsWith('holiday:') || body.locked === true || body.source === 'holiday') {
        reply.statusCode = 403;
        return { success: false, error: 'Locked event', message: 'Cet événement est verrouillé et ne peut pas être modifié.' };
      }
      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;
      if (body.title !== undefined) { updates.push(`title = $${paramIndex++}`); params.push(body.title); }
      if (body.start !== undefined) { updates.push(`start = $${paramIndex++}`); params.push(body.start); }
      if (body.end !== undefined) { updates.push(`"end" = $${paramIndex++}`); params.push(body.end); }
      if (body.description !== undefined) { updates.push(`description = $${paramIndex++}`); params.push(body.description); }
      if (body.location !== undefined) { updates.push(`location = $${paramIndex++}`); params.push(body.location); }
      if (body.color !== undefined) { updates.push(`color = $${paramIndex++}`); params.push(body.color); }
      if (updates.length === 0) {
        reply.statusCode = 400;
        return { success: false, error: 'No fields to update' };
      }
      params.push(id);
      try {
        const result = await query(
          `UPDATE events SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, title, start, "end", description, location, color, created_at`,
          params
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { success: false, error: 'Event not found' };
        }
        const row = result.rows[0] as any;
        return {
          success: true,
          data: {
            id: String(row.id),
            title: row.title,
            start: row.start,
            end: row.end,
            description: row.description || '',
            location: row.location || '',
            color: row.color || '',
            created_at: row.created_at
          }
        };
      } catch (err: any) {
        fastify.log.error({ err }, 'PUT /api/agenda/events/:id error');
        reply.statusCode = 500;
        return { success: false, error: 'Database error', message: err?.message };
      }
    });

    fastify.delete('/api/agenda/events/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id) {
        reply.statusCode = 400;
        return { success: false, error: 'Invalid event id' };
      }
      if (String(id).startsWith('holiday:')) {
        reply.statusCode = 403;
        return { success: false, error: 'Locked event', message: 'Cet événement est verrouillé et ne peut pas être supprimé.' };
      }
      try {
        const result = await query('DELETE FROM events WHERE id = $1', [id]);
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { success: false, error: 'Event not found' };
        }
        return { success: true, message: 'Event deleted' };
      } catch (err: any) {
        fastify.log.error({ err }, 'DELETE /api/agenda/events/:id error');
        reply.statusCode = 500;
        return { success: false, error: 'Database error', message: err?.message };
      }
    });

    // Lots routes (Réception)
    fastify.get('/api/lots', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { status: statusFilter, embed } = request.query as { status?: string; embed?: string };
        const selectSql = `
          SELECT 
            l.id, l.name, l.status, l.item_count, l.description, 
            l.received_at, l.created_at, l.updated_at, l.finished_at, l.recovered_at, l.pdf_path
          FROM lots l
        `;
        let whereClause = '';
        const queryParams: any[] = [];
        const notDeleted = "(l.deleted_at IS NULL)";
        if (statusFilter === 'active') {
          whereClause = ` WHERE ${notDeleted} AND (l.status IS NULL OR l.status NOT IN ('finished', 'cancelled'))`;
        } else if (statusFilter === 'finished') {
          whereClause = ` WHERE ${notDeleted} AND l.status = 'finished'`;
        } else {
          // status=all or no filter: return all non-deleted lots
          whereClause = ` WHERE ${notDeleted}`;
        }
        const orderSql = ' ORDER BY l.received_at DESC';
        const result = await query(selectSql + whereClause + orderSql, queryParams);
        const lots = (result.rows as any[]).map((row: any) => ({
          ...row,
          lot_name: row.name ?? null
        }));

        if (embed === 'items' && lots.length > 0) {
          const lotIds = lots.map((l: any) => l.id);
          const placeholders = lotIds.map((_: any, i: number) => `$${i + 1}`).join(',');
          const itemsResult = await query(`
            SELECT 
              li.lot_id, li.id, li.serial_number, li.type, li.entry_type, li.entry_date, li.entry_time,
              li.marque_id, li.modele_id, li.state, li.technician, li.state_changed_at, li.os,
              m.name as marque_name,
              mo.name as modele_name
            FROM lot_items li
            LEFT JOIN marques m ON li.marque_id = m.id
            LEFT JOIN modeles mo ON li.modele_id = mo.id
            WHERE li.lot_id IN (${placeholders}) AND (li.deleted_at IS NULL)
            ORDER BY li.lot_id ASC, li.id ASC
          `, lotIds);

          const itemsByLotId: Record<number, any[]> = {};
          for (const row of itemsResult.rows as any[]) {
            const lotId = row.lot_id;
            if (!itemsByLotId[lotId]) itemsByLotId[lotId] = [];
            itemsByLotId[lotId].push({
              id: row.id,
              serial_number: row.serial_number,
              type: row.type,
              marque_name: row.marque_name,
              modele_name: row.modele_name,
              marque_id: row.marque_id,
              modele_id: row.modele_id,
              state: row.state || null,
              technician: row.technician || null,
              state_changed_at: row.state_changed_at || null,
              entry_type: row.entry_type,
              entry_date: row.entry_date,
              entry_time: row.entry_time,
              os: row.os === 'windows' ? 'windows' : 'linux'
            });
          }

          const lotsWithItems = lots.map((lot: any) => ({
            ...lot,
            items: itemsByLotId[lot.id] || []
          }));
          return { success: true, lots: lotsWithItems };
        }

        return {
          success: true,
          lots
        };
      } catch (error) {
        console.error('Error fetching lots:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/lots', async (request: FastifyRequest, reply: FastifyReply) => {
      const { itemCount, description, items, lotName } = request.body as any;

      // Support both legacy shape (itemCount) and new client shape (items array)
      const computedItemCount = Array.isArray(items) ? items.length : Number(itemCount);

      if (!computedItemCount || Number.isNaN(computedItemCount)) {
        reply.statusCode = 400;
        return { error: 'itemCount or items[] is required' };
      }

      try {
        // Insert lot
        const lotResult = await query(
          'INSERT INTO lots (name, item_count, description, status) VALUES ($1, $2, $3, $4) RETURNING *',
          [lotName || null, computedItemCount, description || null, 'received']
        );

        const lot = lotResult.rows[0];

        // Insert lot items if provided
        if (Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            await query(
              `INSERT INTO lot_items 
               (lot_id, serial_number, type, marque_id, modele_id, entry_type, entry_date, entry_time)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                lot.id,
                item.serialNumber || null,
                item.type || null,
                item.marqueId || null,
                item.modeleId || null,
                item.entryType || 'manual',
                item.date || null,
                item.time || null
              ]
            );
          }
        }

        return {
          success: true,
          id: lot.id,
          lot: {
            id: lot.id,
            name: lot.name,
            itemCount: lot.item_count,
            description: lot.description,
            status: lot.status,
            receivedAt: lot.received_at
          }
        };
      } catch (error) {
        console.error('Error creating lot:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // Get a specific lot with its items
    fastify.get('/api/lots/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        // Get lot details
        const lotResult = await query(`
          SELECT 
            l.id, l.name, l.status, l.item_count, l.description, 
            l.received_at, l.created_at, l.updated_at, l.finished_at, l.recovered_at, l.pdf_path
          FROM lots l
          WHERE l.id = $1 AND (l.deleted_at IS NULL)
        `, [id]);

        if (lotResult.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot not found', message: 'Lot introuvable.' };
        }

        const lot = lotResult.rows[0];

        // Get lot items with all columns (including os)
        const itemsResult = await query(`
          SELECT 
            li.id, li.serial_number, li.type, li.entry_type, li.entry_date, li.entry_time,
            li.marque_id, li.modele_id, li.state, li.technician, li.state_changed_at, li.os,
            m.name as marque_name,
            mo.name as modele_name
          FROM lot_items li
          LEFT JOIN marques m ON li.marque_id = m.id
          LEFT JOIN modeles mo ON li.modele_id = mo.id
          WHERE li.lot_id = $1 AND (li.deleted_at IS NULL)
          ORDER BY li.id ASC
        `, [id]);

        const items = itemsResult.rows.map((item: any) => ({
          id: item.id,
          serial_number: item.serial_number,
          type: item.type,
          marque_name: item.marque_name,
          modele_name: item.modele_name,
          marque_id: item.marque_id,
          modele_id: item.modele_id,
          state: item.state || null,
          technician: item.technician || null,
          state_changed_at: item.state_changed_at || null,
          entry_type: item.entry_type,
          entry_date: item.entry_date,
          entry_time: item.entry_time,
          os: item.os === 'windows' ? 'windows' : 'linux'
        }));

        // Calculate totals based on item states
        const total = items.length || lot.item_count || 0;
        const recond = items.filter((item: any) => item.state === 'Reconditionnés').length;
        const hs = items.filter((item: any) => item.state === 'HS').length;
        const pieces = items.filter((item: any) => item.state === 'Pour pièces').length;
        const pending = items.filter((item: any) =>
          !item.state || String(item.state || '').trim() === '' ||
          !item.technician || String(item.technician || '').trim() === ''
        ).length;

        return {
          success: true,
          item: {
            ...lot,
            lot_name: lot.name ?? null,
            items,
            total,
            recond,
            hs,
            pieces,
            pending
          }
        };
      } catch (error: any) {
        console.error('Error fetching lot:', error);
        reply.statusCode = 500;
        return { 
          error: 'Database error', 
          message: error.message,
          details: error.stack 
        };
      }
    });

    // Update a lot
    fastify.put('/api/lots/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { lot_name, recovered_at, status, finished_at } = request.body as any;

      try {
        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (lot_name !== undefined) {
          updates.push(`name = $${paramIndex++}`);
          values.push(lot_name);
        }

        if (recovered_at !== undefined) {
          updates.push(`recovered_at = $${paramIndex++}`);
          const recoveredDate = recovered_at === true || recovered_at === 'true'
            ? new Date().toISOString()
            : (recovered_at || new Date().toISOString());
          values.push(recoveredDate);
        }

        if (status !== undefined) {
          updates.push(`status = $${paramIndex++}`);
          values.push(status);
        }

        if (finished_at !== undefined) {
          updates.push(`finished_at = $${paramIndex++}`);
          values.push(typeof finished_at === 'string' ? finished_at : new Date().toISOString());
        }

        // Always update updated_at timestamp
        updates.push(`updated_at = NOW()`);

        if (updates.length <= 1) {
          reply.statusCode = 400;
          return { error: 'No fields to update' };
        }

        values.push(id);
        const result = await query(
          `UPDATE lots SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
          values
        );

        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot not found' };
        }

        return {
          success: true,
          item: result.rows[0]
        };
      } catch (error: any) {
        console.error('Error updating lot:', error);
        reply.statusCode = 500;
        return { 
          error: 'Database error', 
          message: error.message,
          details: error.stack 
        };
      }
    });

    async function findOrCreateMarqueIdByName(name: string): Promise<number | null> {
      const trimmed = String(name || '').trim();
      if (!trimmed) return null;
      const found = await query(
        'SELECT id FROM marques WHERE LOWER(TRIM(name)) = LOWER($1) LIMIT 1',
        [trimmed]
      );
      if (found.rowCount && found.rowCount > 0) return found.rows[0].id;
      try {
        const created = await query('INSERT INTO marques (name) VALUES ($1) RETURNING id', [trimmed]);
        return created.rows[0]?.id ?? null;
      } catch (err: any) {
        if (err.code === '23505') {
          const again = await query(
            'SELECT id FROM marques WHERE LOWER(TRIM(name)) = LOWER($1) LIMIT 1',
            [trimmed]
          );
          return again.rows[0]?.id ?? null;
        }
        throw err;
      }
    }

    async function findOrCreateModeleIdByName(marqueId: number, name: string): Promise<number | null> {
      const trimmed = String(name || '').trim();
      if (!trimmed || !marqueId) return null;
      const found = await query(
        'SELECT id FROM modeles WHERE marque_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
        [marqueId, trimmed]
      );
      if (found.rowCount && found.rowCount > 0) return found.rows[0].id;
      try {
        const created = await query(
          'INSERT INTO modeles (marque_id, name) VALUES ($1, $2) RETURNING id',
          [marqueId, trimmed]
        );
        return created.rows[0]?.id ?? null;
      } catch (err: any) {
        if (err.code === '23505') {
          const again = await query(
            'SELECT id FROM modeles WHERE marque_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
            [marqueId, trimmed]
          );
          return again.rows[0]?.id ?? null;
        }
        throw err;
      }
    }

    // Update a lot item
    fastify.put('/api/lots/items/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const {
        state,
        technician,
        recovered_at,
        os,
        serial_number,
        type,
        marque_id,
        modele_id,
        marque_name,
        modele_name
      } = request.body as any;

      try {
        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (serial_number !== undefined) {
          updates.push(`serial_number = $${paramIndex++}`);
          values.push(
            serial_number === null || (typeof serial_number === 'string' && serial_number.trim() === '')
              ? null
              : String(serial_number).trim()
          );
        }

        if (type !== undefined) {
          updates.push(`type = $${paramIndex++}`);
          values.push(
            type === null || (typeof type === 'string' && type.trim() === '')
              ? null
              : String(type).trim()
          );
        }

        let resolvedMarqueId: number | null | undefined = undefined;
        if (marque_id !== undefined || marque_name !== undefined) {
          if (marque_id !== undefined && marque_id !== null && marque_id !== '') {
            const parsed = parseInt(String(marque_id), 10);
            resolvedMarqueId = Number.isNaN(parsed) ? null : parsed;
          } else if (marque_name !== undefined) {
            const name = String(marque_name || '').trim();
            resolvedMarqueId = name ? await findOrCreateMarqueIdByName(name) : null;
          } else {
            resolvedMarqueId = null;
          }
          updates.push(`marque_id = $${paramIndex++}`);
          values.push(resolvedMarqueId);
        }

        let resolvedModeleId: number | null | undefined = undefined;
        if (modele_id !== undefined || modele_name !== undefined) {
          if (modele_id !== undefined && modele_id !== null && modele_id !== '') {
            const parsed = parseInt(String(modele_id), 10);
            resolvedModeleId = Number.isNaN(parsed) ? null : parsed;
          } else if (modele_name !== undefined) {
            const name = String(modele_name || '').trim();
            if (name) {
              let marqueForModele = resolvedMarqueId;
              if (marqueForModele === undefined) {
                const current = await query('SELECT marque_id FROM lot_items WHERE id = $1', [id]);
                marqueForModele = current.rows[0]?.marque_id ?? null;
              }
              resolvedModeleId = marqueForModele
                ? await findOrCreateModeleIdByName(marqueForModele, name)
                : null;
            } else {
              resolvedModeleId = null;
            }
          } else {
            resolvedModeleId = null;
          }
          updates.push(`modele_id = $${paramIndex++}`);
          values.push(resolvedModeleId);
        }

        if (state !== undefined) {
          if (state === null || (typeof state === 'string' && state.trim() === '')) {
            updates.push(`state = NULL`);
            updates.push(`state_changed_at = NOW()`);
          } else {
            updates.push(`state = $${paramIndex++}`);
            values.push(typeof state === 'string' ? state.trim() : state);
            updates.push(`state_changed_at = NOW()`);
          }
        }

        if (technician !== undefined) {
          updates.push(`technician = $${paramIndex++}`);
          values.push(technician || null);
        }

        if (os !== undefined) {
          const osVal = (typeof os === 'string' && (os === 'windows' || os === 'linux')) ? os : 'linux';
          updates.push(`os = $${paramIndex++}`);
          values.push(osVal);
        }

        // Always update updated_at
        updates.push(`updated_at = NOW()`);

        // Valider que nous avons des mises à jour
        if (updates.length === 0) {
          reply.statusCode = 400;
          return { error: 'No fields to update' };
        }

        // Construire la requête SQL de manière sécurisée
        const setClause = updates.join(', ');
        // Ajouter l'ID à la fin des valeurs et utiliser le bon index pour la clause WHERE
        values.push(id);
        const whereParamIndex = values.length; // L'index du paramètre WHERE est la longueur du tableau après avoir ajouté id
        const sqlQuery = `UPDATE lot_items SET ${setClause} WHERE id = $${whereParamIndex} RETURNING *`;
        const result = await query(sqlQuery, values);

        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot item not found' };
        }

        const updatedItem = result.rows[0];
        const lotId = updatedItem.lot_id;
        let lotFinished = false;

        if (lotId != null && (state !== undefined || technician !== undefined)) {
          const itemsResult = await query(
            `SELECT id, state, technician FROM lot_items WHERE lot_id = $1 AND (deleted_at IS NULL)`,
            [lotId]
          );
          const allComplete = itemsResult.rows.length > 0 && itemsResult.rows.every(
            (row: any) =>
              row.state != null && String(row.state).trim() !== '' &&
              row.technician != null && String(row.technician).trim() !== ''
          );
          if (allComplete) {
            await query(
              `UPDATE lots SET status = 'finished', finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [lotId]
            );
            lotFinished = true;
          }
        }

        return {
          success: true,
          item: updatedItem,
          lotFinished
        };
      } catch (error: any) {
        fastify.log.error({ err: error }, 'PUT /api/lots/items/:id error');
        reply.statusCode = 500;
        return { 
          error: 'Database error', 
          message: error.message || 'Unknown error',
          code: error.code,
          detail: error.detail,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
      }
    });

    // Ajouter un item à un lot actif
    fastify.post('/api/lots/:id/items', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};
      const {
        serialNumber,
        serial_number,
        type,
        marqueId,
        marque_id,
        modeleId,
        modele_id,
        marque_name,
        modele_name,
        entryType,
        entry_type,
        date,
        entry_date,
        time,
        entry_time,
        os,
        state,
        technician
      } = body;

      try {
        const lotResult = await query(
          `SELECT id, status FROM lots WHERE id = $1 AND (deleted_at IS NULL)`,
          [id]
        );
        if (lotResult.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot not found', message: 'Lot introuvable.' };
        }
        const lot = lotResult.rows[0];
        if (lot.status === 'finished') {
          reply.statusCode = 400;
          return { error: 'Lot finished', message: 'Impossible d\'ajouter du matériel à un lot terminé.' };
        }

        let resolvedMarqueId: number | null = null;
        if (marqueId != null || marque_id != null) {
          const parsed = parseInt(String(marqueId ?? marque_id), 10);
          resolvedMarqueId = Number.isNaN(parsed) ? null : parsed;
        } else if (marque_name) {
          resolvedMarqueId = await findOrCreateMarqueIdByName(String(marque_name));
        }

        let resolvedModeleId: number | null = null;
        if (modeleId != null || modele_id != null) {
          const parsed = parseInt(String(modeleId ?? modele_id), 10);
          resolvedModeleId = Number.isNaN(parsed) ? null : parsed;
        } else if (modele_name && resolvedMarqueId) {
          resolvedModeleId = await findOrCreateModeleIdByName(resolvedMarqueId, String(modele_name));
        }

        const sn = String(serial_number ?? serialNumber ?? '').trim() || null;
        const itemType = String(type || '').trim() || null;
        const entryTypeVal = String(entry_type ?? entryType ?? 'manual').trim() || 'manual';
        const entryDateVal = entry_date ?? date ?? null;
        const entryTimeVal = entry_time ?? time ?? null;
        const osVal = (typeof os === 'string' && ['windows', 'linux', 'chrome', 'apple', 'android', 'bsd'].includes(os))
          ? os
          : 'linux';
        const stateVal = state != null && String(state).trim() !== '' ? String(state).trim() : null;
        const techVal = technician != null && String(technician).trim() !== '' ? String(technician).trim() : null;

        const insertResult = await query(
          `INSERT INTO lot_items
           (lot_id, serial_number, type, marque_id, modele_id, entry_type, entry_date, entry_time, os, state, technician, state_changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $10::text IS NOT NULL THEN NOW() ELSE NULL END)
           RETURNING *`,
          [
            id,
            sn,
            itemType,
            resolvedMarqueId,
            resolvedModeleId,
            entryTypeVal,
            entryDateVal,
            entryTimeVal,
            osVal,
            stateVal,
            techVal
          ]
        );

        await query(
          `UPDATE lots SET item_count = (
             SELECT COUNT(*) FROM lot_items WHERE lot_id = $1 AND (deleted_at IS NULL)
           ), updated_at = NOW() WHERE id = $1`,
          [id]
        );

        const row = insertResult.rows[0];
        let marqueName = null;
        let modeleName = null;
        if (row.marque_id) {
          const m = await query('SELECT name FROM marques WHERE id = $1', [row.marque_id]);
          marqueName = m.rows[0]?.name ?? null;
        }
        if (row.modele_id) {
          const m = await query('SELECT name FROM modeles WHERE id = $1', [row.modele_id]);
          modeleName = m.rows[0]?.name ?? null;
        }

        return {
          success: true,
          item: {
            id: row.id,
            lot_id: row.lot_id,
            serial_number: row.serial_number,
            type: row.type,
            marque_id: row.marque_id,
            modele_id: row.modele_id,
            marque_name: marqueName,
            modele_name: modeleName,
            state: row.state || null,
            technician: row.technician || null,
            state_changed_at: row.state_changed_at || null,
            entry_type: row.entry_type,
            entry_date: row.entry_date,
            entry_time: row.entry_time,
            os: row.os || 'linux'
          }
        };
      } catch (error: any) {
        fastify.log.error({ err: error }, 'POST /api/lots/:id/items error');
        reply.statusCode = 500;
        return { error: 'Database error', message: error.message || 'Unknown error' };
      }
    });

    // Soft-delete d'un item de lot
    fastify.delete('/api/lots/items/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        const current = await query(
          `SELECT li.*, l.status AS lot_status
           FROM lot_items li
           JOIN lots l ON l.id = li.lot_id
           WHERE li.id = $1 AND (li.deleted_at IS NULL)`,
          [id]
        );
        if (current.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot item not found', message: 'Matériel introuvable.' };
        }
        const item = current.rows[0];
        if (item.lot_status === 'finished') {
          reply.statusCode = 400;
          return { error: 'Lot finished', message: 'Impossible de retirer du matériel d\'un lot terminé.' };
        }

        await query(
          `UPDATE lot_items SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [id]
        );
        await query(
          `UPDATE lots SET item_count = (
             SELECT COUNT(*) FROM lot_items WHERE lot_id = $1 AND (deleted_at IS NULL)
           ), updated_at = NOW() WHERE id = $1`,
          [item.lot_id]
        );

        return {
          success: true,
          item: { id: item.id, lot_id: item.lot_id, deleted: true }
        };
      } catch (error: any) {
        fastify.log.error({ err: error }, 'DELETE /api/lots/items/:id error');
        reply.statusCode = 500;
        return { error: 'Database error', message: error.message || 'Unknown error' };
      }
    });

    // Restaurer un item soft-supprimé (undo)
    fastify.post('/api/lots/items/:id/restore', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        const current = await query(
          `SELECT li.*, l.status AS lot_status
           FROM lot_items li
           JOIN lots l ON l.id = li.lot_id
           WHERE li.id = $1`,
          [id]
        );
        if (current.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot item not found', message: 'Matériel introuvable.' };
        }
        const item = current.rows[0];
        if (item.lot_status === 'finished') {
          reply.statusCode = 400;
          return { error: 'Lot finished', message: 'Impossible de restaurer du matériel sur un lot terminé.' };
        }
        if (item.deleted_at == null) {
          return { success: true, item: { id: item.id, lot_id: item.lot_id, restored: false } };
        }

        await query(
          `UPDATE lot_items SET deleted_at = NULL, updated_at = NOW() WHERE id = $1`,
          [id]
        );
        await query(
          `UPDATE lots SET item_count = (
             SELECT COUNT(*) FROM lot_items WHERE lot_id = $1 AND (deleted_at IS NULL)
           ), updated_at = NOW() WHERE id = $1`,
          [item.lot_id]
        );

        return {
          success: true,
          item: { id: item.id, lot_id: item.lot_id, restored: true }
        };
      } catch (error: any) {
        fastify.log.error({ err: error }, 'POST /api/lots/items/:id/restore error');
        reply.statusCode = 500;
        return { error: 'Database error', message: error.message || 'Unknown error' };
      }
    });

    // Soft-delete d'un lot entier (annulation d'un lot en cours) + soft-delete de ses items
    fastify.delete('/api/lots/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        const lotResult = await query(
          `SELECT id, status FROM lots WHERE id = $1 AND (deleted_at IS NULL)`,
          [id]
        );
        if (lotResult.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot not found', message: 'Lot introuvable.' };
        }
        const lot = lotResult.rows[0];
        if (lot.status === 'finished') {
          reply.statusCode = 400;
          return {
            error: 'Lot finished',
            message: 'Impossible de supprimer un lot terminé. Utilisez l\'administration si nécessaire.'
          };
        }

        await query(
          `UPDATE lot_items SET deleted_at = NOW(), updated_at = NOW()
           WHERE lot_id = $1 AND (deleted_at IS NULL)`,
          [id]
        );
        await query(
          `UPDATE lots SET deleted_at = NOW(), status = 'cancelled', item_count = 0, updated_at = NOW()
           WHERE id = $1`,
          [id]
        );

        return {
          success: true,
          message: 'Lot supprimé.',
          lot: { id: Number(id), deleted: true, status: 'cancelled' }
        };
      } catch (error: any) {
        fastify.log.error({ err: error }, 'DELETE /api/lots/:id error');
        reply.statusCode = 500;
        return { error: 'Database error', message: error.message || 'Unknown error' };
      }
    });

    // Réception du PDF : le client envoie le contenu (base64) pour stockage côté serveur + backup local côté client
    const pdfStorageDir = process.env.PDF_STORAGE_PATH || path.join(process.cwd(), 'data', 'pdfs');
    fastify.post('/api/lots/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};
      const pdfBase64 = body.pdf_base64;
      const lotName = (body.lot_name && String(body.lot_name).trim()) || `Lot_${id}`;
      const dateStr = body.date && /^\d{4}-\d{2}-\d{2}$/.test(String(body.date))
        ? String(body.date)
        : new Date().toISOString().slice(0, 10);

      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid lot id' };
      }
      if (!pdfBase64 || typeof pdfBase64 !== 'string') {
        reply.statusCode = 400;
        return { error: 'pdf_base64 is required', message: 'Le client doit envoyer le contenu du PDF en base64.' };
      }

      let buffer: Buffer;
      try {
        buffer = Buffer.from(pdfBase64, 'base64');
      } catch (_) {
        reply.statusCode = 400;
        return { error: 'Invalid base64', message: 'Contenu PDF invalide.' };
      }
      if (buffer.length === 0) {
        reply.statusCode = 400;
        return { error: 'Empty PDF', message: 'Le PDF est vide.' };
      }

      try {
        const lotResult = await query('SELECT id FROM lots WHERE id = $1', [id]);
        if (lotResult.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Lot not found' };
        }
        const year = dateStr.slice(0, 4);
        const month = dateStr.slice(5, 7);
        const dirPath = path.join(pdfStorageDir, year, month);
        fs.mkdirSync(dirPath, { recursive: true });
        const sanitizedName = lotName.replace(/[\s]+/g, '_').replace(/[\\/:*?"<>|]/g, '').trim() || `Lot_${id}`;
        const fileName = `${sanitizedName}_${dateStr}.pdf`;
        const serverFilePath = path.join(dirPath, fileName);
        fs.writeFileSync(serverFilePath, buffer);
        const resolvedPath = path.resolve(serverFilePath);

        await query(
          'UPDATE lots SET pdf_path = $1, updated_at = NOW() WHERE id = $2',
          [resolvedPath, id]
        );
        reply.statusCode = 200;
        return {
          success: true,
          pdf_path: resolvedPath,
          generatedAt: new Date().toISOString(),
          message: 'PDF enregistré ; « Voir le PDF » affichera cette version.'
        };
      } catch (err: any) {
        fastify.log.error({ err }, 'POST /api/lots/:id/pdf error');
        reply.statusCode = 500;
        return { error: 'Failed to save PDF', message: err?.message || String(err) };
      }
    });

    fastify.get('/api/lots/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid lot id' };
      }
      try {
        const result = await query('SELECT pdf_path FROM lots WHERE id = $1', [id]);
        const raw = (result.rows[0] as any)?.pdf_path;
        if (result.rowCount === 0 || !raw) {
          reply.statusCode = 404;
          return { error: 'PDF not found for this lot' };
        }
        let filePath = String(raw);
        if (filePath.startsWith('/api/') || filePath.startsWith('http')) {
          reply.statusCode = 404;
          return { error: 'PDF path invalid' };
        }
        const resolvedFile = resolvePdfFilePath(filePath);
        if (!resolvedFile || !fs.existsSync(resolvedFile)) {
          fastify.log.warn({ pdfPath: filePath, lotId: id, teamBase: TEAM_BASE_PATH }, 'GET /api/lots/:id/pdf file not found on disk');
          reply.statusCode = 404;
          return { error: 'PDF file not found' };
        }
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', 'inline; filename="lot-' + id + '.pdf"');
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
        return reply.send(fs.createReadStream(resolvedFile));
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/lots/:id/pdf error');
        reply.statusCode = 500;
        return { error: 'Failed to serve PDF' };
      }
    });

    fastify.get('/api/commandes/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid commande id' };
      }
      try {
        const result = await query('SELECT pdf_path FROM commandes WHERE id = $1', [id]);
        const raw = (result.rows[0] as any)?.pdf_path;
        if (result.rowCount === 0 || !raw) {
          reply.statusCode = 404;
          return { error: 'PDF not found for this commande' };
        }
        let filePath = String(raw);
        if (filePath.startsWith('/api/') || filePath.startsWith('http')) {
          reply.statusCode = 404;
          return { error: 'PDF path invalid' };
        }
        const resolvedFile = resolvePdfFilePath(filePath);
        // #region agent log
        if (typeof fetch === 'function') fetch('http://127.0.0.1:7680/ingest/250de527-3fcc-4619-b66e-c496868c4275',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'fdef1d'},body:JSON.stringify({sessionId:'fdef1d',runId:'run5',hypothesisId:'H10',location:'main.ts:/api/commandes/:id/pdf',message:'Commande PDF resolved path',data:{id,raw:filePath,resolvedFile},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!resolvedFile || !fs.existsSync(resolvedFile)) {
          reply.statusCode = 404;
          return { error: 'PDF file not found' };
        }
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', 'inline; filename="commande-' + id + '.pdf"');
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
        return reply.send(fs.createReadStream(resolvedFile));
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/commandes/:id/pdf error');
        reply.statusCode = 500;
        return { error: 'Failed to serve PDF' };
      }
    });

    fastify.get('/api/dons/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid don id' };
      }
      try {
        const result = await query('SELECT pdf_path FROM dons WHERE id = $1', [id]);
        const raw = (result.rows[0] as any)?.pdf_path;
        if (result.rowCount === 0 || !raw) {
          reply.statusCode = 404;
          return { error: 'PDF not found for this don' };
        }
        let filePath = String(raw);
        if (filePath.startsWith('/api/') || filePath.startsWith('http')) {
          reply.statusCode = 404;
          return { error: 'PDF path invalid' };
        }
        const resolvedFile = resolvePdfFilePath(filePath);
        // #region agent log
        if (typeof fetch === 'function') fetch('http://127.0.0.1:7680/ingest/250de527-3fcc-4619-b66e-c496868c4275',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'fdef1d'},body:JSON.stringify({sessionId:'fdef1d',runId:'run5',hypothesisId:'H10',location:'main.ts:/api/dons/:id/pdf',message:'Don PDF resolved path',data:{id,raw:filePath,resolvedFile},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!resolvedFile || !fs.existsSync(resolvedFile)) {
          reply.statusCode = 404;
          return { error: 'PDF file not found' };
        }
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', 'inline; filename="don-' + id + '.pdf"');
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
        return reply.send(fs.createReadStream(resolvedFile));
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/dons/:id/pdf error');
        reply.statusCode = 500;
        return { error: 'Failed to serve PDF' };
      }
    });

    // ——— Disques (sessions shred) ———
    fastify.get('/api/disques/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { year, month } = request.query as { year?: string; month?: string };
        let sql = `
          SELECT id, date, name, pdf_path, created_at, recovered_at
          FROM disques_sessions
        `;
        const params: any[] = [];
        if (year && /^\d{4}$/.test(year)) {
          sql += params.length ? ' AND ' : ' WHERE ';
          sql += " EXTRACT(YEAR FROM date) = $1";
          params.push(year);
        }
        if (month && /^(0?[1-9]|1[0-2])$/.test(month)) {
          sql += params.length ? ' AND ' : ' WHERE ';
          sql += ` EXTRACT(MONTH FROM date) = $${params.length + 1}`;
          params.push(parseInt(month, 10));
        }
        sql += ' ORDER BY date DESC, created_at DESC';
        const result = await query(sql, params);
        const sessions = (result.rows as any[]).map((row: any) => ({
          id: row.id,
          date: row.date,
          name: row.name,
          created_at: row.created_at,
          pdf_path: row.pdf_path,
          recovered_at: row.recovered_at ?? null,
          disk_count: 0
        }));
        if (sessions.length === 0) {
          return { sessions: [] };
        }
        const sessionIds = sessions.map((s: any) => s.id);
        const placeholders = sessionIds.map((_: any, i: number) => `$${i + 1}`).join(',');
        const disksResult = await query(
          `SELECT session_id, serial, marque, modele, size, disk_type, interface, shred
           FROM disques_session_disks WHERE session_id IN (${placeholders})`,
          sessionIds
        );
        const disksBySession: Record<number, any[]> = {};
        for (const r of disksResult.rows as any[]) {
          if (!disksBySession[r.session_id]) disksBySession[r.session_id] = [];
          disksBySession[r.session_id].push({
            serial: r.serial,
            marque: r.marque,
            modele: r.modele,
            size: r.size,
            disk_type: r.disk_type,
            interface: r.interface,
            shred: r.shred
          });
        }
        sessions.forEach((s: any) => {
          s.disks = disksBySession[s.id] || [];
          s.disk_count = s.disks.length;
        });
        return { sessions };
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/disques/sessions error');
        reply.statusCode = 500;
        return { error: 'Database error', message: err?.message };
      }
    });

    fastify.post('/api/disques/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body as any) || {};
      const dateStr = (body.date && /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)))
        ? String(body.date)
        : new Date().toISOString().slice(0, 10);
      const name = body.name != null ? String(body.name).trim() || null : null;
      const disks = Array.isArray(body.disks) ? body.disks : [];
      if (disks.length === 0) {
        reply.statusCode = 400;
        return { error: 'disks array is required and must not be empty' };
      }
      try {
        const insertSession = await query(
          'INSERT INTO disques_sessions (date, name) VALUES ($1, $2) RETURNING id, date, name, created_at, pdf_path',
          [dateStr, name]
        );
        const session = (insertSession.rows[0] as any);
        const sessionId = session.id;
        for (const d of disks) {
          await query(
            `INSERT INTO disques_session_disks (session_id, serial, marque, modele, size, disk_type, interface, shred)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              sessionId,
              (d.serial != null ? String(d.serial) : '').trim() || null,
              (d.marque != null ? String(d.marque) : '').trim() || null,
              (d.modele != null ? String(d.modele) : '').trim() || null,
              (d.size != null ? String(d.size) : '').trim() || null,
              (d.disk_type != null ? String(d.disk_type) : '').trim() || null,
              (d.interface != null ? String(d.interface) : '').trim() || null,
              (d.shred != null ? String(d.shred) : '').trim() || null
            ]
          );
        }
        const disksResult = await query(
          'SELECT serial, marque, modele, size, disk_type, interface, shred FROM disques_session_disks WHERE session_id = $1 ORDER BY id',
          [sessionId]
        );
        const rows = (disksResult.rows as any[]).map((r: any) => ({
          serial: r.serial,
          marque: r.marque,
          modele: r.modele,
          size: r.size,
          disk_type: r.disk_type,
          interface: r.interface,
          shred: r.shred
        }));
        return {
          id: sessionId,
          date: session.date,
          name: session.name,
          created_at: session.created_at,
          pdf_path: null as string | null,
          disks: rows
        };
      } catch (err: any) {
        fastify.log.error({ err }, 'POST /api/disques/sessions error');
        reply.statusCode = 500;
        return { error: 'Failed to create session', message: err?.message };
      }
    });

    fastify.get('/api/disques/sessions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid session id' };
      }
      try {
        const sessionResult = await query(
          'SELECT id, date, name, pdf_path, created_at, recovered_at FROM disques_sessions WHERE id = $1',
          [id]
        );
        if (sessionResult.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Session not found' };
        }
        const session = sessionResult.rows[0] as any;
        const disksResult = await query(
          'SELECT serial, marque, modele, size, disk_type, interface, shred FROM disques_session_disks WHERE session_id = $1 ORDER BY id',
          [id]
        );
        const disks = (disksResult.rows as any[]).map((r: any) => ({
          serial: r.serial,
          marque: r.marque,
          modele: r.modele,
          size: r.size,
          disk_type: r.disk_type,
          interface: r.interface,
          shred: r.shred
        }));
        return {
          id: session.id,
          date: session.date,
          name: session.name,
          pdf_path: session.pdf_path,
          created_at: session.created_at,
          recovered_at: session.recovered_at ?? null,
          disks
        };
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/disques/sessions/:id error');
        reply.statusCode = 500;
        return { error: 'Database error', message: err?.message };
      }
    });

    fastify.get('/api/disques/sessions/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid session id' };
      }
      try {
        const result = await query('SELECT pdf_path FROM disques_sessions WHERE id = $1', [id]);
        const raw = (result.rows[0] as any)?.pdf_path;
        if (result.rowCount === 0 || !raw) {
          reply.statusCode = 404;
          return { error: 'PDF not found for this session' };
        }
        let filePath = String(raw);
        if (filePath.startsWith('/api/') || filePath.startsWith('http')) {
          reply.statusCode = 404;
          return { error: 'PDF path invalid' };
        }
        const resolvedFile = resolvePdfFilePath(filePath);
        if (!resolvedFile || !fs.existsSync(resolvedFile)) {
          fastify.log.warn({ pdfPath: filePath, sessionId: id, teamBase: TEAM_BASE_PATH }, 'GET /api/disques/sessions/:id/pdf file not found on disk');
          reply.statusCode = 404;
          return { error: 'PDF file not found' };
        }
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', 'inline; filename="disques-session-' + id + '.pdf"');
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
        return reply.send(fs.createReadStream(resolvedFile));
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/disques/sessions/:id/pdf error');
        reply.statusCode = 500;
        return { error: 'Failed to serve PDF' };
      }
    });

    // Réception du PDF généré côté client (Electron), même principe que POST /api/lots/:id/pdf
    fastify.post('/api/disques/sessions/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};
      const pdfBase64 = body.pdf_base64;

      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid session id' };
      }
      if (!pdfBase64 || typeof pdfBase64 !== 'string') {
        reply.statusCode = 400;
        return { error: 'pdf_base64 is required', message: 'Le client doit envoyer le contenu du PDF en base64.' };
      }

      let buffer: Buffer;
      try {
        buffer = Buffer.from(pdfBase64, 'base64');
      } catch (_) {
        reply.statusCode = 400;
        return { error: 'Invalid base64', message: 'Contenu PDF invalide.' };
      }
      if (buffer.length === 0) {
        reply.statusCode = 400;
        return { error: 'Empty PDF', message: 'Le PDF est vide.' };
      }

      try {
        const sessionResult = await query(
          'SELECT id, date, name FROM disques_sessions WHERE id = $1',
          [id]
        );
        if (sessionResult.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Session not found' };
        }
        const session = sessionResult.rows[0] as any;
        const sessionForPath = {
          id: parseInt(id, 10),
          date: session.date,
          name: body.session_name != null ? String(body.session_name).trim() || null : session.name
        };
        const fullPath = buildDisquesPdfPath(sessionForPath);
        fs.writeFileSync(fullPath, buffer);
        await query('UPDATE disques_sessions SET pdf_path = $1 WHERE id = $2', [fullPath, id]);
        reply.statusCode = 200;
        return {
          success: true,
          pdf_path: fullPath,
          message: 'PDF enregistré ; « Voir le PDF » affichera cette version.'
        };
      } catch (err: any) {
        fastify.log.error({ err }, 'POST /api/disques/sessions/:id/pdf error');
        reply.statusCode = 500;
        return { error: 'Failed to save PDF', message: err?.message || String(err) };
      }
    });

    fastify.put('/api/disques/sessions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid session id' };
      }
      const body = (request.body as any) || {};
      try {
        const sessionResult = await query('SELECT id, date, name, pdf_path, recovered_at FROM disques_sessions WHERE id = $1', [id]);
        if (sessionResult.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Session not found' };
        }
        const session = sessionResult.rows[0] as any;
        if (body.name !== undefined) {
          const name = body.name != null ? String(body.name).trim() || null : null;
          await query('UPDATE disques_sessions SET name = $1 WHERE id = $2', [name, id]);
          session.name = name;
        }
        if (body.recovered_at !== undefined) {
          const recoveredAt = body.recovered_at != null && String(body.recovered_at).trim() !== '' ? String(body.recovered_at).trim() : null;
          await query('UPDATE disques_sessions SET recovered_at = $1 WHERE id = $2', [recoveredAt, id]);
          session.recovered_at = recoveredAt;
        }
        if (Array.isArray(body.disks)) {
          const disks = body.disks;
          await query('DELETE FROM disques_session_disks WHERE session_id = $1', [id]);
          for (const d of disks) {
            await query(
              `INSERT INTO disques_session_disks (session_id, serial, marque, modele, size, disk_type, interface, shred)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                id,
                (d.serial != null ? String(d.serial) : '').trim() || null,
                (d.marque != null ? String(d.marque) : '').trim() || null,
                (d.modele != null ? String(d.modele) : '').trim() || null,
                (d.size != null ? String(d.size) : '').trim() || null,
                (d.disk_type != null ? String(d.disk_type) : '').trim() || null,
                (d.interface != null ? String(d.interface) : '').trim() || null,
                (d.shred != null ? String(d.shred) : '').trim() || null
              ]
            );
          }
        }
        const updated = await query(
          'SELECT id, date, name, pdf_path, created_at, recovered_at FROM disques_sessions WHERE id = $1',
          [id]
        );
        const row = updated.rows[0] as any;
        const disksResult = await query(
          'SELECT serial, marque, modele, size, disk_type, interface, shred FROM disques_session_disks WHERE session_id = $1 ORDER BY id',
          [id]
        );
        const disks = (disksResult.rows as any[]).map((r: any) => ({
          serial: r.serial,
          marque: r.marque,
          modele: r.modele,
          size: r.size,
          disk_type: r.disk_type,
          interface: r.interface,
          shred: r.shred
        }));
        return {
          id: row.id,
          date: row.date,
          name: row.name,
          pdf_path: row.pdf_path,
          created_at: row.created_at,
          recovered_at: row.recovered_at ?? null,
          disks
        };
      } catch (err: any) {
        fastify.log.error({ err }, 'PUT /api/disques/sessions/:id error');
        reply.statusCode = 500;
        return { error: 'Database error', message: err?.message };
      }
    });

    fastify.post('/api/disques/sessions/:id/regenerate-pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid session id' };
      }
      reply.statusCode = 400;
      return {
        error: 'Régénération côté serveur désactivée',
        message: 'Régénérer le PDF depuis l\'application desktop (génération HTML puis envoi via POST /api/disques/sessions/:id/pdf).'
      };
    });

    fastify.post('/api/disques/sessions/:id/email', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid session id', message: 'Identifiant de session invalide.' };
      }
      const body = (request.body as any) || {};
      const email = body.email && String(body.email).trim();
      const subject = body.subject || `Lot disques #${id} - PDF`;
      const message = body.message || '';

      if (!email) {
        reply.statusCode = 400;
        return { error: 'email is required', message: 'Veuillez entrer une adresse email' };
      }

      try {
        const result = await query('SELECT pdf_path FROM disques_sessions WHERE id = $1', [id]);
        if (result.rowCount === 0 || !(result.rows[0] as any)?.pdf_path) {
          reply.statusCode = 404;
          return { error: 'PDF not found for this session', message: 'Générez d\'abord le PDF du lot disques.' };
        }
        let filePath = String((result.rows[0] as any).pdf_path);
        if (!filePath || filePath.startsWith('/api/') || filePath.startsWith('http')) {
          reply.statusCode = 404;
          return { error: 'PDF path invalid', message: 'Chemin PDF invalide.' };
        }
        const resolvedEmail = resolvePdfFilePath(filePath);
        if (!resolvedEmail || !fs.existsSync(resolvedEmail)) {
          fastify.log.warn({ filePath, sessionId: id }, 'POST /api/disques/sessions/:id/email PDF file not found on disk');
          reply.statusCode = 404;
          return { error: 'PDF file not found', message: 'Fichier PDF introuvable.' };
        }

        const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
        const smtpCfg: Record<string, string> = {
          SMTP_HOST: process.env.SMTP_HOST || 'localhost',
          SMTP_PORT: process.env.SMTP_PORT || '25',
          SMTP_SECURE: process.env.SMTP_SECURE || 'false',
          SMTP_USER: process.env.SMTP_USER || '',
          SMTP_PASS: process.env.SMTP_PASS || '',
          MAIL_FROM: process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost',
        };
        try {
          const smtpRows = await query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [smtpKeys]);
          for (const row of smtpRows.rows) { smtpCfg[row.key] = row.value ?? smtpCfg[row.key]; }
        } catch (_) {}

        const transporter = nodemailer.createTransport({
          host: smtpCfg.SMTP_HOST,
          port: parseInt(smtpCfg.SMTP_PORT, 10),
          secure: smtpCfg.SMTP_SECURE === 'true',
          auth: smtpCfg.SMTP_USER ? { user: smtpCfg.SMTP_USER, pass: smtpCfg.SMTP_PASS } : undefined
        });
        const fileName = path.basename(resolvedEmail);
        const pdfBuffer = fs.readFileSync(resolvedEmail);
        await transporter.sendMail({
          from: smtpCfg.MAIL_FROM,
          to: email,
          subject,
          text: message || `PDF du lot disques #${id} en pièce jointe.`,
          attachments: [{ filename: fileName, content: pdfBuffer }]
        });

        return { success: true, message: 'Email envoyé' };
      } catch (err: any) {
        const msg = err?.message || String(err);
        const isSmtp = /ECONNREFUSED|ETIMEDOUT|EAUTH|ESOCKET|ECONNRESET|Invalid login/i.test(msg);
        fastify.log.error({ err }, 'POST /api/disques/sessions/:id/email error');
        reply.statusCode = 500;
        return {
          error: 'Email send failed',
          message: isSmtp ? `Erreur envoi (SMTP): ${msg}` : `Erreur: ${msg}`
        };
      }
    });

    fastify.post('/api/lots/:id/email', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid lot id', message: 'Identifiant de lot invalide.' };
      }
      const body = (request.body as any) || {};
      const email = body.email && String(body.email).trim();
      const subject = body.subject || `Lot #${id} - PDF`;
      const message = body.message || '';

      if (!email) {
        reply.statusCode = 400;
        return { error: 'email is required', message: 'Veuillez entrer une adresse email' };
      }

      try {
        const result = await query('SELECT pdf_path FROM lots WHERE id = $1', [id]);
        if (result.rowCount === 0 || !(result.rows[0] as any)?.pdf_path) {
          reply.statusCode = 404;
          return { error: 'PDF not found for this lot', message: 'Générez d\'abord le PDF du lot.' };
        }
        let filePath = String((result.rows[0] as any).pdf_path);
        if (!filePath || filePath.startsWith('/api/') || filePath.startsWith('http')) {
          reply.statusCode = 404;
          return { error: 'PDF path invalid', message: 'Chemin PDF invalide.' };
        }
        const resolvedLotPdf = resolvePdfFilePath(filePath);
        if (!resolvedLotPdf || !fs.existsSync(resolvedLotPdf)) {
          fastify.log.warn({ pdfPath: filePath, lotId: id, teamBase: TEAM_BASE_PATH }, 'POST /api/lots/:id/email PDF file not found on disk');
          reply.statusCode = 404;
          return { error: 'PDF file not found', message: 'Fichier PDF introuvable.' };
        }

        // Lire la config SMTP depuis la DB (priorité) avec fallback sur .env
        const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
        const smtpCfg: Record<string, string> = {
          SMTP_HOST: process.env.SMTP_HOST || 'localhost',
          SMTP_PORT: process.env.SMTP_PORT || '25',
          SMTP_SECURE: process.env.SMTP_SECURE || 'false',
          SMTP_USER: process.env.SMTP_USER || '',
          SMTP_PASS: process.env.SMTP_PASS || '',
          MAIL_FROM: process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost',
        };
        try {
          const smtpRows = await query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [smtpKeys]);
          for (const row of smtpRows.rows) { smtpCfg[row.key] = row.value ?? smtpCfg[row.key]; }
        } catch (_) {}

        const transporter = nodemailer.createTransport({
          host: smtpCfg.SMTP_HOST,
          port: parseInt(smtpCfg.SMTP_PORT, 10),
          secure: smtpCfg.SMTP_SECURE === 'true',
          auth: smtpCfg.SMTP_USER ? { user: smtpCfg.SMTP_USER, pass: smtpCfg.SMTP_PASS } : undefined
        });
        const fileName = path.basename(resolvedLotPdf);
        // Lire le fichier en buffer pour éviter problèmes de stream avec nodemailer
        const pdfBuffer = fs.readFileSync(resolvedLotPdf);
        await transporter.sendMail({
          from: smtpCfg.MAIL_FROM,
          to: email,
          subject,
          text: message || `PDF du lot #${id} en pièce jointe.`,
          attachments: [{ filename: fileName, content: pdfBuffer }]
        });

        return { success: true, message: 'Email envoyé' };
      } catch (err: any) {
        const msg = err?.message || String(err);
        const isSmtp = /ECONNREFUSED|ETIMEDOUT|EAUTH|ESOCKET|ECONNRESET|Invalid login/i.test(msg);
        fastify.log.error({ err }, 'POST /api/lots/:id/email error');
        reply.statusCode = 500;
        return {
          error: 'Email send failed',
          message: isSmtp ? `Erreur envoi (SMTP): ${msg}` : `Erreur: ${msg}`
        };
      }
    });

    // WebSocket routes (client connects to ws://host:4000/ or ws://host:4000/ws)
    fastify.register(async (fastify: any) => {
      const wsHandler = (socket: any, request: any) => {
        const userId = `ws_user_${Date.now()}`;
        let username = `anon_${Math.random().toString(36).substr(2, 9)}`;
        let isAlive = true;

        const heartbeat = () => { isAlive = true; };

        // Store connected user
        const clientIp = request?.ip || request?.headers?.['x-forwarded-for'] || request?.socket?.remoteAddress || null;
        connectedUsers.set(userId, {
          id: userId,
          username,
          socket,
          connectedAt: new Date(),
          ip: clientIp ? String(clientIp).split(',')[0].trim() : undefined
        });

        fastify.log.info(`✅ WebSocket connected: ${username} (${userId})`);
        console.log(`[CHAT] WS connecté: ${username} (${userId}) | total connectés: ${connectedUsers.size}`);

        // Send welcome message (rawSocket défini en premier pour heartbeat + message/pong)
        const rawSocket = getRawSocket(socket);
        if (rawSocket) rawSocket.send(JSON.stringify({
          type: 'connected',
          userId,
          username,
          timestamp: new Date().toISOString(),
          connectedUsers: connectedUsers.size
        }));
        broadcastUserCount();

        // Helper for broadcasting à tous les clients connectés (snapshot pour ne manquer personne)
        const broadcast = (payload: any, excludeId?: string) => {
          const snapshot = Array.from(connectedUsers.values());
          const payloadStr = JSON.stringify(payload);
          const sentTo: string[] = [];
          for (const user of snapshot) {
            if (excludeId && user.id === excludeId) continue;
            if (sendToSocket(user.socket, payloadStr)) sentTo.push(user.id);
          }
          if (sentTo.length > 0) {
            fastify.log.info({ broadcastTo: sentTo.length, userIds: sentTo }, '[WS] broadcast sent');
            console.log(`[CHAT] Broadcast envoyé à ${sentTo.length} socket(s): ${sentTo.join(', ')}`);
          }
        };

        // Handle incoming messages + heartbeat: message et pong sur la socket brute ; ping aussi.
        const messageTarget = rawSocket && typeof (rawSocket as any).on === 'function' ? rawSocket : socket;
        const pingTarget = (messageTarget as any).ping ? messageTarget : socket;
        const PING_INTERVAL_MS = 45000;
        const pingInterval = setInterval(() => {
          if (!isAlive) {
            fastify.log.warn(`⏱️ Closing stale WebSocket for ${username} (${userId})`);
            console.log(`[CHAT] Connexion fermée (stale): ${username} (${userId})`);
            clearInterval(pingInterval);
            connectedUsers.delete(userId);
            const normalizedStale = String(username).trim().toLowerCase();
            activeSessions.delete(normalizedStale);
            broadcastUserCount();
            try {
              socket.terminate?.();
            } catch {
              try { socket.close(); } catch { /* ignore */ }
            }
            return;
          }
          isAlive = false;
          try {
            (pingTarget as any).ping();
          } catch {
            // Ignore ping failures
          }
        }, PING_INTERVAL_MS);

        messageTarget.on('message', async (data: any) => {
          try {
            const message = JSON.parse(data.toString());
            fastify.log.info({ type: message?.type }, '[WS] message reçu');
            console.log('[WS] message reçu:', message?.type);

            switch (message.type) {
            case 'auth': {
              let tokenUsername: string | null = null;
              const raw = (message.token || message.data?.token || '').toString().replace(/^Bearer\s+/i, '').trim();
              fastify.log.info({ hasToken: raw.length > 0 }, '[WS] auth message received');
              if (!raw) {
                const r = getRawSocket(socket);
                if (r) r.send(JSON.stringify({ type: 'auth_required', message: 'Token requis' }));
                break;
              }
              try {
                const jwtSecret = process.env.JWT_SECRET || 'changeme';
                const decoded = jwt.verify(raw, jwtSecret) as { username?: string };
                if (decoded && decoded.username) tokenUsername = String(decoded.username).trim().toLowerCase();
              } catch {
                // ignore invalid token
              }
              if (!tokenUsername) {
                fastify.log.warn('[WS] auth rejected: token invalide');
                const r = getRawSocket(socket);
                if (r) r.send(JSON.stringify({ type: 'error', message: 'Token invalide' }));
                break;
              }
              // Un compte = une connexion : refuser si déjà connecté ailleurs
              if (activeSessions.has(tokenUsername)) {
                const otherWithSameUser = Array.from(connectedUsers.entries()).find(
                  ([id, u]) => id !== userId && String(u.username).trim().toLowerCase() === tokenUsername
                );
                if (otherWithSameUser) {
                  connectedUsers.delete(userId);
                  try {
                    const raw = getRawSocket(socket);
                    if (raw) raw.send(JSON.stringify({ type: 'error', code: 'ALREADY_LOGGED_IN', message: 'Compte déjà connecté sur un autre poste.' }));
                  } catch { /* ignore */ }
                  try {
                    const raw = getRawSocket(socket);
                    if (raw && typeof (raw as any).terminate === 'function') (raw as any).terminate();
                    else if (raw && typeof (raw as any).close === 'function') (raw as any).close();
                  } catch { /* ignore */ }
                  break;
                }
              }
              username = tokenUsername;
              const existing = connectedUsers.get(userId);
              if (existing) existing.username = username;
              const zombies = Array.from(connectedUsers.entries()).filter(
                ([id, u]) => id !== userId && String(u.username).trim().toLowerCase() === tokenUsername
              );
              for (const [id, u] of zombies) {
                connectedUsers.delete(id);
                try {
                  const r = getRawSocket(u.socket);
                  if (r && typeof (r as any).terminate === 'function') (r as any).terminate();
                  else if (r && typeof (r as any).close === 'function') (r as any).close();
                } catch { /* ignore */ }
              }
              activeSessions.add(tokenUsername);
              fastify.log.info({ tokenUsername }, '[CHAT] Auth OK');
              console.log(`[CHAT] Auth OK: ${tokenUsername} (${userId}) | total: ${connectedUsers.size}`);
              const rAck = getRawSocket(socket);
              if (rAck) rAck.send(JSON.stringify({ type: 'auth:ack', ok: true }));
              broadcastUserCount();
              break;
            }

            case 'message':
            case 'message:send': {
              const isAuthenticated = username.startsWith('anon_') === false;
              // #region agent log
              if (!isAuthenticated) {
                const r = getRawSocket(socket);
                if (r) r.send(JSON.stringify({ type: 'error', message: 'Authentification requise' }));
                break;
              }
              const text = message.text || message.data?.text;
              if (!text || !text.toString().trim()) {
                const r = getRawSocket(socket);
                if (r) r.send(JSON.stringify({ type: 'error', message: 'Message text is required' }));
                break;
              }
              try {
                const insertResult = await query(
                  'INSERT INTO messages (user_id, username, text, conversation_id, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, username, text, created_at',
                  [null, username, String(text).trim(), null]
                );
                const row = insertResult.rows[0];
                messageCount++;
                incrementMessageCount();
                const outbound = {
                  type: 'message:new',
                  data: {
                    id: row.id,
                    username: row.username,
                    pseudo: row.username,
                    text: row.text,
                    message: row.text,
                    createdAt: row.created_at,
                    created_at: row.created_at
                  }
                };
                const recipientCount = connectedUsers.size;
                const textPreview = String(text).substring(0, 40) + (String(text).length > 40 ? '…' : '');
                fastify.log.info(`[WS] broadcast message:new → ${recipientCount} client(s) | msg=${outbound.data.id} | "${textPreview}"`);
                console.log(`[CHAT] Message de ${username} → broadcast à ${recipientCount} client(s) | "${textPreview}"`);
                broadcast(outbound);
              } catch (dbErr: any) {
                fastify.log.error({ err: dbErr }, 'DB insert message');
                const r = getRawSocket(socket);
                if (r) r.send(JSON.stringify({ type: 'error', message: 'Erreur enregistrement message' }));
              }
              break;
            }

            default:
              fastify.log.warn(`Unknown message type: ${message.type}`);
            }
          } catch (e) {
            fastify.log.error(`Error parsing message: ${e}`);
            try {
              const r = getRawSocket(socket);
              if (r) r.send(JSON.stringify({ type: 'error', message: 'Invalid message payload' }));
            } catch {
              // Ignore send failures
            }
          }
        });

        // Handle disconnection (sur la socket brute, comme message/pong)
        (messageTarget as any).on('close', (code?: number, reason?: Buffer) => {
          const hadEntry = connectedUsers.has(userId);
          const normalizedUsername = String(username).trim().toLowerCase();
          connectedUsers.delete(userId);
          activeSessions.delete(normalizedUsername);
          fastify.log.info(`❌ WebSocket disconnected: ${username} (${userId}) hadEntry=${hadEntry} code=${code}`);
          console.log(`[CHAT] Déconnexion: ${username} (${userId}) | restants: ${connectedUsers.size}`);

          clearInterval(pingInterval);
          if (hadEntry) broadcastUserCount();
        });

        // Handle errors (socket brute ; ex: reload sans close frame)
        (messageTarget as any).on('error', (error: any) => {
          fastify.log.error(`WebSocket error for ${username}: ${error?.message || error}`);
          connectedUsers.delete(userId);
          const normalized = String(username).trim().toLowerCase();
          activeSessions.delete(normalized);
          clearInterval(pingInterval);
          broadcastUserCount();
        });

        // Handle pong response
        (messageTarget as any).on('pong', () => {
          heartbeat();
        });
      };
      fastify.get('/ws', { websocket: true }, wsHandler);
      fastify.get('/', { websocket: true }, wsHandler);
    });

    // Shortcuts routes (protégées par JWT ; optionnel : type, path pour raccourcis internes)
    fastify.get('/api/shortcuts', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        return sendAuthRequired(reply);
      }
      try {
        const result = await query(
          `SELECT s.id, s.name AS title, s.description, s.url, s.category_id, s.order_index, s.created_at
           FROM shortcuts s
           LEFT JOIN shortcut_categories sc ON sc.id = s.category_id
           WHERE s.user_id = $1
              OR (s.user_id IS NULL AND sc.user_id = $1)
           ORDER BY category_id ASC NULLS FIRST, order_index ASC`,
          [userId]
        );
        return { success: true, shortcuts: result.rows };
      } catch (error: any) {
        console.error('Error fetching shortcuts:', error);
        if (error?.code === '42703') {
          // Compat schéma legacy: colonne "title" au lieu de "name"
          try {
            const fallback = await query(
              `SELECT s.id, s.title AS title, s.description, s.url, s.category_id, s.order_index, s.created_at
               FROM shortcuts s
               LEFT JOIN shortcut_categories sc ON sc.id = s.category_id
               WHERE s.user_id = $1
                  OR (s.user_id IS NULL AND sc.user_id = $1)
               ORDER BY category_id ASC NULLS FIRST, order_index ASC`,
              [userId]
            );
            return { success: true, shortcuts: fallback.rows };
          } catch {
            return { success: true, shortcuts: [] };
          }
        }
        if (error?.code === '42P01') {
          // Déploiement partiel/migration incomplète: ne pas casser la page "Mes raccourcis"
          return { success: true, shortcuts: [] };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/shortcuts', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        return sendAuthRequired(reply);
      }
      const { title, description, url, category_id, categoryId } = request.body as any;
      const finalCategoryId = category_id || categoryId;

      if (!title || !title.trim() || !url || !url.trim()) {
        reply.statusCode = 400;
        return { error: 'Title and URL are required' };
      }

      try {
        if (finalCategoryId) {
          const categoryCheck = await query(
            'SELECT 1 FROM shortcut_categories WHERE id = $1 AND user_id = $2',
            [finalCategoryId, userId]
          );
          if (categoryCheck.rowCount === 0) {
            reply.statusCode = 403;
            return { error: 'Category not found' };
          }
        }

        const result = await query(
          `INSERT INTO shortcuts (user_id, name, description, url, category_id, order_index)
           VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(order_index) + 1, 0) FROM shortcuts WHERE user_id = $1 AND (category_id = $5 OR (category_id IS NULL AND $5 IS NULL))))
           RETURNING id, name AS title, description, url, category_id, order_index, created_at`,
          [userId, title.trim(), description || null, url.trim(), finalCategoryId || null]
        );
        return { success: true, shortcut: result.rows[0] };
      } catch (error: any) {
        console.error('Error creating shortcut:', error);
        if (error?.code === '42703') {
          // Compat schéma legacy: colonne "title" au lieu de "name"
          try {
            const result = await query(
              `INSERT INTO shortcuts (user_id, title, description, url, category_id, order_index)
               VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(order_index) + 1, 0) FROM shortcuts WHERE user_id = $1 AND (category_id = $5 OR (category_id IS NULL AND $5 IS NULL))))
               RETURNING id, title, description, url, category_id, order_index, created_at`,
              [userId, title.trim(), description || null, url.trim(), finalCategoryId || null]
            );
            return { success: true, shortcut: result.rows[0] };
          } catch (fallbackError) {
            console.error('Error creating shortcut on legacy schema:', fallbackError);
          }
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.put('/api/shortcuts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        return sendAuthRequired(reply);
      }
      const { id } = request.params as { id: string };
      const { title, description, url, category_id, categoryId } = request.body as any;
      const finalCategoryId = category_id ?? categoryId;

      try {
        const ownership = await query(
          'SELECT id, category_id FROM shortcuts WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        if (ownership.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Raccourci introuvable' };
        }
        if (finalCategoryId != null) {
          const categoryCheck = await query(
            'SELECT 1 FROM shortcut_categories WHERE id = $1 AND user_id = $2',
            [finalCategoryId, userId]
          );
          if (categoryCheck.rowCount === 0) {
            reply.statusCode = 403;
            return { error: 'Category not found' };
          }
        }

        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;
        if (title !== undefined) { updates.push(`name = $${paramIndex++}`); values.push(title != null ? String(title).trim() : null); }
        if (description !== undefined) { updates.push(`description = $${paramIndex++}`); values.push(description != null ? String(description).trim() : null); }
        if (url !== undefined) { updates.push(`url = $${paramIndex++}`); values.push(url != null ? String(url).trim() : null); }
        if (finalCategoryId !== undefined) { updates.push(`category_id = $${paramIndex++}`); values.push(finalCategoryId || null); }
        if (updates.length === 0) {
          reply.statusCode = 400;
          return { error: 'No fields to update' };
        }
        updates.push('updated_at = NOW()');
        values.push(id, userId);
        const whereIdParam = values.length - 1;
        const whereUserIdParam = values.length;
        const result = await query(
          `UPDATE shortcuts SET ${updates.join(', ')} WHERE id = $${whereIdParam} AND user_id = $${whereUserIdParam} RETURNING id, name AS title, description, url, category_id, order_index, created_at`,
          values
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Raccourci introuvable' };
        }
        return { success: true, shortcut: result.rows[0] };
      } catch (error: any) {
        console.error('Error updating shortcut:', error);
        if (error?.code === '42703') {
          // Compat schéma legacy: colonne "title" au lieu de "name"
          try {
            const updates: string[] = [];
            const values: any[] = [];
            let paramIndex = 1;
            if (title !== undefined) { updates.push(`title = $${paramIndex++}`); values.push(title != null ? String(title).trim() : null); }
            if (description !== undefined) { updates.push(`description = $${paramIndex++}`); values.push(description != null ? String(description).trim() : null); }
            if (url !== undefined) { updates.push(`url = $${paramIndex++}`); values.push(url != null ? String(url).trim() : null); }
            if (finalCategoryId !== undefined) { updates.push(`category_id = $${paramIndex++}`); values.push(finalCategoryId || null); }
            if (updates.length === 0) {
              reply.statusCode = 400;
              return { error: 'No fields to update' };
            }
            updates.push('updated_at = NOW()');
            values.push(id, userId);
            const whereIdParam = values.length - 1;
            const whereUserIdParam = values.length;
            const fallback = await query(
              `UPDATE shortcuts SET ${updates.join(', ')} WHERE id = $${whereIdParam} AND user_id = $${whereUserIdParam} RETURNING id, title, description, url, category_id, order_index, created_at`,
              values
            );
            if (fallback.rowCount === 0) {
              reply.statusCode = 404;
              return { error: 'Raccourci introuvable' };
            }
            return { success: true, shortcut: fallback.rows[0] };
          } catch (fallbackError) {
            console.error('Error updating shortcut on legacy schema:', fallbackError);
          }
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.delete('/api/shortcuts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(request);
      if (userId === null) {
        return sendAuthRequired(reply);
      }
      const { id } = request.params as { id: string };
      try {
        const result = await query(
          'DELETE FROM shortcuts WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Raccourci introuvable' };
        }
        return { success: true };
      } catch (error: any) {
        console.error('Error deleting shortcut:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // API Commande (produits pour l'onglet Réception > Commande)
    fastify.get('/api/commandes/products', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await query(
          'SELECT id, name FROM commande_products ORDER BY name'
        );
        return { success: true, items: result.rows };
      } catch (error) {
        console.error('Error fetching commande products:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.get('/api/commandes/categories', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await query(
          'SELECT id, name FROM commande_categories ORDER BY name'
        );
        return { success: true, items: result.rows };
      } catch (error: any) {
        if (error?.code === '42P01') return { success: true, items: [] };
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/commandes/categories', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.body as any;
      const trimmed = String(name || '').trim();
      if (!trimmed) {
        reply.statusCode = 400;
        return { error: 'Category name is required' };
      }
      try {
        const existing = await query('SELECT id, name FROM commande_categories WHERE LOWER(name) = LOWER($1) LIMIT 1', [trimmed]);
        if (existing.rowCount && existing.rows[0]) {
          return { success: true, category: existing.rows[0] };
        }
        const result = await query(
          'INSERT INTO commande_categories (name) VALUES ($1) RETURNING id, name',
          [trimmed]
        );
        return { success: true, category: result.rows[0] };
      } catch (error: any) {
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Table commande_categories manquante (migration requise)' };
        }
        if (error?.code === '23505') {
          const existing = await query('SELECT id, name FROM commande_categories WHERE LOWER(name) = LOWER($1) LIMIT 1', [trimmed]);
          return { success: true, category: existing.rows[0] || { name: trimmed } };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/commandes', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as any;
      const commandeName = String(body?.commande_name || body?.name || '').trim();
      const category = String(body?.category || '').trim();
      const date = String(body?.date || '').trim() || new Date().toISOString().slice(0, 10);
      const pdfPath = String(body?.pdf_path || '').trim() || null;
      const lines = Array.isArray(body?.lines) ? body.lines : [];
      if (!commandeName) {
        reply.statusCode = 400;
        return { error: 'commande_name is required' };
      }
      try {
        const header = await query(
          `INSERT INTO commandes (user_id, name, category, date, pdf_path)
           VALUES (NULL, $1, $2, $3, $4)
           RETURNING id, user_id, name AS commande_name, category, date, pdf_path, created_at`,
          [commandeName, category || null, date, pdfPath]
        );
        const commande = header.rows[0];
        for (const line of lines) {
          const quantity = Number(line?.quantity || 0) || 0;
          const unitPrice = line?.price != null && String(line.price).trim() !== '' ? Number(line.price) : null;
          const shippingCost = line?.shipping != null && String(line.shipping).trim() !== '' ? Number(line.shipping) : null;
          const link = line?.link != null ? String(line.link).trim() || null : null;
          const productName = String(line?.produit || line?.product_name || '').trim() || null;
          const productIdRaw = line?.productId != null ? String(line.productId).trim() : '';
          const productId = productIdRaw !== '' && /^\d+$/.test(productIdRaw) ? Number(productIdRaw) : null;
          await query(
            `INSERT INTO commande_lignes (commande_id, commande_product_id, product_name, quantity, unit_price, shipping_cost, link)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [commande.id, productId, productName, quantity, unitPrice, shippingCost, link]
          );
        }
        return { success: true, commande };
      } catch (error: any) {
        console.error('Error creating commande:', error);
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Tables commandes/commande_lignes manquantes (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.get('/api/commandes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const header = await query(
          `SELECT id, user_id, name AS commande_name, category, date, pdf_path, created_at
           FROM commandes
           WHERE id = $1`,
          [id]
        );
        if (header.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Commande introuvable' };
        }
        const lignes = await query(
          `SELECT l.id,
                  l.commande_id,
                  l.commande_product_id,
                  l.product_name,
                  l.quantity,
                  l.unit_price,
                  l.shipping_cost,
                  l.link,
                  p.name AS product_name_ref
           FROM commande_lignes l
           LEFT JOIN commande_products p ON p.id = l.commande_product_id
           WHERE l.commande_id = $1
           ORDER BY l.id`,
          [id]
        );
        return { success: true, commande: { ...header.rows[0], lines: lignes.rows } };
      } catch (error: any) {
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Tables commandes/commande_lignes manquantes (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.put('/api/commandes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;
      const commandeName = body?.commande_name != null ? String(body.commande_name).trim() : undefined;
      const category = body?.category != null ? String(body.category).trim() : undefined;
      const date = body?.date != null ? String(body.date).trim() : undefined;
      const pdfPath = body?.pdf_path != null ? String(body.pdf_path).trim() : undefined;
      const incomingLines = Array.isArray(body?.lines) ? body.lines : null;
      try {
        const existing = await query(
          'SELECT id FROM commandes WHERE id = $1',
          [id]
        );
        if (existing.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Commande introuvable' };
        }

        const updates: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (commandeName !== undefined) { updates.push(`name = $${idx++}`); values.push(commandeName || null); }
        if (category !== undefined) { updates.push(`category = $${idx++}`); values.push(category || null); }
        if (date !== undefined) { updates.push(`date = $${idx++}`); values.push(date || null); }
        if (pdfPath !== undefined) { updates.push(`pdf_path = $${idx++}`); values.push(pdfPath || null); }
        if (updates.length > 0) {
          values.push(id);
          await query(
            `UPDATE commandes SET ${updates.join(', ')} WHERE id = $${values.length}`,
            values
          );
        }

        if (incomingLines) {
          await query('DELETE FROM commande_lignes WHERE commande_id = $1', [id]);
          for (const line of incomingLines) {
            const quantity = Number(line?.quantity || 0) || 0;
            const unitPrice = line?.price != null && String(line.price).trim() !== '' ? Number(line.price) : (line?.unit_price != null ? Number(line.unit_price) : null);
            const shippingCost = line?.shipping != null && String(line.shipping).trim() !== '' ? Number(line.shipping) : (line?.shipping_cost != null ? Number(line.shipping_cost) : null);
            const link = line?.link != null ? String(line.link).trim() || null : null;
            const productName = String(line?.produit || line?.product_name || '').trim() || null;
            const productIdRaw = line?.productId != null ? String(line.productId).trim() : (line?.commande_product_id != null ? String(line.commande_product_id).trim() : '');
            const productId = productIdRaw !== '' && /^\d+$/.test(productIdRaw) ? Number(productIdRaw) : null;
            await query(
              `INSERT INTO commande_lignes (commande_id, commande_product_id, product_name, quantity, unit_price, shipping_cost, link)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [id, productId, productName, quantity, unitPrice, shippingCost, link]
            );
          }
        }

        const header = await query(
          `SELECT id, user_id, name AS commande_name, category, date, pdf_path, created_at
           FROM commandes
           WHERE id = $1`,
          [id]
        );
        const lignes = await query(
          `SELECT l.id,
                  l.commande_id,
                  l.commande_product_id,
                  l.product_name,
                  l.quantity,
                  l.unit_price,
                  l.shipping_cost,
                  l.link,
                  p.name AS product_name_ref
           FROM commande_lignes l
           LEFT JOIN commande_products p ON p.id = l.commande_product_id
           WHERE l.commande_id = $1
           ORDER BY l.id`,
          [id]
        );
        return { success: true, commande: { ...header.rows[0], lines: lignes.rows } };
      } catch (error: any) {
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Tables commandes/commande_lignes manquantes (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.get('/api/commandes/tracabilite', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await query(
          `SELECT c.id,
                  c.user_id,
                  c.name AS commande_name,
                  c.category,
                  c.date,
                  c.pdf_path,
                  c.created_at,
                  COALESCE(COUNT(cl.id), 0)::int AS line_count
           FROM commandes c
           LEFT JOIN commande_lignes cl ON cl.commande_id = c.id
           GROUP BY c.id, c.user_id, c.name, c.category, c.date, c.pdf_path, c.created_at
           ORDER BY c.date DESC, c.created_at DESC`
        );
        return { success: true, data: result.rows };
      } catch (error) {
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/dons', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as any;
      const lotName = String(body?.lot_name || body?.name || '').trim() || null;
      const date = String(body?.date || '').trim() || new Date().toISOString().slice(0, 10);
      const pdfPath = String(body?.pdf_path || '').trim() || null;
      const lines = Array.isArray(body?.lines) ? body.lines : [];
      try {
        const result = await query(
          `INSERT INTO dons (user_id, lot_name, date, pdf_path, lines)
           VALUES (NULL, $1, $2, $3, $4::jsonb)
           RETURNING id, user_id, lot_name, date, pdf_path, lines, created_at`,
          [lotName, date, pdfPath, JSON.stringify(lines)]
        );
        return { success: true, don: result.rows[0] };
      } catch (error: any) {
        console.error('Error creating don:', error);
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Table dons manquante (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.get('/api/dons/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await query(
          `SELECT id, user_id, lot_name, date, pdf_path, lines, created_at
           FROM dons
           WHERE id = $1`,
          [id]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Don introuvable' };
        }
        return { success: true, don: result.rows[0] };
      } catch (error: any) {
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Table dons manquante (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.put('/api/dons/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;
      const lotName = body?.lot_name != null ? String(body.lot_name).trim() : (body?.name != null ? String(body.name).trim() : undefined);
      const date = body?.date != null ? String(body.date).trim() : undefined;
      const pdfPath = body?.pdf_path != null ? String(body.pdf_path).trim() : undefined;
      const lines = Array.isArray(body?.lines) ? body.lines : undefined;
      try {
        const existing = await query(
          'SELECT id FROM dons WHERE id = $1',
          [id]
        );
        if (existing.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Don introuvable' };
        }
        const updates: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (lotName !== undefined) { updates.push(`lot_name = $${idx++}`); values.push(lotName || null); }
        if (date !== undefined) { updates.push(`date = $${idx++}`); values.push(date || null); }
        if (pdfPath !== undefined) { updates.push(`pdf_path = $${idx++}`); values.push(pdfPath || null); }
        if (lines !== undefined) { updates.push(`lines = $${idx++}::jsonb`); values.push(JSON.stringify(lines)); }
        if (updates.length === 0) {
          reply.statusCode = 400;
          return { error: 'No fields to update' };
        }
        values.push(id);
        const result = await query(
          `UPDATE dons
           SET ${updates.join(', ')}
           WHERE id = $${values.length}
           RETURNING id, user_id, lot_name, date, pdf_path, lines, created_at`,
          values
        );
        return { success: true, don: result.rows[0] };
      } catch (error: any) {
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Table dons manquante (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.get('/api/dons/tracabilite', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await query(
          'SELECT id, user_id, lot_name, date, pdf_path, lines, created_at FROM dons ORDER BY date DESC, created_at DESC'
        );
        return { success: true, data: result.rows };
      } catch (error: any) {
        if (error?.code === '42P01') return { success: true, data: [] };
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // ——— Prêts matériel (réception) ———
    fastify.get('/api/prets-materiel/tracabilite', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await query(
          `SELECT id, user_id, reference, borrower_type, borrower_name, borrower_contact,
                  date, date_debut, date_fin, remuneration_gratuit, remuneration_montant,
                  pdf_path, lines, created_at, updated_at
           FROM prets_materiel
           ORDER BY date_debut DESC, created_at DESC`
        );
        return { success: true, data: result.rows };
      } catch (error: any) {
        if (error?.code === '42P01') return { success: true, data: [] };
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/prets-materiel', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as any;
      const borrowerName = String(body?.borrower_name || '').trim();
      if (!borrowerName) {
        reply.statusCode = 400;
        return { error: 'borrower_name requis' };
      }
      const dateDebut = String(body?.date_debut || body?.date || '').trim().slice(0, 10) || new Date().toISOString().slice(0, 10);
      const dateFin = String(body?.date_fin || '').trim().slice(0, 10) || dateDebut;
      const docDate = String(body?.date || body?.date_debut || '').trim().slice(0, 10) || dateDebut;
      const borrowerType =
        String(body?.borrower_type || 'personne').toLowerCase() === 'societe' ? 'societe' : 'personne';
      const borrowerContact =
        body?.borrower_contact != null && String(body.borrower_contact).trim()
          ? String(body.borrower_contact).trim()
          : null;
      const reference =
        body?.reference != null && String(body.reference).trim() ? String(body.reference).trim() : null;
      const pdfPath = body?.pdf_path != null && String(body.pdf_path).trim() ? String(body.pdf_path).trim() : null;
      const lines = Array.isArray(body?.lines) ? body.lines : [];
      const rgRaw = body?.remuneration_gratuit;
      const remuneration_gratuit =
        rgRaw !== false && rgRaw !== 0 && String(rgRaw ?? 'true').toLowerCase() !== 'false';
      let remuneration_montant: number | null = null;
      if (!remuneration_gratuit) {
        const rm = body?.remuneration_montant;
        const n = rm != null && rm !== '' ? Number(rm) : NaN;
        remuneration_montant = Number.isFinite(n) ? n : null;
      }
      try {
        const result = await query(
          `INSERT INTO prets_materiel (
            user_id, reference, borrower_type, borrower_name, borrower_contact,
            date, date_debut, date_fin, remuneration_gratuit, remuneration_montant, pdf_path, lines
          ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
          RETURNING id, user_id, reference, borrower_type, borrower_name, borrower_contact,
                    date, date_debut, date_fin, remuneration_gratuit, remuneration_montant, pdf_path, lines, created_at, updated_at`,
          [
            reference,
            borrowerType,
            borrowerName,
            borrowerContact,
            docDate,
            dateDebut,
            dateFin,
            remuneration_gratuit,
            remuneration_montant,
            pdfPath,
            JSON.stringify(lines),
          ]
        );
        reply.statusCode = 201;
        const row = result.rows[0];
        return { success: true, id: row.id, pret: row };
      } catch (error: any) {
        console.error('Error creating pret materiel:', error);
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Table prets_materiel manquante (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.get('/api/prets-materiel/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id || id === 'null' || id === 'undefined') {
        reply.statusCode = 400;
        return { error: 'Invalid pret id' };
      }
      try {
        const result = await query('SELECT pdf_path FROM prets_materiel WHERE id = $1', [id]);
        const raw = (result.rows[0] as any)?.pdf_path;
        if (result.rowCount === 0 || !raw) {
          reply.statusCode = 404;
          return { error: 'PDF not found for this pret' };
        }
        let filePath = String(raw);
        if (filePath.startsWith('/api/') || filePath.startsWith('http')) {
          reply.statusCode = 404;
          return { error: 'PDF path invalid' };
        }
        const resolvedFile = resolvePdfFilePath(filePath);
        if (!resolvedFile || !fs.existsSync(resolvedFile)) {
          reply.statusCode = 404;
          return { error: 'PDF file not found' };
        }
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', 'inline; filename="pret-materiel-' + id + '.pdf"');
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
        return reply.send(fs.createReadStream(resolvedFile));
      } catch (err: any) {
        fastify.log.error({ err }, 'GET /api/prets-materiel/:id/pdf error');
        reply.statusCode = 500;
        return { error: 'Failed to serve PDF' };
      }
    });

    fastify.get('/api/prets-materiel/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await query(
          `SELECT id, user_id, reference, borrower_type, borrower_name, borrower_contact,
                  date, date_debut, date_fin, remuneration_gratuit, remuneration_montant,
                  pdf_path, lines, created_at, updated_at
           FROM prets_materiel WHERE id = $1`,
          [id]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Prêt matériel introuvable' };
        }
        return { success: true, pret: result.rows[0] };
      } catch (error: any) {
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Table prets_materiel manquante (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.put('/api/prets-materiel/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;
      try {
        const existing = await query('SELECT id FROM prets_materiel WHERE id = $1', [id]);
        if (existing.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Prêt matériel introuvable' };
        }
        const updates: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (body?.reference !== undefined) {
          updates.push(`reference = $${idx++}`);
          values.push(body.reference != null && String(body.reference).trim() ? String(body.reference).trim() : null);
        }
        if (body?.borrower_type !== undefined) {
          updates.push(`borrower_type = $${idx++}`);
          values.push(
            String(body.borrower_type || 'personne').toLowerCase() === 'societe' ? 'societe' : 'personne'
          );
        }
        if (body?.borrower_name !== undefined) {
          updates.push(`borrower_name = $${idx++}`);
          values.push(String(body.borrower_name || '').trim() || null);
        }
        if (body?.borrower_contact !== undefined) {
          updates.push(`borrower_contact = $${idx++}`);
          values.push(
            body.borrower_contact != null && String(body.borrower_contact).trim()
              ? String(body.borrower_contact).trim()
              : null
          );
        }
        if (body?.date !== undefined) {
          updates.push(`date = $${idx++}`);
          values.push(String(body.date || '').trim().slice(0, 10) || null);
        }
        if (body?.date_debut !== undefined) {
          updates.push(`date_debut = $${idx++}`);
          values.push(String(body.date_debut || '').trim().slice(0, 10) || null);
        }
        if (body?.date_fin !== undefined) {
          updates.push(`date_fin = $${idx++}`);
          values.push(String(body.date_fin || '').trim().slice(0, 10) || null);
        }
        if (body?.remuneration_gratuit !== undefined) {
          updates.push(`remuneration_gratuit = $${idx++}`);
          const rg = body.remuneration_gratuit;
          values.push(rg !== false && rg !== 0 && String(rg ?? 'true').toLowerCase() !== 'false');
        }
        if (body?.remuneration_montant !== undefined) {
          updates.push(`remuneration_montant = $${idx++}`);
          const rm = body.remuneration_montant;
          const n = rm != null && rm !== '' ? Number(rm) : NaN;
          values.push(Number.isFinite(n) ? n : null);
        }
        if (body?.pdf_path !== undefined) {
          updates.push(`pdf_path = $${idx++}`);
          values.push(body.pdf_path != null && String(body.pdf_path).trim() ? String(body.pdf_path).trim() : null);
        }
        if (body?.lines !== undefined) {
          updates.push(`lines = $${idx++}::jsonb`);
          values.push(JSON.stringify(Array.isArray(body.lines) ? body.lines : []));
        }
        if (updates.length === 0) {
          reply.statusCode = 400;
          return { error: 'No fields to update' };
        }
        updates.push(`updated_at = NOW()`);
        values.push(id);
        const result = await query(
          `UPDATE prets_materiel SET ${updates.join(', ')} WHERE id = $${values.length}
           RETURNING id, user_id, reference, borrower_type, borrower_name, borrower_contact,
                     date, date_debut, date_fin, remuneration_gratuit, remuneration_montant, pdf_path, lines, created_at, updated_at`,
          values
        );
        return { success: true, pret: result.rows[0] };
      } catch (error: any) {
        if (error?.code === '42P01') {
          reply.statusCode = 500;
          return { error: 'Table prets_materiel manquante (migration requise)' };
        }
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/commandes/products', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.body as any;
      if (!name || !String(name).trim()) {
        reply.statusCode = 400;
        return { error: 'Name is required' };
      }
      try {
        const result = await query(
          'INSERT INTO commande_products (name) VALUES ($1) RETURNING id, name',
          [String(name).trim()]
        );
        return { success: true, id: result.rows[0].id, name: result.rows[0].name };
      } catch (error: any) {
        console.error('Error creating commande product:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.put('/api/commandes/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { name } = request.body as any;
      if (!name || !String(name).trim()) {
        reply.statusCode = 400;
        return { error: 'Name is required' };
      }
      try {
        const result = await query(
          'UPDATE commande_products SET name = $1 WHERE id = $2 RETURNING id, name',
          [String(name).trim(), id]
        );
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Produit introuvable' };
        }
        return { success: true, id: result.rows[0].id, name: result.rows[0].name };
      } catch (error: any) {
        console.error('Error updating commande product:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.delete('/api/commandes/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await query('DELETE FROM commande_products WHERE id = $1', [id]);
        if (result.rowCount === 0) {
          reply.statusCode = 404;
          return { error: 'Produit introuvable' };
        }
        return { success: true };
      } catch (error: any) {
        console.error('Error deleting commande product:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // API Entrées (réception) — sans auth
    fastify.get('/api/entrees', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { limit = '100', offset = '0', type } = request.query as { limit?: string; offset?: string; type?: string };
        const limitNum = Math.min(parseInt(limit, 10) || 100, 200);
        const offsetNum = Math.max(0, parseInt(offset, 10) || 0);
        let sql = `SELECT e.id, e.date, e.type, e.lot_id, e.disque_session_id, e.description, e.created_at,
                    l.name AS lot_name, d.name AS disque_session_name
                    FROM entrees e
                    LEFT JOIN lots l ON e.lot_id = l.id
                    LEFT JOIN disques_sessions d ON e.disque_session_id = d.id
                    WHERE 1=1`;
        const params: any[] = [];
        let i = 1;
        if (type) { sql += ` AND e.type = $${i++}`; params.push(type); }
        sql += ` ORDER BY e.date DESC, e.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
        params.push(limitNum, offsetNum);
        const result = await query(sql, params);
        const countResult = await query<{ count: string }>('SELECT COUNT(*) AS count FROM entrees' + (type ? ' WHERE type = $1' : ''), type ? [type] : []);
        const total = parseInt(countResult.rows[0]?.count || '0', 10);
        return { success: true, data: result.rows, pagination: { total, limit: limitNum, offset: offsetNum } };
      } catch (error: any) {
        console.error('Error fetching entrees:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    fastify.post('/api/entrees', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { date?: string; type?: string; lot_id?: number; disque_session_id?: number; description?: string };
      const date = body.date || new Date().toISOString().slice(0, 10);
      const type = (body.type && String(body.type).trim()) || 'manual';
      const lot_id = body.lot_id != null ? (Number(body.lot_id) || null) : null;
      const disque_session_id = body.disque_session_id != null ? (Number(body.disque_session_id) || null) : null;
      const description = body.description != null ? String(body.description).trim() || null : null;
      try {
        const result = await query(
          `INSERT INTO entrees (date, type, lot_id, disque_session_id, description) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, date, type, lot_id, disque_session_id, description, created_at`,
          [date, type, lot_id, disque_session_id, description]
        );
        return { success: true, entree: result.rows[0] };
      } catch (error: any) {
        console.error('Error creating entree:', error);
        reply.statusCode = 500;
        return { error: 'Database error' };
      }
    });

    // Start server
    await fastify.listen({ port: proxmoxConfig.port, host: '0.0.0.0' });

    // Get server IP for banner
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let serverIP = 'localhost';
    for (const name of Object.keys(interfaces)) {
      const ifaceList = interfaces[name];
      if (!ifaceList) continue;

      for (const iface of ifaceList) {
        if (iface.family === 'IPv4' && !iface.internal) {
          serverIP = iface.address;
          break;
        }
      }

      if (serverIP !== 'localhost') break;
    }

    const banner = `
╔════════════════════════════════════════════════════════════════════════════╗
║                                                                            ║
║               🚀 PROXMOX BACKEND API - RUNNING                             ║
║                                                                            ║
╠════════════════════════════════════════════════════════════════════════════╣
║                                                                            ║
║ 📍 SERVER INFORMATION                                                      ║
║   Environment:      ${nodeEnv.padEnd(54)} ║
║   Server IP:        ${serverIP.padEnd(54)} ║
║   Port:             ${proxmoxConfig.port.toString().padEnd(54)} ║
║                                                                            ║
║ 🌐 ENDPOINTS                                                               ║
║   HTTP API:         http://${serverIP}:${proxmoxConfig.port}${' '.repeat(Math.max(0, 42 - serverIP.length - proxmoxConfig.port.toString().length))} ║
║   WebSocket:        ws://${serverIP}:${proxmoxConfig.port}/ws${' '.repeat(Math.max(0, 45 - serverIP.length - proxmoxConfig.port.toString().length))} ║
║   Health Check:     http://${serverIP}:${proxmoxConfig.port}/api/health${' '.repeat(Math.max(0, 29 - serverIP.length - proxmoxConfig.port.toString().length))} ║
║                                                                            ║
║ 📊 AVAILABLE ROUTES                                                        ║
║   GET    /api/health              - Health check                          ║
║   GET    /api/monitoring          - Server monitoring                     ║
║   GET    /api/users               - List users                            ║
║   POST   /api/users/login         - User login                            ║
║   GET    /api/messages            - List messages                         ║
║   WS     /ws                      - WebSocket connection                  ║
║   GET    /api/agenda/events       - List events                           ║
║   POST   /api/agenda/events       - Create event                          ║
║   GET    /api/lots                - List reception lots                   ║
║   POST   /api/lots                - Create lot                            ║
║   POST   /api/lots/:id/items      - Add item to lot                       ║
║   DELETE /api/lots/items/:id      - Soft-delete lot item                  ║
║   POST   /api/lots/items/:id/restore - Restore soft-deleted item          ║
║   DELETE /api/lots/:id            - Cancel / soft-delete lot              ║
║                                                                            ║
║ 💻 MANAGEMENT COMMANDS (on host)                                          ║
║   proxmox status                  - Show service status                   ║
║   proxmox logs                    - View live logs                        ║
║   proxmox stop                    - Stop backend services                 ║
║   proxmox restart                 - Restart backend                       ║
║   proxmox rebuild                 - Update and rebuild                    ║
║                                                                            ║
║ 🔗 DOCUMENTATION                                                           ║
║   Docs:              See proxmox/docs/ for detailed API docs              ║
║   WebSocket:         See docs/WEBSOCKET.md                                ║
║   Database:          See docs/DATABASE.md                                 ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝
    `;
    console.log(banner);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
})();

export default fastify;
