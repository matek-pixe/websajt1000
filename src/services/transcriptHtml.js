'use strict';

const crypto = require('node:crypto');

/**
 * Renders a ticket conversation as ONE self-contained, Discord-looking HTML page.
 * Pure: takes plain data, returns a string. Every piece of user text is escaped, and the page
 * carries a Content-Security-Policy that blocks everything except its own inline script and the
 * images that were embedded as data: URIs, so it opens the same online and from a saved file.
 *
 * message shape: { id, createdTimestamp, author: { id, name, tag, bot, avatar, color },
 *   content, mentions: { [userId]: username }, roleMentions: { [id]: { name, color } },
 *   channelMentions: { [id]: name }, attachments: [{ name, url, contentType, size }],
 *   embeds: [{ title, description, url, color, author, fields, footer, thumbnail, image }],
 *   components: [[{ label, style, emoji, url }]], stickers: [{ name, url }], reactions, replyTo,
 *   forwarded, edited }
 * media: Map of image url -> data: URI for every image that could be embedded.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

const isoOf = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};

/** "2h 5m", "5m 3s", "40s" */
function formatSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const HEX = /^#[0-9a-f]{6}$/i;
const safeColor = (c) => (typeof c === 'string' && HEX.test(c) ? c : typeof c === 'number' && c > 0 ? `#${c.toString(16).padStart(6, '0')}` : null);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);

/** A time that the page rewrites into the viewer's own time zone. */
const tsSpan = (ts, style = 'f', cls = 'ts') => `<span class="${cls}" data-ts="${esc(isoOf(ts))}" data-style="${esc(style)}">${esc(fmtTime(ts))}</span>`;

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
};

// ---------- message text ----------

/**
 * Escape, then apply the Discord markup people actually use: code, bold, italic, underline,
 * strike, spoilers, quotes, headings, lists, links, mentions, custom emoji and timestamps.
 * ctx: { roles, channels, emoji(id, animated, name) => html, jumbo }
 */
function renderContent(text, mentions = {}, ctx = {}) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = String(text ?? '').replace(/\u0000/g, '');

  s = s.replace(/```(?:[a-z0-9+#.-]*\n)?([\s\S]*?)```/gi, (m, code) => keep(`<pre class="codeblock"><code>${esc(code.replace(/^\n|\n$/g, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code>${esc(code)}</code>`));
  s = esc(s);

  // links first, so nothing below can reach into an address
  s = s.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;)[^\s\u0000])+/g, (url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));

  s = s.replace(/&lt;@!?(\d+)&gt;/g, (m, id) => `<span class="mention">@${esc(mentions[id] || id)}</span>`);
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (m, id) => {
    const r = (ctx.roles || {})[id];
    const c = r && safeColor(r.color);
    return `<span class="mention"${c ? ` style="color:${c};background:${c}22"` : ''}>@${esc(r ? r.name : 'role')}</span>`;
  });
  s = s.replace(/&lt;#(\d+)&gt;/g, (m, id) => `<span class="mention">#${esc((ctx.channels || {})[id] || 'channel')}</span>`);
  s = s.replace(/@(everyone|here)\b/g, '<span class="mention">@$1</span>');
  s = s.replace(/&lt;(a?):([\w]{2,32}):(\d{15,25})&gt;/g, (m, anim, name, id) => (ctx.emoji ? ctx.emoji(id, !!anim, name, !!ctx.jumbo) : `:${name}:`));
  s = s.replace(/&lt;t:(\d{1,12})(?::([tTdDfFR]))?&gt;/g, (m, secs, style) => tsSpan(Number(secs) * 1000, style || 'f', 'ts-inline'));

  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');

  // block level markup, line by line
  const parts = s.split('\n').map((line) => {
    let m;
    if ((m = /^(#{1,3}) (.+)$/.exec(line))) return { block: true, html: `<div class="h${m[1].length}">${m[2]}</div>` };
    if ((m = /^-# (.+)$/.exec(line))) return { block: true, html: `<div class="subtext">${m[1]}</div>` };
    if ((m = /^&gt; ?(.*)$/.exec(line))) return { block: true, html: `<div class="quote">${m[1]}</div>` };
    if ((m = /^[-*] (.+)$/.exec(line))) return { block: true, html: `<div class="li">• ${m[1]}</div>` };
    return { block: false, html: line };
  });
  let out = '';
  parts.forEach((p, i) => {
    if (i > 0 && !p.block && !parts[i - 1].block) out += '<br>';
    out += p.html;
  });

  for (let i = 0; i < 4 && out.includes('\u0000'); i++) out = out.replace(/\u0000(\d+)\u0000/g, (m, n) => stash[Number(n)] ?? '');
  return out;
}

// ---------- pieces ----------

const isImage = (att) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.contentType || '') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.name || '');

/** Where a custom emoji image lives. The media step downloads exactly this address. */
const emojiUrl = (id, animated) => `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=64`;

function makeCtx(message, media) {
  const emoji = (id, animated, name, jumbo) => {
    const src = media.get(emojiUrl(id, animated));
    return src ? `<img class="emoji${jumbo ? ' jumbo' : ''}" src="${esc(src)}" alt=":${esc(name)}:" title=":${esc(name)}:">` : `:${esc(name)}:`;
  };
  return { roles: message.roleMentions || {}, channels: message.channelMentions || {}, emoji };
}

function onlyEmoji(text) {
  return !!text && /^(\s*<a?:\w{2,32}:\d{15,25}>\s*){1,27}$/.test(text);
}

/** The Download link of an attachment: from the page itself, from the online copy, or Discord's own link. */
function downloadLink(att, info, kind) {
  const name = esc(att.name || 'file');
  const label = info && info.reduced ? 'Download original' : 'Download';
  if (info && info.original === 'page') {
    return kind === 'image'
      ? `<a class="dl" href="#" data-from="img" data-name="${name}">${label}</a>`
      : `<a class="dl" href="#" data-name="${name}" data-type="${esc(info.type || 'application/octet-stream')}" data-b64="${esc(info.data)}">${label}</a>`;
  }
  if (info && info.original === 'online' && safeUrl(info.onlineUrl)) {
    return `<a class="dl" href="${esc(info.onlineUrl)}" rel="noopener noreferrer">${label}</a>`;
  }
  const link = safeUrl(att.url);
  return link ? `<a class="dl" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Discord's own link, it can stop working">Open original</a>` : '';
}

function renderAttachments(list, media, files = new Map()) {
  return (list || [])
    .map((att) => {
      const info = files.get(att.url) || null;
      const name = esc(att.name || 'attachment');
      const size = att.size ? `<span class="media-size">${esc(fmtBytes(att.size))}</span>` : '';
      const data = isImage(att) ? media.get(att.url) : null;
      if (data) {
        const note = info && info.reduced ? '<span class="media-size">reduced preview, click to enlarge</span>' : '';
        return `<div class="media"><img src="${esc(data)}" alt="${name}"><div class="media-bar"><span class="media-name">${name}</span>${size}${note}${downloadLink(att, info, 'image')}</div></div>`;
      }
      const note = isImage(att) ? 'Preview not available' : fmtBytes(att.size);
      return `<div class="file"><span class="file-icon">${isImage(att) ? '🖼️' : '📎'}</span><div><div class="file-name">${name}</div><div class="file-size">${esc(note)}</div></div>${downloadLink(att, info, 'file')}</div>`;
    })
    .join('');
}

function renderEmbeds(list, media, message) {
  const ctx = makeCtx(message || {}, media);
  const pic = (u) => (u ? media.get(u) || null : null);
  return (list || [])
    .map((e) => {
      const color = safeColor(e.color) || '#202225';
      const author = e.author && e.author.name ? `<div class="embed-author">${pic(e.author.iconUrl) ? `<img class="embed-author-icon" src="${esc(pic(e.author.iconUrl))}" alt="">` : ''}${esc(e.author.name)}</div>` : '';
      const titleText = esc(e.title || '');
      const titleLink = safeUrl(e.url);
      const title = e.title ? `<div class="embed-title">${titleLink ? `<a href="${esc(titleLink)}" target="_blank" rel="noopener noreferrer">${titleText}</a>` : titleText}</div>` : '';
      const desc = e.description ? `<div class="embed-desc">${renderContent(e.description, message && message.mentions, ctx)}</div>` : '';
      const fields = (e.fields || []).length
        ? `<div class="embed-fields">${e.fields
            .map((f) => `<div class="embed-field${f.inline ? ' inline' : ''}"><div class="embed-field-name">${renderContent(f.name, {}, ctx)}</div><div class="embed-field-value">${renderContent(f.value, message && message.mentions, ctx)}</div></div>`)
            .join('')}</div>`
        : '';
      const image = pic(e.image) ? `<div class="embed-image"><img src="${esc(pic(e.image))}" alt=""></div>` : '';
      const footerText = [e.footer && e.footer.text, e.timestamp ? tsSpan(e.timestamp, 'f') : ''].filter(Boolean);
      const footer = footerText.length
        ? `<div class="embed-footer">${pic(e.footer && e.footer.iconUrl) ? `<img class="embed-footer-icon" src="${esc(pic(e.footer.iconUrl))}" alt="">` : ''}${footerText.map((t, i) => (i === 0 && e.footer && e.footer.text ? esc(t) : t)).join(' • ')}</div>`
        : '';
      const thumb = pic(e.thumbnail) ? `<img class="embed-thumb" src="${esc(pic(e.thumbnail))}" alt="">` : '';
      return `<div class="embed" style="border-left-color:${color}"><div class="embed-body">${author}${title}${desc}${fields}${image}${footer}</div>${thumb}</div>`;
    })
    .join('');
}

function renderButtons(rows) {
  const html = (rows || [])
    .map((row) => {
      const buttons = (row || [])
        .map((b) => {
          const cls = b.url ? 'btn-link' : { 1: 'btn-primary', 2: 'btn-secondary', 3: 'btn-success', 4: 'btn-danger' }[b.style] || 'btn-secondary';
          const label = `${b.emoji ? `${esc(b.emoji)} ` : ''}${esc(b.label || '')}`.trim();
          if (!label) return '';
          const link = safeUrl(b.url);
          return link ? `<a class="btn ${cls}" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : `<span class="btn ${cls}">${label}</span>`;
        })
        .join('');
      return buttons ? `<div class="action-row">${buttons}</div>` : '';
    })
    .join('');
  return html;
}

function renderReactions(list, media) {
  if (!list || !list.length) return '';
  const items = list
    .map((r) => {
      const src = r.url ? media.get(r.url) : null;
      const face = src ? `<img class="emoji" src="${esc(src)}" alt="${esc(r.name)}">` : esc(r.name);
      return `<span class="reaction">${face}<span>${Number(r.count) || 0}</span></span>`;
    })
    .join('');
  return `<div class="reactions">${items}</div>`;
}

function renderStickers(list, media) {
  return (list || [])
    .map((s) => {
      const src = s.url ? media.get(s.url) : null;
      return src ? `<img class="sticker" src="${esc(src)}" alt="${esc(s.name)}">` : `<div class="sticker-name">Sticker: ${esc(s.name)}</div>`;
    })
    .join('');
}

/** "Replying to name: snippet", resolved against the other messages of the transcript. */
function renderReply(m, byId, media) {
  if (!m.replyTo) return '';
  const target = byId && byId.get(m.replyTo);
  if (!target) return '<div class="reply"><span class="reply-deleted">Replying to a message that is not in this transcript</span></div>';
  const raw =
    target.content ||
    (target.forwarded && target.forwarded.content) ||
    (target.attachments && target.attachments.length ? 'Attachment' : '') ||
    (target.embeds && target.embeds.length ? 'Embed' : '') ||
    '…';
  const snippet = raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
  const ta = target.author || {};
  const av = ta.avatar && media.get(ta.avatar);
  return `<div class="reply">${av ? `<img class="reply-avatar" src="${esc(av)}" alt="">` : ''}<span class="reply-name">${esc(ta.name || 'unknown')}</span><span class="reply-text">${esc(snippet.replace(/\s+/g, ' '))}</span></div>`;
}

/** A forwarded message is shown as a quoted block with its own content, files and embeds. */
function renderForward(f, media, message, files) {
  if (!f) return '';
  const ctx = makeCtx(message || {}, media);
  const content = f.content ? `<div class="content">${renderContent(f.content, {}, ctx)}</div>` : '';
  return `<div class="forward"><div class="forward-label">↪ Forwarded${f.createdTimestamp ? ` · ${tsSpan(f.createdTimestamp, 'f')}` : ''}</div>${content}${renderAttachments(f.attachments, media, files)}${renderEmbeds(f.embeds, media, message)}</div>`;
}

const GROUP_MS = 7 * 60 * 1000;

function renderMessage(m, prev, byId, media, files) {
  const a = m.author || {};
  const grouped = !!prev && !m.replyTo && prev.author && a.id && prev.author.id === a.id && m.createdTimestamp - prev.createdTimestamp < GROUP_MS;
  const ctx = { ...makeCtx(m, media), jumbo: onlyEmoji(m.content) };
  const content = m.content ? `<div class="content">${renderContent(m.content, m.mentions, ctx)}${m.edited ? ' <span class="edited">(edited)</span>' : ''}</div>` : '';
  const rest =
    `${content}${renderForward(m.forwarded, media, m, files)}${renderAttachments(m.attachments, media, files)}${renderStickers(m.stickers, media)}` +
    `${renderEmbeds(m.embeds, media, m)}${renderButtons(m.components)}${renderReactions(m.reactions, media)}`;
  const id = `m${esc(String(m.id || '').replace(/\D/g, ''))}`;

  if (grouped) {
    return `<div class="msg grouped" id="${id}"><div class="gutter">${tsSpan(m.createdTimestamp, 't', 'hover-ts')}</div><div class="body">${rest}</div></div>`;
  }
  const av = a.avatar && media.get(a.avatar);
  const avatar = av ? `<img class="avatar" src="${esc(av)}" alt="">` : `<div class="avatar placeholder">${esc((a.name || '?').slice(0, 1).toUpperCase())}</div>`;
  const color = safeColor(a.color);
  const bot = a.bot ? '<span class="bot-tag">APP</span>' : '';
  return (
    `<div class="msg" id="${id}">${renderReply(m, byId, media)}<div class="row"><div class="gutter">${avatar}</div><div class="body">` +
    `<div class="author"><span class="name"${color ? ` style="color:${color}"` : ''} title="${esc(a.tag || a.name || '')}">${esc(a.name || 'unknown')}</span>${bot}${tsSpan(m.createdTimestamp, 'f')}</div>` +
    `${rest}</div></div></div>`
  );
}

const CSS = `
:root{--bg:#313338;--bg2:#2b2d31;--bg3:#1e1f22;--text:#dbdee1;--muted:#949ba4;--link:#00a8fc;--mention:#5865f233;--mention-t:#c9cdfb;--hover:#2e3035;--border:#3f4147;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.375 "gg sans","Noto Sans","Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.top{display:flex;gap:12px;align-items:center;padding:16px;background:var(--bg2);border-bottom:1px solid var(--bg3);position:sticky;top:0;z-index:5}
.guild-icon{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none}
.guild-icon.placeholder{display:flex;align-items:center;justify-content:center;background:#5865f2;color:#fff;font-weight:700;font-size:20px}
.guild-name{font-weight:700;font-size:18px;color:#f2f3f5}.channel-name{color:var(--muted)}
.cards{display:flex;flex-wrap:wrap;gap:16px;padding:16px;border-bottom:1px solid var(--border)}
.card{background:var(--bg2);border-radius:8px;padding:14px 16px;flex:1 1 320px;max-width:640px}
.card-title{font-weight:700;margin-bottom:10px;color:#f2f3f5}
.info-row{display:flex;gap:10px;padding:3px 0}.info-key{color:var(--muted);min-width:90px}
.muted{color:var(--muted);font-size:13px}
.participants{margin-top:10px;display:flex;flex-wrap:wrap;gap:6px}
.participant{background:var(--bg3);border-radius:12px;padding:2px 10px;font-size:14px}
.messages{padding:8px 0 24px}
.msg{padding:2px 16px 2px 0;position:relative}.msg:hover{background:var(--hover)}
.msg:not(.grouped){margin-top:14px}
.row{display:flex}
.gutter{width:72px;flex:none;display:flex;justify-content:center}
.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;margin-top:2px}
.avatar.placeholder{display:flex;align-items:center;justify-content:center;background:#5865f2;color:#fff;font-weight:700}
.hover-ts{visibility:hidden;color:var(--muted);font-size:11px;margin-top:4px}
.msg.grouped:hover .hover-ts{visibility:visible}
.msg.grouped{display:flex}
.body{min-width:0;flex:1}
.author{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.name{font-weight:600;color:#f2f3f5}
.bot-tag{background:#5865f2;color:#fff;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;vertical-align:middle}
.ts,.ts-inline{color:var(--muted);font-size:12px}.ts-inline{background:#ffffff14;border-radius:3px;padding:0 3px;font-size:inherit;color:inherit}
.edited{color:var(--muted);font-size:10px}
.content{white-space:normal}
.emoji{width:22px;height:22px;vertical-align:-5px;object-fit:contain}.emoji.jumbo{width:48px;height:48px}
.mention{background:var(--mention);color:var(--mention-t);border-radius:3px;padding:0 2px;font-weight:500}
code{background:var(--bg3);border-radius:4px;padding:1px 4px;font-family:Consolas,"Courier New",monospace;font-size:14px}
pre.codeblock{background:var(--bg2);border:1px solid var(--bg3);border-radius:4px;padding:8px;margin:6px 0;overflow-x:auto;max-width:90%}
pre.codeblock code{background:none;padding:0;white-space:pre}
.quote{border-left:4px solid #4e5058;padding-left:10px;margin:2px 0}
.h1{font-size:24px;font-weight:700;margin:6px 0}.h2{font-size:20px;font-weight:700;margin:6px 0}.h3{font-size:16px;font-weight:700;margin:4px 0}
.subtext{color:var(--muted);font-size:12px}.li{padding-left:6px}
.spoiler{background:var(--bg3);color:transparent;border-radius:3px;cursor:pointer;padding:0 2px}.spoiler.revealed{color:inherit;background:#ffffff1a}
.reply{display:flex;align-items:center;gap:4px;margin-left:36px;padding-left:36px;position:relative;color:var(--muted);font-size:14px;margin-bottom:2px}
.reply:before{content:"";position:absolute;left:34px;top:50%;width:30px;height:12px;border-left:2px solid #4e5058;border-top:2px solid #4e5058;border-top-left-radius:6px}
.reply-avatar{width:16px;height:16px;border-radius:50%;margin-left:30px}
.reply-name{font-weight:600;color:#f2f3f5;margin-right:4px}.reply-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70vw}.reply-deleted{margin-left:30px;font-style:italic}
.forward{border-left:4px solid #4e5058;padding:4px 10px;margin:4px 0;border-radius:4px}.forward-label{color:var(--muted);font-size:13px;margin-bottom:2px}
.media{margin:6px 0;max-width:520px}.media img{max-width:100%;max-height:400px;border-radius:8px;display:block;cursor:zoom-in}
.media-bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-top:4px;font-size:13px}
.media-name{color:var(--text);font-weight:500;overflow-wrap:anywhere}.media-size{color:var(--muted);font-size:12px}
a.dl{color:var(--link);font-weight:500;cursor:pointer}
.file{display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--bg3);border-radius:8px;padding:10px 12px;margin:6px 0;max-width:520px}
.file>div{min-width:0;flex:1}.file a.dl{flex:none;background:#4e5058;color:#fff;border-radius:4px;padding:4px 12px;font-size:14px}.file a.dl:hover{text-decoration:none;background:#5d6069}
.file-icon{font-size:28px}.file-name{font-weight:500}.file-size{color:var(--muted);font-size:12px}
.embed{display:flex;gap:16px;background:var(--bg2);border-left:4px solid #202225;border-radius:4px;padding:8px 16px 12px 12px;margin:6px 0;max-width:520px}
.embed-body{min-width:0;flex:1}
.embed-author{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;margin-top:8px;color:#f2f3f5}.embed-author-icon{width:24px;height:24px;border-radius:50%}
.embed-title{font-weight:600;margin-top:8px;color:#f2f3f5}
.embed-desc{font-size:14px;margin-top:8px}
.embed-fields{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.embed-field{grid-column:1/-1;font-size:14px}.embed-field.inline{grid-column:auto}.embed-field-name{font-weight:600;margin-bottom:2px;color:#f2f3f5}
.embed-image img{max-width:100%;border-radius:4px;margin-top:12px;display:block;cursor:zoom-in}
.embed-thumb{width:80px;height:80px;object-fit:cover;border-radius:4px;margin-top:8px;flex:none}
.embed-footer{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;margin-top:8px}.embed-footer-icon{width:20px;height:20px;border-radius:50%}
.action-row{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
.btn{display:inline-flex;align-items:center;gap:4px;border-radius:4px;padding:4px 14px;font-size:14px;font-weight:500;color:#fff;min-height:32px}a.btn:hover{text-decoration:none}
.btn-primary{background:#5865f2}.btn-secondary,.btn-link{background:#4e5058}.btn-success{background:#248046}.btn-danger{background:#da373c}
.reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.reaction{display:inline-flex;align-items:center;gap:4px;background:var(--bg2);border:1px solid var(--bg3);border-radius:8px;padding:2px 6px;font-size:14px}.reaction .emoji{width:16px;height:16px}
.sticker{width:160px;height:160px;object-fit:contain;margin:4px 0}.sticker-name{color:var(--muted)}
.end{color:var(--muted);text-align:center;padding:24px;font-size:13px;border-top:1px solid var(--border)}
#lightbox{display:none;position:fixed;inset:0;background:#000c;z-index:20;align-items:center;justify-content:center;cursor:zoom-out}
#lightbox.open{display:flex}#lightbox img{max-width:95vw;max-height:95vh}
@media (max-width:600px){.gutter{width:56px}.avatar{width:36px;height:36px}.embed-fields{grid-template-columns:1fr}.reply{margin-left:20px}}
`;

const SCRIPT = `
(function(){
  function pad(n){return n<10?'0'+n:''+n}
  function fmt(d,style){
    var date=pad(d.getDate())+'.'+pad(d.getMonth()+1)+'.'+d.getFullYear();
    var time=pad(d.getHours())+':'+pad(d.getMinutes());
    if(style==='t')return time;
    if(style==='T')return time+':'+pad(d.getSeconds());
    if(style==='d'||style==='D')return date;
    if(style==='R'){var s=Math.round((d-new Date())/1000),a=Math.abs(s),u=[[31536000,'y'],[2592000,'mo'],[86400,'d'],[3600,'h'],[60,'min']];for(var i=0;i<u.length;i++){if(a>=u[i][0]){var v=Math.floor(a/u[i][0]);return s<0?v+u[i][1]+' ago':'in '+v+u[i][1]}}return s<0?'just now':'soon'}
    return date+' '+time;
  }
  document.querySelectorAll('[data-ts]').forEach(function(el){
    var v=el.getAttribute('data-ts');if(!v)return;var d=new Date(v);if(isNaN(d))return;
    el.textContent=fmt(d,el.getAttribute('data-style'));el.title=d.toLocaleString();
  });
  function save(a){
    var b64,type;
    if(a.getAttribute('data-from')==='img'){
      var m=/^data:([^;,]+);base64,(.*)$/.exec(a.closest('.media').querySelector('img').src);
      if(!m)return;type=m[1];b64=m[2];
    }else{type=a.getAttribute('data-type')||'application/octet-stream';b64=a.getAttribute('data-b64')}
    var bin=atob(b64),bytes=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    var url=URL.createObjectURL(new Blob([bytes],{type:type})),l=document.createElement('a');
    l.href=url;l.download=a.getAttribute('data-name')||'file';document.body.appendChild(l);l.click();l.remove();
    setTimeout(function(){URL.revokeObjectURL(url)},2000);
  }
  document.getElementById('lightbox').addEventListener('click',function(){this.classList.remove('open')});
  document.addEventListener('click',function(e){
    var dl=e.target.closest('a.dl[data-name]');
    if(dl&&(dl.hasAttribute('data-b64')||dl.getAttribute('data-from')==='img')){e.preventDefault();save(dl);return}
    var sp=e.target.closest('.spoiler');
    if(sp&&!sp.classList.contains('revealed')){sp.classList.add('revealed');e.preventDefault();return}
    var img=e.target.closest('.media img,.embed-image img');
    if(img){e.preventDefault();var lb=document.getElementById('lightbox');lb.querySelector('img').src=img.src;lb.classList.add('open')}
  });
})();
`;

/**
 * @param {object} p
 * @param {object} p.ticket   { number, userId, username, openedAt }
 * @param {string} p.guildName
 * @param {string} [p.guildIcon]  icon url, shown when it is in `media`
 * @param {object[]} p.messages  oldest first
 * @param {object} [p.closedBy] { id, name }
 * @param {number} [p.closedAt]
 * @param {string} [p.ticketName]  e.g. ticket-0001
 * @param {Map<string,string>} [p.media]  image url -> data: URI
 * @param {Map<string,object>} [p.files]  attachment url -> where its original is (page, online or nowhere)
 */
function renderTranscriptHtml({ ticket, guildName, guildIcon, messages, closedBy, closedAt, ticketName, media = new Map(), files = new Map() }) {
  const name = ticketName || `ticket-${String(ticket.number).padStart(4, '0')}`;
  const closed = closedAt || Date.now();
  const byId = new Map(messages.map((m) => [m.id, m]));
  const nonce = crypto.randomBytes(12).toString('base64');

  const counts = new Map();
  for (const m of messages) {
    const key = (m.author && (m.author.name || m.author.id)) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `<span class="participant">${esc(n)} <span class="muted">${c}</span></span>`).join('');

  const rows = messages.map((m, i) => renderMessage(m, messages[i - 1] || null, byId, media, files)).join('\n');
  const icon = guildIcon && media.get(guildIcon);
  const iconHtml = icon ? `<img class="guild-icon" src="${esc(icon)}" alt="">` : `<div class="guild-icon placeholder">${esc((guildName || '?').slice(0, 1).toUpperCase())}</div>`;
  const row = (k, v) => `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`;
  const who = (n, id) => `${esc(n || id || 'unknown')}${id ? ` <span class="muted">(${esc(id)})</span>` : ''}`;
  const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<title>Transcript - ${esc(name)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">${iconHtml}<div><div class="guild-name">${esc(guildName || '')}</div><div class="channel-name"># ${esc(name)}</div></div></header>
<section class="cards"><div class="card"><div class="card-title">🎫 Ticket</div>
${row('Ticket', `#${esc(name)}`)}
${row('Opened by', who(ticket.username, ticket.userId))}
${row('Closed by', who(closedBy && closedBy.name, closedBy && closedBy.id))}
${row('Opened', tsSpan(ticket.openedAt || closed, 'f'))}
${row('Closed', tsSpan(closed, 'f'))}
${row('Duration', esc(formatSpan(closed - (ticket.openedAt || closed))))}
${row('Messages', String(messages.length))}
<div class="participants">${chips}</div></div></section>
<main class="messages">
${rows}
</main>
<footer class="end">End of transcript · ${esc(guildName || '')} · 35xw</footer>
<div id="lightbox"><img alt=""></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}

module.exports = { renderTranscriptHtml, renderContent, formatSpan, esc, emojiUrl };
