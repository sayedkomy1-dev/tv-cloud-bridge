const express = require('express');
const { chromium } = require('playwright');
const { Readable } = require('stream');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;
const VW = parseInt(process.env.VIEWPORT_W || '1024', 10);
const VH = parseInt(process.env.VIEWPORT_H || '576', 10);
const DEFAULT_URL = process.env.DEFAULT_URL || 'https://welivequran.online/';

let browser = null;
let context = null;
let page = null;
let lastUrl = DEFAULT_URL;
let busy = false;
let detectedAudioUrls = [];

// Smart In-Memory LRU Cache (max ~60 MB total, max 10 MB per file)
const resourceCache = new Map();
let currentCacheBytes = 0;
const MAX_CACHE_BYTES = 60 * 1024 * 1024;
const MAX_ITEM_BYTES = 10 * 1024 * 1024;

function setCache(key, entry) {
  if (entry.buffer.length > MAX_ITEM_BYTES) return;
  while (currentCacheBytes + entry.buffer.length > MAX_CACHE_BYTES && resourceCache.size > 0) {
    const oldestKey = resourceCache.keys().next().value;
    const oldEntry = resourceCache.get(oldestKey);
    currentCacheBytes -= oldEntry.buffer.length;
    resourceCache.delete(oldestKey);
  }
  resourceCache.set(key, entry);
  currentCacheBytes += entry.buffer.length;
}

function isCacheable(url, contentType) {
  const u = url.toLowerCase();
  const ct = (contentType || '').toLowerCase();
  return (
    u.endsWith('.ttf') || u.endsWith('.otf') || u.endsWith('.woff') || u.endsWith('.woff2') ||
    u.endsWith('.mp3') || u.endsWith('.json') ||
    ct.includes('font') || ct.includes('audio/mpeg') || ct.includes('application/json')
  );
}

async function ensurePage() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    context = await browser.newContext({
      viewport: { width: VW, height: VH },
      locale: 'ar-EG',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);

    // Sniff audio URLs loaded in the background by modern web players
    page.on('response', (res) => {
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        const u = res.url();
        if (ct.includes('audio/') || /\.(mp3|m4a|aac|ogg)(\?|$)/i.test(u)) {
          if (!detectedAudioUrls.includes(u)) {
            detectedAudioUrls.unshift(u);
            if (detectedAudioUrls.length > 15) detectedAudioUrls.pop();
          }
        }
      } catch (_) {}
    });

    await page.goto(DEFAULT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  return page;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 1. Resource Proxy + Smart Cache (/fetch?url=...)
app.get('/fetch', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return res.status(400).send('Missing or invalid ?url= parameter');
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  // Serve from Smart Cache when no Range header is used
  if (!req.headers.range && resourceCache.has(targetUrl)) {
    const cached = resourceCache.get(targetUrl);
    if (cached.contentType) res.setHeader('Content-Type', cached.contentType);
    res.setHeader('X-Bridge-Cache', 'HIT');
    return res.send(cached.buffer);
  }

  try {
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    };
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: 'follow'
    });

    const ct = upstream.headers.get('content-type') || '';
    const cl = parseInt(upstream.headers.get('content-length') || '0', 10);

    // Cache small/medium fonts, audio, json if no Range request
    if (upstream.status === 200 && !req.headers.range && isCacheable(targetUrl, ct) && cl <= MAX_ITEM_BYTES) {
      const arrayBuf = await upstream.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      setCache(targetUrl, { buffer: buf, contentType: ct });
      if (ct) res.setHeader('Content-Type', ct);
      res.setHeader('X-Bridge-Cache', 'MISS-STORED');
      return res.send(buf);
    }

    res.status(upstream.status);
    const copyHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
    for (const h of copyHeaders) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(502).send('Proxy fetch error: ' + err.message);
  }
});

// 2. Audio Extractor (/audio?url=...) -> plays detected audio natively on TV
app.get('/audio', async (req, res) => {
  try {
    const p = await ensurePage();
    if (req.query.url) {
      await p.goto(req.query.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    const domAudio = await p.evaluate(() => {
      const found = [];
      document.querySelectorAll('audio, audio source, a[href]').forEach((el) => {
        const src = el.src || el.getAttribute('href') || '';
        if (src && /\.(mp3|m4a|aac|ogg)(\?|$)/i.test(src)) {
          found.push(src);
        } else if (el.tagName === 'AUDIO' && el.src) {
          found.push(el.src);
        }
      });
      return found;
    }).catch(() => []);

    const allAudio = Array.from(new Set([...domAudio, ...detectedAudioUrls]));
    const itemsHtml = allAudio.length > 0
      ? allAudio.map((u, i) => `
          <div class="card">
            <div class="url-txt">🎵 مقطع صوتي #${i + 1}: ${escapeHtml(u.slice(0, 80))}</div>
            <audio controls ${i === 0 ? 'autoplay' : ''} style="width:100%; margin-top:8px;">
              <source src="/fetch?url=${encodeURIComponent(u)}" type="audio/mpeg" />
            </audio>
          </div>`).join('')
      : '<div class="card">⚠️ لم يتم العثور على ملفات صوت مباشرة في هذه الصفحة حالياً. جرب تشغيل الصوت في الصفحة أولاً ثم اضغط تحديث.</div>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>مستخرج الصوت - التلفزيون</title>
<style>
  body { background: #07111e; color: #fff; font-family: Tahoma, Arial, sans-serif; padding: 18px; }
  .top { margin-bottom: 16px; border-bottom: 2px solid #fbbf24; padding-bottom: 10px; }
  .btn { background: #065f46; color: #fde68a; border: 1px solid #fbbf24; padding: 8px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 15px; margin-left: 8px; display: inline-block; }
  .card { background: #0f223a; border: 2px solid #38bdf8; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .url-txt { font-size: 14px; color: #cbd5e1; direction: ltr; text-align: left; word-break: break-all; }
</style>
</head>
<body>
  <div class="top">
    <a class="btn" href="/">⬅️ العودة للمتصفح</a>
    <a class="btn" href="/audio">🔄 إعادة فحص الصوت</a>
    <span style="font-size:20px; font-weight:bold; color:#fbbf24;">🎧 مستخرج الصوت المباشر للتلفزيون</span>
  </div>
  ${itemsHtml}
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Audio Extractor Error: ' + err.message);
  }
});

// 3. Clean TV Reader Mode (/read?url=...)
app.get('/read', async (req, res) => {
  try {
    const p = await ensurePage();
    if (req.query.url) {
      await p.goto(req.query.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    const article = await p.evaluate(() => {
      const title = document.title || '';
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, nav, footer, header, aside, iframe, form').forEach((el) => el.remove());
      const blocks = [];
      clone.querySelectorAll('h1, h2, h3, p, li').forEach((el) => {
        const txt = (el.innerText || '').trim();
        if (txt.length > 20) {
          blocks.push({ tag: el.tagName.toLowerCase(), text: txt });
        }
      });
      return { title, blocks: blocks.slice(0, 120) };
    });

    const contentHtml = article.blocks.length > 0
      ? article.blocks.map((b) =>
          b.tag.startsWith('h')
            ? `<h2>${escapeHtml(b.text)}</h2>`
            : `<p>${escapeHtml(b.text)}</p>`
        ).join('')
      : '<p>⚠️ لم يتم العثور على نص مقال واضح في هذه الصفحة.</p>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>وضع القراءة - ${escapeHtml(article.title)}</title>
<style>
  body { background: #07111e; color: #f8fafc; font-family: Tahoma, Arial, sans-serif; padding: 20px 32px; line-height: 1.85; }
  .top { border-bottom: 2px solid #fbbf24; padding-bottom: 12px; margin-bottom: 20px; }
  .btn { background: #065f46; color: #fde68a; border: 1px solid #fbbf24; padding: 8px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 16px; margin-left: 10px; display: inline-block; }
  h1 { color: #fbbf24; font-size: 28px; margin-bottom: 16px; }
  h2 { color: #38bdf8; font-size: 24px; margin: 20px 0 10px; }
  p { font-size: 22px; margin-bottom: 14px; color: #e2e8f0; }
</style>
</head>
<body>
  <div class="top">
    <a class="btn" href="/">⬅️ العودة للمتصفح</a>
    <a class="btn" href="/audio">🎧 استخراج الصوت</a>
  </div>
  <h1>📰 ${escapeHtml(article.title)}</h1>
  ${contentHtml}
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Reader Error: ' + err.message);
  }
});

// 4. Mobile-to-TV Cast & Remote Control (/remote)
app.get('/remote', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ريموت الموبايل للتلفزيون</title>
<style>
  * { box-sizing: border-box; font-family: Tahoma, Arial, sans-serif; }
  body { background: #07111e; color: #fff; padding: 16px; max-width: 480px; margin: auto; }
  h2 { color: #fbbf24; margin-bottom: 14px; text-align: center; }
  .card { background: #0f223a; border: 1px solid #294c7a; border-radius: 10px; padding: 14px; margin-bottom: 14px; }
  input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #38bdf8; background: #07111e; color: #fff; font-size: 15px; margin-bottom: 10px; direction: ltr; }
  button { width: 100%; padding: 12px; border-radius: 8px; border: none; font-size: 16px; font-weight: bold; cursor: pointer; margin-bottom: 8px; }
  .btn-go { background: #065f46; color: #fde68a; border: 1px solid #fbbf24; }
  .btn-act { background: #162f4f; color: #fff; border: 1px solid #38bdf8; }
  .row { display: flex; gap: 8px; }
  .row button { flex: 1; }
  #msg { text-align: center; color: #34d399; font-weight: bold; min-height: 22px; }
</style>
</head>
<body>
  <h2>📱 ريموت الموبايل للتلفزيون</h2>
  <div id="msg"></div>

  <div class="card">
    <input id="u" type="text" placeholder="الصق أي رابط هنا..." value="${escapeHtml(lastUrl)}" />
    <button class="btn-go" onclick="sendUrl()">🚀 فتح الرابط على التلفزيون</button>
    <div class="row">
      <button class="btn-act" onclick="quick('https://welivequran.online/')">📖 بالقرآن نحيا</button>
      <button class="btn-act" onclick="quick('https://www.google.com/?hl=ar')">🔍 جوجل</button>
    </div>
  </div>

  <div class="card">
    <input id="txt" type="text" placeholder="اكتب نص لإرساله لمربع البحث..." style="direction:rtl;" />
    <button class="btn-act" onclick="sendTxt()">⌨️ إرسال النص للتلفزيون</button>
  </div>

  <div class="card">
    <div class="row">
      <button class="btn-act" onclick="act('scrollUp')">⬆️ أعلى</button>
      <button class="btn-act" onclick="act('scrollDown')">⬇️ أسفل</button>
      <button class="btn-act" onclick="act('back')">⬅️ رجوع</button>
    </div>
  </div>

<script>
function post(path, obj, msg) {
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  }).then(() => {
    document.getElementById('msg').innerText = msg || '✅ تم الإرسال للتلفزيون';
  });
}
function sendUrl() {
  var val = document.getElementById('u').value.trim();
  if (val && !val.startsWith('http')) val = 'https://' + val;
  if (val) post('/goto', { url: val }, '🚀 جاري فتح الرابط على التلفزيون...');
}
function quick(val) {
  document.getElementById('u').value = val;
  post('/goto', { url: val }, '🚀 جاري الفتح...');
}
function sendTxt() {
  var t = document.getElementById('txt').value;
  if (t) post('/action', { type: 'type', text: t }, '⌨️ تم إرسال النص!');
}
function act(type) { post('/action', { type: type }, '✅ تم تنفيذ الأمر'); }
</script>
</body>
</html>`);
});

// 5. Legacy Android 4.4.2 KitKat-compatible HTML + ES5 Browser UI
app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>جسر التصفح السحابي - التلفزيون</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; background: #07111e; color: #fff; font-family: Tahoma, Arial, sans-serif; overflow: hidden; }
  .bar { width: 100%; height: 48px; background: #0f223a; border-bottom: 2px solid #fbbf24; padding: 5px 8px; }
  .bar table { width: 100%; border-collapse: collapse; }
  .btn {
    background: #162f4f; color: #fff; border: 1px solid #38bdf8; border-radius: 5px;
    padding: 5px 8px; font-size: 12px; font-weight: bold; cursor: pointer; margin-left: 3px; text-decoration: none; display: inline-block;
  }
  .btn-gold { background: #065f46; border-color: #fbbf24; color: #fde68a; }
  .url-box {
    width: 100%; padding: 5px 8px; font-size: 13px; border-radius: 5px;
    border: 1px solid #38bdf8; background: #07111e; color: #fff; direction: ltr; text-align: left;
  }
  .view-wrap {
    width: 100%; height: calc(100% - 48px); text-align: center; background: #000; position: relative;
  }
  #screenImg {
    max-width: 100%; max-height: 100%; width: auto; height: 100%;
    cursor: crosshair; display: inline-block;
  }
  .status {
    position: absolute; bottom: 6px; left: 8px; background: rgba(0,0,0,0.75);
    color: #34d399; padding: 3px 8px; border-radius: 4px; font-size: 12px; direction: ltr;
  }
</style>
</head>
<body>
<div class="bar">
  <table>
    <tr>
      <td style="white-space:nowrap;">
        <button class="btn btn-gold" onclick="goUrl('https://welivequran.online/')">📖 بالقرآن نحيا</button>
        <button class="btn" onclick="goUrl('https://www.google.com/?hl=ar')">🔍 جوجل</button>
        <button class="btn" onclick="sendAct('back')">⬅️</button>
        <button class="btn" onclick="sendAct('scrollUp')">⬆️</button>
        <button class="btn" onclick="sendAct('scrollDown')">⬇️</button>
        <a class="btn" href="/audio">🎧 صوت</a>
        <a class="btn" href="/read">📰 قراءة</a>
      </td>
      <td style="width:28%; padding: 0 4px;">
        <input id="urlIn" class="url-box" type="text" value="${escapeHtml(lastUrl)}" onkeydown="if(event.keyCode===13) goCustom();" />
      </td>
      <td style="white-space:nowrap;">
        <button class="btn btn-gold" onclick="goCustom()">🚀 فتح</button>
        <button class="btn" onclick="sendText()">⌨️ كتابة</button>
        <button class="btn" onclick="refreshImg()">🔄</button>
        <button class="btn" id="autoBtn" onclick="toggleAuto()">⏸️</button>
      </td>
    </tr>
  </table>
</div>
<div class="view-wrap">
  <img id="screenImg" src="/screen?t=0" onclick="handleClick(event)" alt="Cloud Screen" />
  <div class="status" id="st">متصل بالسحابة...</div>
</div>

<script>
var VW = ${VW};
var VH = ${VH};
var autoRefresh = true;
var timer = null;

function setSt(msg) {
  document.getElementById('st').innerHTML = msg;
}

function refreshImg() {
  var img = document.getElementById('screenImg');
  img.src = '/screen?t=' + new Date().getTime();
}

function scheduleAuto() {
  if (timer) clearInterval(timer);
  timer = setInterval(function() {
    if (autoRefresh) refreshImg();
  }, 1800);
}

function toggleAuto() {
  autoRefresh = !autoRefresh;
  document.getElementById('autoBtn').innerHTML = autoRefresh ? '⏸️' : '▶️';
}

function apiPost(path, params) {
  setSt('⏳ جاري التنفيذ...');
  var xhr = new XMLHttpRequest();
  xhr.open('POST', path, true);
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      setSt('✅ جاهز');
      setTimeout(refreshImg, 350);
    }
  };
  var parts = [];
  for (var k in params) {
    if (params.hasOwnProperty(k)) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  xhr.send(parts.join('&'));
}

function goUrl(u) {
  document.getElementById('urlIn').value = u;
  apiPost('/goto', { url: u });
}

function goCustom() {
  var u = document.getElementById('urlIn').value.replace(/^\s+|\s+$/g, '');
  if (!u) return;
  if (u.indexOf('http://') !== 0 && u.indexOf('https://') !== 0) u = 'https://' + u;
  goUrl(u);
}

function sendAct(type) {
  apiPost('/action', { type: type });
}

function sendText() {
  var txt = window.prompt('اكتب النص لإرساله للمربع المحدد في الصفحة:', '');
  if (txt !== null) {
    apiPost('/action', { type: 'type', text: txt });
  }
}

function handleClick(e) {
  e = e || window.event;
  var img = document.getElementById('screenImg');
  var rect = img.getBoundingClientRect();
  var clickX = (e.clientX - rect.left) / rect.width;
  var clickY = (e.clientY - rect.top) / rect.height;
  var realX = Math.round(clickX * VW);
  var realY = Math.round(clickY * VH);
  apiPost('/action', { type: 'click', x: realX, y: realY });
}

window.onload = function() {
  scheduleAuto();
};
</script>
</body>
</html>`);
});

app.get('/screen', async (req, res) => {
  if (busy) return res.status(204).end();
  busy = true;
  try {
    const p = await ensurePage();
    lastUrl = p.url();
    const buf = await p.screenshot({ type: 'jpeg', quality: 72 });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  } finally {
    busy = false;
  }
});

app.post('/goto', async (req, res) => {
  try {
    const p = await ensurePage();
    const target = req.body.url || DEFAULT_URL;
    await p.goto(target, { waitUntil: 'domcontentloaded' });
    lastUrl = p.url();
    res.json({ ok: true, url: lastUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/action', async (req, res) => {
  try {
    const p = await ensurePage();
    const type = req.body.type;
    if (type === 'click') {
      const x = parseInt(req.body.x || '0', 10);
      const y = parseInt(req.body.y || '0', 10);
      await p.mouse.click(x, y);
    } else if (type === 'scrollDown') {
      await p.mouse.wheel(0, 350);
    } else if (type === 'scrollUp') {
      await p.mouse.wheel(0, -350);
    } else if (type === 'back') {
      await p.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    } else if (type === 'type') {
      const text = req.body.text || '';
      await p.keyboard.type(text);
      await p.keyboard.press('Enter');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log('TV Cloud Bridge v1.2 listening on port', PORT);
});
