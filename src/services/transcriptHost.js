'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Puts a finished transcript online and returns its address, one unguessable address per ticket:
 *   <public url>/t/<32 random characters>/index.html
 * The original files of that ticket (big pictures, documents) sit next to it, so a download works long
 * after Discord's own links expired:  <public url>/t/<token>/files/<n>-<name>
 *
 * Two places can hold the page, the first one that is configured wins:
 *   1. a bucket on Cloudflare R2 (or any S3 compatible storage), uploaded with a signed request;
 *   2. the bot's own website (WEB_ENABLED), which serves data/transcripts/<token>/index.html.
 * With neither, no link is made and the transcript stays an attached file.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TOKEN_RE = /^[A-Za-z0-9]{32}$/;

function newToken(length = 32) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** A file name that is safe in an address and in a header. */
function safeName(name) {
  return (
    String(name || 'file')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+/, '')
      .slice(-80) || 'file'
  );
}

// ---------- AWS signature version 4 ----------

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodeSegment = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Sign one request. `uri` is the already encoded path, `headers` the extra headers to sign.
 * Returns the full header set to send (including host, which fetch fills in itself).
 */
function signRequest({ method, host, uri, query = '', headers = {}, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const all = {};
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = v;
  all.host = host;
  all['x-amz-content-sha256'] = payloadHash;
  all['x-amz-date'] = amzDate;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(all[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, uri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: all, signature };
}

class TranscriptHost {
  /**
   * @param {object} opts config.transcripts: { s3: { endpoint, bucket, accessKeyId, secretAccessKey, region, publicUrl }, local: { dir, publicUrl } }
   * @param {object} [deps] { fetch } for tests
   */
  constructor(opts = {}, deps = {}) {
    const s3 = opts.s3 || {};
    this.s3 = s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey && s3.publicUrl ? s3 : null;
    const local = opts.local || {};
    this.local = !this.s3 && local.dir && local.publicUrl ? local : null;
    this.fetch = deps.fetch || globalThis.fetch;
  }

  enabled() {
    return !!(this.s3 || this.local);
  }

  describe() {
    if (this.s3) return `bucket ${this.s3.bucket} (${this.s3.publicUrl})`;
    if (this.local) return `own website (${this.local.publicUrl})`;
    return 'off, transcripts stay attached files';
  }

  /** One signed upload to the bucket. */
  async _put(key, body, { type = 'text/html; charset=utf-8', disposition = null } = {}) {
    const { endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' } = this.s3;
    const base = new URL(endpoint);
    const uri = `/${[bucket, ...key.split('/')].map(encodeSegment).join('/')}`;
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const headers = { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' };
    if (disposition) headers['content-disposition'] = disposition;
    const signed = signRequest({ method: 'PUT', host: base.host, uri, headers, payloadHash: sha256(payload), accessKeyId, secretAccessKey, region });
    const { host, ...send } = signed.headers; // fetch sets the host itself
    const res = await this.fetch(`${base.origin}${uri}`, { method: 'PUT', headers: send, body: payload, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
      throw new Error(`upload failed (HTTP ${res.status}${code ? ` ${code}` : ''})`);
    }
  }

  async _store(key, body, opts) {
    if (this.s3) return this._put(key, body, opts);
    const file = path.join(this.local.dir, ...key.replace(/^t\//, '').split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
    return undefined;
  }

  /**
   * One ticket's place online. Its address is known before anything is uploaded, so the page can link
   * to its own files. Returns null when no place is configured.
   *   pageUrl            address of the page
   *   putFile(name, buf) stores an original file, returns its download address
   *   putPage(html)      stores the page last
   */
  session() {
    if (!this.enabled()) return null;
    const token = newToken();
    const root = (this.s3 ? this.s3.publicUrl : this.local.publicUrl).replace(/\/+$/, '');
    const base = `${root}/t/${token}`;
    const host = this;
    let n = 0;
    return {
      token,
      pageUrl: `${base}/index.html`,
      async putFile(name, buffer) {
        n += 1;
        const stored = `${n}-${safeName(name)}`;
        const ascii = safeName(name);
        const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeSegment(String(name || ascii))}`;
        // Served as opaque bytes that download: an uploaded .html or .svg can never run on this address.
        await host._store(`t/${token}/files/${stored}`, buffer, { type: 'application/octet-stream', disposition });
        return `${base}/files/${stored}`;
      },
      async putPage(html) {
        await host._store(`t/${token}/index.html`, html, { type: 'text/html; charset=utf-8' });
        return `${base}/index.html`;
      },
    };
  }

  /** Store a finished page on its own and return { token, url }, or null when no place is configured. */
  async publish(html) {
    const session = this.session();
    if (!session) return null;
    await session.putPage(html);
    return { token: session.token, url: session.pageUrl };
  }
}

module.exports = { TranscriptHost, newToken, signRequest, safeName, TOKEN_RE };
