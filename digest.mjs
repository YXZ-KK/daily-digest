import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const DATA = path.join(DIST, 'data');
const DAYS = path.join(DIST, 'd');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(DAYS, { recursive: true });
// 静态资源（图标 / manifest / sw）随构建一起进 dist
const PUB = path.join(ROOT, 'public');
if (fs.existsSync(PUB)) fs.cpSync(PUB, DIST, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const strip = s => String(s ?? '').replace(/\s+/g, ' ').trim();

async function getJson(url, extra = {}) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*', 'accept-language': 'zh-CN,zh;q=0.9', ...extra },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml,*/*', 'accept-language': 'zh-CN,zh;q=0.9' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ---------- sources ----------
async function weibo() {
  const j = await getJson('https://weibo.com/ajax/side/hotSearch', {
    accept: 'application/json, text/plain, */*',
    referer: 'https://weibo.com/hot/search',
    'x-requested-with': 'XMLHttpRequest',
  });
  return (j?.data?.realtime || []).slice(0, 40).map((x, i) => ({
    source: '微博', rank: i + 1, title: strip(x.word),
    heat: x.num ?? x.raw_hot ?? null,
    url: `https://s.weibo.com/weibo?q=${encodeURIComponent(x.word)}`,
  }));
}

async function zhihu() {
  const j = await getJson('https://api.zhihu.com/topstory/hot-lists/total?limit=50');
  return (j?.data || []).slice(0, 40).map((x, i) => {
    const t = x.target || {};
    const id = String(t.id || '').replace(/\D/g, '');
    return {
      source: '知乎', rank: i + 1,
      title: strip(t.title),
      desc: strip(t.excerpt).slice(0, 110),
      heat: t.metrics_area?.text || t.metricsArea?.text || null,
      url: id ? `https://www.zhihu.com/question/${id}` : 'https://www.zhihu.com/hot',
    };
  });
}

async function bili() {
  const j = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1');
  return (j?.data?.list || []).map((v, i) => ({
    source: 'B站', rank: i + 1, title: strip(v.title),
    desc: strip(v.desc).slice(0, 100),
    heat: v.stat?.view ? `${(v.stat.view / 10000).toFixed(1)}万播放` : null,
    url: `https://www.bilibili.com/video/${v.bvid}`,
  }));
}

async function baidu() {
  const j = await getJson('https://top.baidu.com/api/board?platform=wise&tab=realtime');
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object' || found.length >= 30) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.word === 'string' && node.word && !node.isTop) {
      found.push({
        source: '百度', rank: found.length + 1,
        title: strip(node.word),
        desc: strip(node.desc).slice(0, 100),
        heat: node.hotScore ? `${node.hotScore}` : null,
        url: node.url || node.rawUrl || `https://www.baidu.com/s?wd=${encodeURIComponent(node.word)}`,
      });
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(j);
  return found;
}

async function hackernews() {
  const j = await getJson('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=25');
  return (j?.hits || []).map((h, i) => ({
    source: 'HN', rank: i + 1, title: strip(h.title),
    heat: h.points != null ? `${h.points} 分` : null,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));
}

async function ghTrending() {
  // GitHub 直连不通时报错跳过；有代理时可用
  const r = await fetch('https://github.com/trending?since=daily', {
    headers: { 'user-agent': UA, accept: 'text/html' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const out = [];
  const re = /<h2 class="h3 lh-condensed">\s*<a href="\/([^"]+)"[\s\S]*?<\/h2>[\s\S]*?<p class="col-9 color-fg-muted my-1 pr-4">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    out.push({
      source: 'GitHub', rank: out.length + 1, title: strip(m[1]),
      desc: strip(m[2].replace(/<[^>]+>/g, '')).slice(0, 110), heat: null,
      url: `https://github.com/${strip(m[1])}`,
    });
  }
  return out;
}

// 通用 RSS 源
function rss(name, url, limit = 20) {
  return async () => {
    const xml = await getText(url);
    const items = xml.split(/<item[\s>]/).slice(1);
    const pick = (chunk, tag) => {
      const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return null;
      // RSS 里常把正文 HTML 转义着塞进 description，先解实体再剥标签
      let s = m[1].replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      s = s.replace(/<[^>]+>/g, ' ');
      return strip(s);
    };
    return items.slice(0, limit).map((chunk, i) => ({
      source: name, rank: i + 1,
      title: pick(chunk, 'title') || '',
      desc: (pick(chunk, 'description') || '').slice(0, 120),
      heat: null,
      url: pick(chunk, 'link') || '',
    })).filter(x => x.title && x.url);
  };
}

// ---------- categorize ----------
const KEYWORDS = {
  '科技/AI': ['AI', '人工智能', '大模型', '模型', '芯片', '半导体', '算力', '显卡', 'GPU', 'CPU', '手机', '华为', '苹果', 'iPhone', 'iOS', '安卓', '鸿蒙', '系统', '软件', '编程', '开源', '算法', '机器人', '卫星', '航天', '火箭', '量子', '电池', '新能源', '自动驾驶', '互联网', '服务器', '黑客', '漏洞', '数据中心', '英伟达', '高通', '台积电', 'OpenAI', 'GPT', 'ChatGPT', 'DeepSeek', 'Gemini', 'Claude', 'Meta', 'Google', '微软', '亚马逊', 'SpaceX', '马斯克', '特斯拉', '发布会', '新品', '笔记本', '电脑', 'App', '插件'],
  '游戏/动漫': ['游戏', '原神', '崩坏', '星穹', '绝区零', '米哈游', 'Steam', '主机', '手游', '电竞', '番剧', '动画', '漫画', '声优', '二游', '抽卡', '联动', 'Switch', 'PS5', 'Xbox', '网游', '英雄联盟', '王者荣耀', '我的世界', '版本', '皮肤', '赛季', '漫展', '剧场版', '手办', '同人'],
  '财经/商业': ['股', '基金', '涨停', '跌停', '市值', '财报', '营收', '利润', '亏损', '融资', '上市', 'IPO', '裁员', '降薪', '房价', '楼市', '房贷', '关税', '汇率', '人民币', '美元', '黄金', '油价', '银行', '利率', '通胀', '美联储', '央行', '经济', 'GDP', '消费', '电商', '收购', '并购', '卖空'],
  '娱乐/明星': ['明星', '演员', '歌手', '综艺', '演唱会', '恋情', '离婚', '结婚', '官宣', '剧组', '电影', '票房', '红毯', '粉丝', '塌房', '新歌', '专辑', '主持人', '短剧', '网剧', '直播', '选秀', '塌'],
  '社会/民生': ['警方', '通报', '判决', '法院', '事故', '火灾', '地震', '暴雨', '台风', '洪水', '医院', '医生', '学校', '老师', '学生', '高考', '考研', '就业', '退休', '养老金', '社保', '彩礼', '家暴', '拐卖', '外卖', '快递', '物业', '食品安全', '疫苗', '补贴', '假期', '调休', '春运', '地铁', '公交', '高铁', '收费', '救人', '走失'],
  '体育': ['比赛', '联赛', '冠军', '夺冠', '球队', '球员', '奥运', '世界杯', 'NBA', 'CBA', '足球', '篮球', '乒乓', '羽毛球', '网球', '田径', '马拉松', '转会'],
  '国际': ['美国', '特朗普', '拜登', '俄罗斯', '乌克兰', '以色列', '巴勒斯坦', '伊朗', '日本', '韩国', '朝鲜', '欧盟', '联合国', '外交', '制裁', '战争', '停火', '总统', '首相', '大选', '移民'],
};

const SOURCE_DEFAULT = {
  'B站': '游戏/动漫', 'HN': '科技/AI', 'GitHub': '科技/AI', 'IT之家': '科技/AI', '少数派': '科技/AI', '钛媒体': '财经/商业',
  '微博': '社会/民生', '知乎': '社会/民生', '百度': '社会/民生',
};

function categorize(items) {
  const names = Object.keys(KEYWORDS);
  const buckets = {};
  for (const it of items) {
    const text = `${it.title} ${it.desc || ''}`;
    let best = null, bestScore = 0;
    for (const name of names) {
      let score = 0;
      for (const k of KEYWORDS[name]) if (text.includes(k)) score += 1;
      if (score > bestScore) { bestScore = score; best = name; }
    }
    const cat = best || SOURCE_DEFAULT[it.source] || '其他';
    (buckets[cat] ||= []).push(it);
  }
  return buckets;
}

const dedupe = items => {
  const seen = new Set();
  return items.filter(it => {
    const key = it.title.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '').slice(0, 14);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// ---------- render ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STYLE = `
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:16px 14px 48px;overflow-x:hidden;background:#101217;color:#e6e8ee;
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  header{max-width:820px;margin:0 auto 4px}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:#8b93a7;font-size:13px}
  nav{position:sticky;top:0;z-index:5;display:flex;gap:8px;overflow-x:auto;padding:10px 0 12px;
      max-width:820px;margin:0 auto;background:linear-gradient(#101217 70%,transparent)}
  nav a{flex:0 0 auto;padding:6px 12px;border-radius:999px;background:#1b1f2a;color:#b9c2d6;
        text-decoration:none;font-size:13px;border:1px solid #262c3a}
  .card{max-width:820px;margin:0 auto 14px;background:#161a23;border:1px solid #232a38;
        border-radius:14px;padding:14px 16px;scroll-margin-top:56px}
  h2{font-size:16px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
  .n{font-size:12px;color:#8b93a7;font-weight:400}
  ol{margin:0;padding-left:20px}
  li{margin:0 0 12px}
  li a{color:#e9edf7;text-decoration:none;overflow-wrap:anywhere}
  .meta{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:4px;font-size:12px;color:#8b93a7;align-items:baseline;min-width:0}
  .tr{display:inline-block;font-size:11px;line-height:15px;padding:0 5px;margin-right:6px;border-radius:4px;
      background:#1d2a3d;color:#8fb6d9;vertical-align:1px}
  .src{color:#7aa2ff}
  .heat{color:#ffb86b}
  .desc{flex-basis:100%;color:#98a1b5;min-width:0;overflow-wrap:anywhere}
  footer a{color:#7aa2ff;text-decoration:none}
  footer{max-width:820px;margin:22px auto 0;color:#6c7488;font-size:12px;text-align:center}
  .brief-list{list-style:none;margin:0;padding:0}
  .brief-list li{margin:0 0 14px;font-size:14px;line-height:1.5;color:#c9d2e4}
  .brief-list li:last-child{margin-bottom:0}
  .brief-list b{display:block;color:#7aa2ff;font-weight:600;font-size:12px;margin-bottom:3px;letter-spacing:.02em}
  .brief-list .dot{color:#4a5368;margin:0 6px}
  .picker{max-width:820px;margin:16px auto 0;text-align:center}
  .picker select{background:#1b1f2a;color:#e6e8ee;border:1px solid #2b3242;border-radius:10px;
                 padding:9px 12px;font-size:14px;min-width:190px}
  @media (prefers-color-scheme:light){
    body{background:#f6f7fb;color:#1c2030}
    nav{background:linear-gradient(#f6f7fb 70%,transparent)}
    .card{background:#fff;border-color:#e6e9f2}
    nav a{background:#fff;border-color:#e2e6f0;color:#4a5468}
    li a{color:#1b2b52}
    .desc{color:#5a6478}
    .brief-list li{color:#3a4358}
    .picker select{background:#fff;color:#1c2030;border-color:#dfe4ef}
  }`;

// 各类目内按来源轮转，避免某一站刷屏
function roundRobin(list) {
  const bySrc = new Map();
  for (const it of list) {
    if (!bySrc.has(it.source)) bySrc.set(it.source, []);
    bySrc.get(it.source).push(it);
  }
  for (const arr of bySrc.values()) arr.sort((a, b) => (a.rank || 99) - (b.rank || 99));
  const out = [];
  let more = true;
  while (more) {
    more = false;
    for (const arr of bySrc.values()) {
      if (arr.length) { out.push(arr.shift()); more = true; }
    }
  }
  return out;
}

const CAT_ORDER = ['科技/AI', '游戏/动漫', '财经/商业', '娱乐/明星', '社会/民生', '体育', '国际', '其他'];

function render({ date, buckets, counts, generatedAt, dates = [], archived = false }) {
  const cats = CAT_ORDER.filter(c => buckets[c]?.length);
  for (const c of cats) buckets[c] = roundRobin(buckets[c]);

  const sections = cats.map(c => `
    <section class="card" id="${esc(c)}">
      <h2>${esc(c)} <span class="n">${buckets[c].length}</span></h2>
      <ol>${buckets[c].map(it => `
        <li>
          <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
          <div class="meta">
            <span class="src">${esc(it.source)}</span>
            ${it.heat ? `<span class="heat">${esc(it.heat)}</span>` : ''}
            ${(it.zh || it.desc) ? `<span class="desc">${it.zh ? `<span class="tr">译</span>${esc(it.zh)}` : esc(it.desc)}</span>` : ''}
          </div>
        </li>`).join('')}</ol>
    </section>`).join('');

  const nav = cats.map(c => `<a href="#${esc(c)}">${esc(c)}</a>`).join('');

  // 速览：每类前 3 条，标题完整不截断
  const brief = `<section class="card" id="top">
      <h2>速览 <span class="n">每类前 3 条</span></h2>
      <ul class="brief-list">${cats.map(c => {
        const top = [...buckets[c]].sort((a, b) => (a.rank || 99) - (b.rank || 99)).slice(0, 3)
          .map(it => `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>`)
          .join('<span class="dot">·</span>');
        return `<li><b>${esc(c)}</b>${top}</li>`;
      }).join('')}</ul>
    </section>`;

  const base = archived ? '../' : '';
  const picker = dates.length ? `<div class="picker">
    <select id="dateSel" aria-label="选择日期">
      ${dates.map(d => `<option value="${esc(d)}"${d === date ? ' selected' : ''}>${esc(d)}${d === dates[0] ? '（最新）' : ''}</option>`).join('')}
    </select>
  </div>
  <script>document.getElementById('dateSel').addEventListener('change',e=>{
    const v=e.target.value; if(!v) return;
    location.href = ${archived ? `'../d/'+v+'.html'` : `'d/'+v+'.html'`};
  })</script>` : '';

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#101217">
<link rel="manifest" href="${base}manifest.webmanifest">
<link rel="apple-touch-icon" href="${base}apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="每日热点">
<title>每日热点 · ${esc(date)}</title>
<style>${STYLE}</style></head>
<body>
<header>
  <h1>每日热点 · ${esc(date)}</h1>
  <div class="sub">${counts.total} 条 · ${esc(generatedAt)} 生成 · ${esc(counts.sources.join(' / '))}</div>
  ${archived ? '<div class="sub" style="margin-top:6px"><a href="../index.html" style="color:#7aa2ff;text-decoration:none">← 回到今天</a></div>' : ''}
</header>
<nav>${nav}</nav>
${brief}
${sections}
${picker}
<footer>
  <div>共 ${counts.total} 条 · 每天 08:00 自动更新</div>
  <div style="margin-top:6px"><a href="${base}archive.html">历史归档</a> · <a href="${counts.repo || 'https://github.com/YXZ-KK/daily-digest'}" target="_blank" rel="noopener">源码</a></div>
  <div style="margin-top:6px">自动抓取公开榜单，仅作汇总，标题点击跳转原文</div>
</footer>
<script>if('serviceWorker' in navigator){addEventListener('load',()=>navigator.serviceWorker.register('${base}sw.js').catch(()=>{}))}</script>
</body></html>`;
}

function archivePage(dates) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>历史归档</title><style>
body{background:#101217;color:#e6e8ee;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;max-width:820px;margin:0 auto}
a{color:#7aa2ff;display:block;padding:10px 0;border-bottom:1px solid #232a38;text-decoration:none}
@media (prefers-color-scheme:light){body{background:#f6f7fb;color:#1c2030}a{color:#1b4fd8;border-color:#e6e9f2}}
</style></head>
<body><a href="index.html" style="font-size:14px">← 回到今天</a><h2 style="margin-top:10px">历史归档</h2>
${dates.map(d => `<a href="d/${d}.html">${d}</a>`).join('')}
<p style="color:#6c7488;font-size:12px;margin-top:18px">每天 08:00 自动更新，历史全部保留。</p></body></html>`;
}

// ---------- 英文条目翻译（MyMemory，逐条缓存） ----------
const TR_CACHE = path.join(DATA, 'translate-cache.json');

const cjkCount = s => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;
const latinCount = s => (String(s).match(/[A-Za-z]/g) || []).length;
const needsZh = s => cjkCount(s) < 3 && latinCount(s) >= 10;

async function translateOne(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 300))}&langpair=en|zh-CN`;
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j?.responseStatus !== 200) throw new Error(j?.responseDetails || 'bad response');
  const t = strip(j?.responseData?.translatedText || '');
  if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) throw new Error('empty translation');
  return t;
}

async function attachTranslations(items) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(TR_CACHE, 'utf8')); } catch { cache = {}; }
  let added = 0, failed = 0;
  const todo = items.filter(it => needsZh(it.title) && !cache[it.title]).slice(0, 40);
  for (const it of todo) {
    try {
      cache[it.title] = await translateOne(it.title);
      added++;
    } catch {
      failed++;
    }
    await new Promise(s => setTimeout(s, 120));
  }
  for (const it of items) if (cache[it.title]) it.zh = cache[it.title];
  fs.writeFileSync(TR_CACHE, JSON.stringify(cache, null, 2));
  if (added || failed) console.log(`translated ${added} (failed ${failed})`);
  return items;
}

// ---------- main ----------
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const hhmm = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const generatedAt = `${today} ${hhmm}`;

const jobs = [
  ['微博', weibo], ['知乎', zhihu], ['B站', bili], ['百度', baidu], ['HN', hackernews],
  ['IT之家', rss('IT之家', 'https://www.ithome.com/rss/', 20)],
  ['少数派', rss('少数派', 'https://sspai.com/feed', 15)],
  ['钛媒体', rss('钛媒体', 'https://www.tmtpost.com/rss', 15)],
  ['GitHub', ghTrending],
];
const results = await Promise.allSettled(jobs.map(([, fn]) => fn()));

const items = [], sources = [];
results.forEach((r, i) => {
  const name = jobs[i][0];
  if (r.status === 'fulfilled' && r.value.length) {
    console.log(`ok   ${name}: ${r.value.length}`);
    sources.push(name);
    items.push(...r.value);
  } else {
    console.log(`skip ${name}: ${r.status === 'rejected' ? r.reason?.message : '0 items'}`);
  }
});

const clean = dedupe(items).map(it => ({ ...it, title: it.title.slice(0, 90) }));
await attachTranslations(clean);
const buckets = categorize(clean);
const counts = { total: clean.length, sources };

fs.writeFileSync(path.join(DATA, `${today}.json`), JSON.stringify({
  date: today, generatedAt, sources, total: clean.length,
  categories: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  items: clean,
}, null, 2));

const dates = fs.readdirSync(DATA).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map(f => f.replace('.json', '')).sort().reverse();

// 今天
fs.writeFileSync(path.join(DIST, 'index.html'),
  render({ date: today, buckets, counts, generatedAt, dates }));

// 历史每天一页（含今天，供统一的日期下拉跳转）
for (const d of dates) {
  const file = path.join(DATA, `${d}.json`);
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  const items2 = payload.items || [];
  const b2 = categorize(items2);
  fs.writeFileSync(path.join(DAYS, `${d}.html`), render({
    date: d,
    buckets: b2,
    counts: { total: items2.length, sources: payload.sources || [] },
    generatedAt: payload.generatedAt || d,
    dates,
    archived: d !== today,
  }));
}

fs.writeFileSync(path.join(DIST, 'archive.html'), archivePage(dates));

console.log(`done ${clean.length} items / ${Object.keys(buckets).length} cats / ${dates.length} days -> ${DIST}`);
