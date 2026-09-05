'use strict';

/**
 * Renders a ticket conversation as a self-contained, Discord-looking HTML page.
 * Pure: takes plain data, returns a string. Every piece of user text is escaped.
 *
 * message shape: { id, createdTimestamp, author: { id, name, tag, bot, avatar }, content,
 *                  mentions: { [userId]: username }, attachments: [{ name, url, contentType }],
 *                  embeds: [{ title, description }] }
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

/** Escape, then apply a little Discord-style markup: mentions, `code`, **bold**, *italic*, links. */
function renderContent(text, mentions = {}) {
  let s = esc(text);
  s = s.replace(/&lt;@!?(\d+)&gt;/g, (m, id) => `<span class="mention">@${esc(mentions[id] || id)}</span>`);
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@role</span>');
  s = s.replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#channel</span>');
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => `<pre>${code.trim()}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  return s.replace(/\n/g, '<br>');
}

function isImage(att) {
  return /^image\//i.test(att.contentType || '') || /\.(png|jpe?g|gif|webp)$/i.test(att.name || '');
}

function renderMessage(m) {
  const a = m.author || {};
  const avatar = a.avatar
    ? `<img class="avatar" src="${esc(a.avatar)}" alt="" loading="lazy">`
    : `<div class="avatar placeholder">${esc((a.name || '?').slice(0, 1).toUpperCase())}</div>`;
  const bot = a.bot ? '<span class="badge">BOT</span>' : '';
  const attachments = (m.attachments || [])
    .map((att) =>
      isImage(att)
        ? `<a class="att" href="${esc(att.url)}" target="_blank" rel="noopener"><img src="${esc(att.url)}" alt="${esc(att.name || 'image')}" loading="lazy"></a>`
        : `<a class="att file" href="${esc(att.url)}" target="_blank" rel="noopener">📎 ${esc(att.name || 'attachment')}</a>`,
    )
    .join('');
  const embeds = (m.embeds || [])
    .map(
      (e) =>
        `<div class="embed">${e.title ? `<div class="embed-title">${esc(e.title)}</div>` : ''}${
          e.description ? `<div class="embed-desc">${renderContent(e.description)}</div>` : ''
        }</div>`,
    )
    .join('');
  const content = m.content ? `<div class="content">${renderContent(m.content, m.mentions)}</div>` : '';
  return `<div class="msg">${avatar}<div class="body"><div class="head"><span class="name">${esc(a.name || 'unknown')}</span>${bot}<span class="time">${esc(fmtTime(m.createdTimestamp))}</span></div>${content}${attachments}${embeds}</div></div>`;
}

/**
 * @param {object} p
 * @param {object} p.ticket   { number, userId, username, openedAt }
 * @param {string} p.guildName
 * @param {object[]} p.messages  oldest first
 * @param {object} [p.closedBy] { id, name }
 * @param {number} [p.closedAt]
 * @param {string} [p.ticketName]  e.g. ticket-0001
 */
function renderTranscriptHtml({ ticket, guildName, messages, closedBy, closedAt, ticketName }) {
  const name = ticketName || `ticket-${String(ticket.number).padStart(4, '0')}`;
  const participants = new Set(messages.map((m) => (m.author && m.author.id) || '').filter(Boolean)).size;
  const closed = closedAt || Date.now();
  const rows = messages.map(renderMessage).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — transcript</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #313338; color: #dbdee1; font-family: "gg sans", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; }
  .header { background: #2b2d31; padding: 22px 28px; border-bottom: 1px solid #1e1f22; }
  .header h1 { margin: 0 0 6px; font-size: 22px; color: #fff; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 22px; color: #b5bac1; font-size: 14px; }
  .meta b { color: #fff; }
  .log { padding: 18px 28px 40px; max-width: 1100px; }
  .msg { display: flex; gap: 14px; padding: 8px 0; }
  .msg:hover { background: rgba(0,0,0,.08); }
  .avatar { width: 40px; height: 40px; border-radius: 50%; flex: 0 0 40px; object-fit: cover; }
  .avatar.placeholder { display: grid; place-items: center; background: #5865f2; color: #fff; font-weight: 700; }
  .body { min-width: 0; flex: 1; }
  .head { display: flex; align-items: center; gap: 8px; }
  .name { color: #fff; font-weight: 600; }
  .badge { background: #5865f2; color: #fff; font-size: 10px; padding: 1px 5px; border-radius: 4px; font-weight: 600; }
  .time { color: #949ba4; font-size: 12px; }
  .content { margin-top: 2px; line-height: 1.4; word-wrap: break-word; white-space: normal; }
  .mention { background: rgba(88,101,242,.3); color: #dee0fc; padding: 0 3px; border-radius: 3px; }
  code { background: #1e1f22; padding: 1px 4px; border-radius: 4px; font-size: 90%; }
  pre { background: #1e1f22; padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
  a { color: #00a8fc; }
  .att img { max-width: 420px; max-height: 320px; border-radius: 8px; display: block; margin-top: 6px; }
  .att.file { display: inline-block; margin-top: 6px; background: #2b2d31; padding: 6px 10px; border-radius: 6px; text-decoration: none; }
  .embed { border-left: 4px solid #5865f2; background: #2b2d31; padding: 8px 12px; border-radius: 4px; margin-top: 6px; max-width: 520px; }
  .embed-title { color: #fff; font-weight: 600; margin-bottom: 4px; }
  .footer { text-align: center; color: #949ba4; font-size: 12px; padding: 20px; border-top: 1px solid #1e1f22; }
</style>
</head>
<body>
<div class="header">
  <h1>🎫 ${esc(name)}</h1>
  <div class="meta">
    <span>🏠 <b>${esc(guildName || '')}</b></span>
    <span>👤 Opened by <b>${esc(ticket.username || ticket.userId)}</b></span>
    <span>🕒 Opened <b>${esc(fmtTime(ticket.openedAt))}</b></span>
    <span>🔒 Closed by <b>${esc(closedBy ? closedBy.name || closedBy.id : '—')}</b> at <b>${esc(fmtTime(closed))}</b></span>
    <span>⏱️ Duration <b>${esc(formatSpan(closed - (ticket.openedAt || closed)))}</b></span>
    <span>💬 <b>${messages.length}</b> messages</span>
    <span>🧑‍🤝‍🧑 <b>${participants}</b> participants</span>
  </div>
</div>
<div class="log">
${rows}
</div>
<div class="footer">Generated by 35xw • ${esc(fmtTime(closed))}</div>
</body>
</html>
`;
}

module.exports = { renderTranscriptHtml, renderContent, formatSpan, esc };
