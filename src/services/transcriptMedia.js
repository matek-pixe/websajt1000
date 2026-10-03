'use strict';

const { emojiUrl } = require('./transcriptHtml');

/**
 * Downloads what a conversation contains so the transcript keeps working after the ticket channel is
 * gone and Discord's own links have expired.
 *
 *   small pictures (avatars, emoji, embed pictures)  go inside the page
 *   attached pictures                                go inside the page; a big one as a reduced preview
 *                                                    (Discord's media proxy resizes it), it enlarges on click
 *   attached files                                   small ones go inside the page
 *   everything that did not fit                      is uploaded next to the page when there is a place
 *                                                    online, so its Download button still works later
 *
 * Only Discord's own hosts are contacted, every file has a size cap and the page has a total budget.
 */

const HOST_OK = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discord\.media)$/i;
const TYPE_OK = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const EMOJI_TAG = /<(a?):\w{2,32}:(\d{15,25})>/g;
const MB = 1024 * 1024;

const isImage = (att) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.contentType || '') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.name || '');

function allowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOST_OK.test(u.hostname);
  } catch {
    return false;
  }
}

/** Address of a reduced copy of an attached picture, made by Discord's media proxy (longest side `max`). */
function previewUrl(att, max = 1600) {
  let u;
  try {
    u = new URL(att.proxyUrl || att.url);
  } catch {
    return null;
  }
  if (u.hostname === 'cdn.discordapp.com') u.hostname = 'media.discordapp.net';
  const w = Number(att.width) || 0;
  const h = Number(att.height) || 0;
  if (w && h) {
    const k = Math.min(1, max / Math.max(w, h));
    u.searchParams.set('width', String(Math.max(1, Math.round(w * k))));
    u.searchParams.set('height', String(Math.max(1, Math.round(h * k))));
  } else {
    u.searchParams.set('width', String(max));
  }
  u.searchParams.set('format', 'webp');
  if (/\.gif$/i.test(att.name || '') || /gif/i.test(att.contentType || '')) u.searchParams.set('animated', 'true');
  return u.toString();
}

/** Every attachment of the conversation (also inside forwarded messages), once per address. */
function listAttachments(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    for (const att of [...(m.attachments || []), ...((m.forwarded && m.forwarded.attachments) || [])]) {
      if (att && att.url && !seen.has(att.url)) {
        seen.add(att.url);
        out.push(att);
      }
    }
  }
  return out;
}

/** Every small picture the page shows, the always present ones first. Attachments are handled separately. */
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

async function download(url, { fetchImpl, maxBytes, timeoutMs, images = true }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { 'user-agent': '35xw-transcripts' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (images && !TYPE_OK.test(type)) throw new Error(`not an image (${type || 'unknown'})`);
    if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('too large');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('too large');
      chunks.push(chunk);
    }
    return { type: type || 'application/octet-stream', buffer: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Run `fn` over `items` with a few at a time. */
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const encodedSize = (bytes, type = '') => Math.ceil(bytes / 3) * 4 + type.length + 13;

/**
 * @param {object} data { guildIcon, messages }
 * @param {object} [opts] limits, plus `session` (TranscriptHost#session) to keep originals online
 * @returns {Promise<{ media: Map<string,string>, files: Map<string,object>, stats: object }>}
 *   media  address -> data: URI of every picture that is shown inside the page
 *   files  attachment address -> { shown, reduced, original: 'page' | 'online' | null, data, type, onlineUrl }
 */
async function inlineMedia(
  { guildIcon, messages },
  {
    fetchImpl = globalThis.fetch,
    maxFileBytes = 4 * MB, // largest picture taken over as it is
    budgetBytes = 7 * MB, // everything inside the page together
    embedImageMax = 1.5 * MB, // above this an attached picture is reduced first
    embedFileMax = 1 * MB, // largest attached file placed inside the page
    previewMax = 1600,
    hostFileMax = 25 * MB,
    hostBudget = 100 * MB,
    hostDeadlineMs = 90_000,
    concurrency = 6,
    timeoutMs = 8000,
    deadlineMs = 40_000,
    session = null,
  } = {},
) {
  const media = new Map();
  const files = new Map();
  const stats = { embedded: 0, skipped: 0, bytes: 0, reduced: 0, hosted: 0 };
  const started = Date.now();
  const late = () => Date.now() - started > deadlineMs;
  const fits = (n) => stats.bytes + n <= budgetBytes;

  // 1. small pictures
  await pool(collectUrls({ guildIcon, messages }).filter(allowed), concurrency, async (url) => {
    if (late() || stats.bytes >= budgetBytes) return void (stats.skipped += 1);
    try {
      const { type, buffer } = await download(url, { fetchImpl, maxBytes: maxFileBytes, timeoutMs });
      const size = encodedSize(buffer.length, type);
      if (!fits(size)) return void (stats.skipped += 1);
      stats.bytes += size;
      stats.embedded += 1;
      media.set(url, `data:${type};base64,${buffer.toString('base64')}`);
    } catch {
      stats.skipped += 1;
    }
  });

  // 2. attachments: pictures first, then files
  const attachments = listAttachments(messages).filter((a) => allowed(a.url));
  const ordered = [...attachments.filter(isImage), ...attachments.filter((a) => !isImage(a))];
  await pool(ordered, concurrency, async (att) => {
    const info = { shown: false, reduced: false, original: null, data: null, type: null, onlineUrl: null };
    files.set(att.url, info);
    if (late()) return void (stats.skipped += 1);
    try {
      if (isImage(att)) {
        const big = (Number(att.size) || 0) > embedImageMax;
        let got = null;
        if (big) {
          const preview = previewUrl(att, previewMax);
          if (preview && allowed(preview)) {
            got = await download(preview, { fetchImpl, maxBytes: maxFileBytes, timeoutMs }).catch(() => null);
            if (got) info.reduced = true;
          }
        }
        if (!got && (!big || (Number(att.size) || 0) <= maxFileBytes)) {
          got = await download(att.url, { fetchImpl, maxBytes: maxFileBytes, timeoutMs }).catch(() => null);
        }
        if (got && fits(encodedSize(got.buffer.length, got.type))) {
          stats.bytes += encodedSize(got.buffer.length, got.type);
          stats.embedded += 1;
          if (info.reduced) stats.reduced += 1;
          media.set(att.url, `data:${got.type};base64,${got.buffer.toString('base64')}`);
          info.shown = true;
          if (!info.reduced) info.original = 'page';
        } else {
          info.reduced = false;
        }
      } else if ((Number(att.size) || 0) <= embedFileMax) {
        const got = await download(att.url, { fetchImpl, maxBytes: embedFileMax, timeoutMs, images: false });
        const size = Math.ceil(got.buffer.length / 3) * 4;
        if (fits(size)) {
          stats.bytes += size;
          stats.embedded += 1;
          info.data = got.buffer.toString('base64');
          info.type = att.contentType || got.type;
          info.original = 'page';
        }
      }
    } catch {
      stats.skipped += 1;
    }
  });

  // 3. what is not in the page as the original is kept next to it, when there is a place for that
  if (session) {
    let used = 0;
    const hostStarted = Date.now();
    const pending = ordered.filter((a) => files.get(a.url) && !files.get(a.url).original);
    await pool(pending, 3, async (att) => {
      const info = files.get(att.url);
      if (Date.now() - hostStarted > hostDeadlineMs) return;
      const want = Number(att.size) || 0;
      if (used + want > hostBudget) return;
      used += want; // reserved before the download, files are fetched a few at a time
      try {
        const { buffer } = await download(att.url, { fetchImpl, maxBytes: hostFileMax, timeoutMs: 30_000, images: false });
        info.onlineUrl = await session.putFile(att.name, buffer);
        info.original = 'online';
        stats.hosted += 1;
      } catch {
        used -= want;
        stats.skipped += 1;
      }
    });
  }
  return { media, files, stats };
}

module.exports = { inlineMedia, collectUrls, listAttachments, previewUrl, allowed, isImage };
