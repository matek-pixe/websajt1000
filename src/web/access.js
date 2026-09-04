'use strict';

const path = require('node:path');

/** True if the member holds ANY of the required roles. No required roles configured = nobody gets in. */
function hasRequiredRole(memberRoleIds, requiredRoleIds) {
  if (!Array.isArray(requiredRoleIds) || requiredRoleIds.length === 0) return false;
  const have = new Set(Array.isArray(memberRoleIds) ? memberRoleIds : []);
  return requiredRoleIds.some((id) => have.has(id));
}

/**
 * Map a URL path onto a file inside rootDir, refusing anything that escapes it (../ tricks, encoded
 * slashes, absolute paths). "/" and "/dir/" resolve to index.html. Returns an absolute path or null.
 */
function safeResolve(rootDir, urlPath) {
  let p;
  try {
    p = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  if (p === '' || p.endsWith('/')) p += 'index.html';
  const normalized = path.posix.normalize('/' + p.replace(/\\/g, '/'));
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, '.' + normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function contentType(filePath) {
  return TYPES[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { hasRequiredRole, safeResolve, contentType, escapeHtml };
