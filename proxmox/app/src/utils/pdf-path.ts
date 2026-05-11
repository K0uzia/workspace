import * as fs from 'fs';
import * as path from 'path';

/** Racine montée côté serveur (CT Docker) pour les PDFs équipe — doit correspondre aux chemins en base. */
export const TEAM_BASE_PATH = process.env.TEAM_BASE_PATH || '/mnt/team/#TEAM';

export function normalizeStoredPdfPath(rawPath: string): string {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return decodeURIComponent(url.pathname || '');
    } catch {
      return decodeURIComponent(trimmed.replace(/^file:\/\//i, ''));
    }
  }
  const normalizedSlashes = trimmed.replace(/\\/g, '/');
  return path.isAbsolute(normalizedSlashes) ? path.resolve(normalizedSlashes) : path.resolve(TEAM_BASE_PATH, normalizedSlashes);
}

/**
 * Résout un chemin PDF enregistré en base vers un fichier réellement lisible sur ce serveur
 * (GET /api/lots/:id/pdf, commandes, dons, open-path monitoring, etc.).
 */
export function resolvePdfFilePath(rawPath: string): string | null {
  const first = normalizeStoredPdfPath(rawPath);
  if (!first) return null;
  const candidates = new Set<string>([first]);
  const teamBase = path.resolve(TEAM_BASE_PATH);
  const teamParent = path.dirname(teamBase);
  if (first.startsWith('/mnt/team/#TEAM/')) candidates.add(path.resolve(teamBase, first.slice('/mnt/team/#TEAM/'.length)));
  if (first.startsWith('/mnt/team/')) candidates.add(path.resolve(teamParent, first.slice('/mnt/team/'.length)));
  const basename = path.basename(first);
  if (basename) {
    candidates.add(path.resolve(teamBase, basename));
    candidates.add(path.resolve(teamParent, basename));
  }
  const extra = new Set<string>();
  for (const c of candidates) {
    if (c.includes('TRAÇABILITÉ')) extra.add(c.replace(/TRAÇABILITÉ/g, 'TRACABILITE'));
    if (c.includes('TRACABILITÉ')) extra.add(c.replace(/TRACABILITÉ/g, 'TRACABILITE'));
  }
  for (const e of extra) candidates.add(e);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
