'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Puts a finished transcript online and returns its address, one unguessable address per ticket:
 *   <public url>/t/<32 random characters>/index.html
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

  async _put(key, body) {
    const { endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' } = this.s3;
    const base = new URL(endpoint);
    const uri = `/${[bucket, ...key.split('/')].map(encodeSegment).join('/')}`;
    const payload = Buffer.from(body, 'utf8');
    const signed = signRequest({
      method: 'PUT',
      host: base.host,
      uri,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' },
      payloadHash: sha256(payload),
      accessKeyId,
      secretAccessKey,
      region,
    });
    const { host, ...send } = signed.headers; // fetch sets the host itself
    const res = await this.fetch(`${base.origin}${uri}`, { method: 'PUT', headers: send, body: payload, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
      throw new Error(`upload failed (HTTP ${res.status}${code ? ` ${code}` : ''})`);
    }
  }

  /** Store the page and return { token, url }, or null when no place is configured. */
  async publish(html) {
    if (!this.enabled()) return null;
    const token = newToken();
    const key = `t/${token}/index.html`;
    if (this.s3) {
      await this._put(key, html);
      return { token, url: `${this.s3.publicUrl.replace(/\/+$/, '')}/${key}` };
    }
    const dir = path.join(this.local.dir, token);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(`${file}.tmp`, html, 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    return { token, url: `${this.local.publicUrl.replace(/\/+$/, '')}/${key}` };
  }
}

module.exports = { TranscriptHost, newToken, signRequest, TOKEN_RE };
