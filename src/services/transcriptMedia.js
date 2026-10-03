'use strict';

const { emojiUrl } = require('./transcriptHtml');

/**
 * Downloads the images of a conversation so the transcript can carry them inside the page.
 * Discord's picture links stop working after a while (and the ticket channel is deleted), so a
 * transcript that only links to them goes blank. Only Discord's own hosts are contacted, every file
 * has a size cap, and the whole page has a total budget: whatever does not fit stays a plain link.
 */

const HOST_OK = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discord\.media)$/i;
const TYPE_OK = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const EMOJI_TAG = /<(a?):\w{2,32}:(\d{15,25})>/g;

const isImage = (att) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.contentType || '') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.name || '');

function allowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOST_OK.test(u.hostname);
  } catch {
    return false;
  }
}

/** Every image address the page can show, the small and always present ones first. */
function collectUrls({ guildIcon, messages }) {
  const seen = new Set();
  const out = [];
  const add = (url) => {
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };
  const emojiIn = (text) => {
    for (const m of String(text || '').matchAll(EMOJI_TAG)) add(emojiUrl(m[2], !!m[1]));
  };

  add(guildIcon);
  for (const m of messages) add(m.author && m.author.avatar);
  for (const m of messages) {
    emojiIn(m.content);
    for (const e of m.embeds || []) {
      emojiIn(e.description);
      for (const f of e.fields || []) emojiIn(f.value);
    }
    for (const r of m.reactions || []) if (r.url) add(r.url);
  }
  const files = (m) => [...(m.attachments || []), ...((m.forwarded && m.forwarded.attachments) || [])];
  for (const m of messages) for (const att of files(m)) if (isImage(att)) add(att.url);
  for (const m of messages) {
    for (const s of m.stickers || []) add(s.url);
    for (const e of [...(m.embeds || []), ...((m.forwarded && m.forwarded.embeds) || [])]) {
      add(e.image);
      add(e.thumbnail);
      add(e.author && e.author.iconUrl);
      add(e.footer && e.footer.iconUrl);
    }
  }
  return out;
}

async function download(url, { fetchImpl, maxBytes, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { 'user-agent': '35xw-transcripts' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPE_OK.test(type)) throw new Error(`not an image (${type || 'unknown'})`);
    if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('too large');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('too large');
      chunks.push(chunk);
    }
    return { type, buffer: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * @returns {Promise<{ media: Map<string,string>, stats: { embedded: number, skipped: number, bytes: number } }>}
 */
async function inlineMedia(
  { guildIcon, messages },
  { fetchImpl = globalThis.fetch, maxFileBytes = 4 * 1024 * 1024, budgetBytes = 7 * 1024 * 1024, concurrency = 6, timeoutMs = 8000, deadlineMs = 40_000 } = {},
) {
  const urls = collectUrls({ guildIcon, messages }).filter(allowed);
  const media = new Map();
  const stats = { embedded: 0, skipped: 0, bytes: 0 };
  const started = Date.now();
  let next = 0;

  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      if (Date.now() - started > deadlineMs || stats.bytes >= budgetBytes) {
        stats.skipped += 1;
        continue;
      }
      try {
        const { type, buffer } = await download(url, { fetchImpl, maxBytes: maxFileBytes, timeoutMs });
        const encoded = Math.ceil(buffer.length / 3) * 4 + type.length + 13;
        if (stats.bytes + encoded > budgetBytes) {
          stats.skipped += 1;
          continue;
        }
        stats.bytes += encoded;
        stats.embedded += 1;
        media.set(url, `data:${type};base64,${buffer.toString('base64')}`);
      } catch {
        stats.skipped += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return { media, stats };
}

module.exports = { inlineMedia, collectUrls, allowed };
