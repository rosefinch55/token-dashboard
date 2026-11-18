// 实时 Token 用量看板（ZCode 用量统计风格）：概览指标卡 + 52 周热力 + 模型折线趋势 + 环形占比 + 模型 Token 分解条形图
// 数据源（逐条精确、增量实时）：
//   ① 会话 transcript（Claude Code 兼容格式，含 message.usage 与 providerData.model）
//      默认目录 ~/.workbuddy/projects，可用环境变量 USAGE_TRANSCRIPT_DIR 覆盖
//   ② 附加 JSONL 数据源（可选）：USAGE_EXTRA_JSONL="a.jsonl,b.jsonl"
//      每行需含 { ts, tokens:{in,out} } 或 { ts, tokensByModel:{ 模型:{tin,tout,cost} }, ts }
//   ③ ledger.json（可选，放在本文件上级目录）：{ since, 任意名称:{costCNY}, ... }，费用面板逐项展示
//   ④ DSH（DeepSeek Harness）会话：~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd
//      zstd 压缩，行型 assistant/* 的 data.usage 记 token、data.message.source 记 provider:model；
//      面板顶部「全部/WorkBuddy/DSH/Codex」可拆分查看（USAGE_DSH_DIR 可覆盖目录、置 none 关闭）
// 用法：node usage-server.js   浏览器开 http://127.0.0.1:4620
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = +(process.env.USAGE_PORT || 4620);
const WB_DIR = process.env.USAGE_TRANSCRIPT_DIR || path.join(os.homedir(), '.workbuddy', 'projects');
const EXTRA = (process.env.USAGE_EXTRA_JSONL || '').split(',').map((s) => s.trim()).filter(Boolean);
const WB_WINDOW_MS = 45 * 864e5;                          // 只统计近 45 天活跃的 transcript
const DSH_DIR = process.env.USAGE_DSH_DIR === 'off' ? '' : (process.env.USAGE_DSH_DIR || path.join(os.homedir(), '.dsh', 'sessions'));
const DSH_FILE_MAX = 64 * 1024 * 1024;                    // 单个 zstd 归档超 64MB 视为异常跳过
// Codex（Desktop/++共享 ~/.codex）：sessions/YYYY/MM/DD 分层 + archived_sessions 平铺，两目录都扫
const CODEX_DIRS = process.env.USAGE_CODEX_DIR === 'off' ? [] : [process.env.USAGE_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions'), path.join(os.homedir(), '.codex', 'archived_sessions')];
// ── 费用折算（可选）：只有设置了 USAGE_PRICED_MODEL 才对该模型按价目折钱，其余只计 token ──
const PRICED_MODEL = process.env.USAGE_PRICED_MODEL || '';      // 走计费网关、需要折钱的模型名（如某付费 API 模型）
const PRICE_CUT = Date.parse(process.env.USAGE_PRICE_CUT || '2099-01-01T00:00:00+08:00'); // 价目切换日（调过价再设）
// 示例占位价目 ¥/M token —— 按自家网关实际价目修改（PRICE_CUT 之前用 P_OLD，之后用 P_NEW）
const P_OLD = { inp: 2, cache: 0.4, outp: 8 };
const P_NEW = { inp: 1, cache: 0.2, outp: 4 };

const bjDate = (ts) => new Date(+new Date(ts) + 8 * 3600000).toISOString().slice(0, 10);
const fam = (m) => /^Qwen/i.test(m) ? 'Qwen' : /^DeepSeek/i.test(m) ? 'DeepSeek' : /^GLM/i.test(m) ? 'GLM' : (m === 'unknown' ? 'unknown' : m);
function wbCost(ts, inp, cache, outp) {
  const p = ts < PRICE_CUT ? P_OLD : P_NEW;
  return (inp * p.inp + cache * p.cache + outp * p.outp) / 1e6;
}

// ── transcript 增量扫描器（按字节 offset 增量读，usage 行同带真实模型名）──
const wb = { off: new Map(), warmed: false, days: new Map(), total: { in: 0, out: 0, cached: 0, cost: 0, n: 0 }, models: new Map() };
// 通用入桶：store = { days:Map, total:{}, models:Map }，两源共用一套按日/按模型聚合
function addRec(store, ts, model, inp, cache, outp) {
  const key = bjDate(ts);
  const priced = model === PRICED_MODEL;
  const c = priced ? wbCost(+new Date(ts), inp, cache, outp) : 0;
  const d = store.days.get(key) || { in: 0, out: 0, cached: 0, cost: 0, n: 0, models: {} };
  d.in += inp + cache; d.out += outp; d.cached += cache; d.cost += c; d.n++;
  const dm = d.models[model] || (d.models[model] = { tin: 0, tcache: 0, tout: 0 });
  dm.tin += inp; dm.tcache += cache; dm.tout += outp;   // 三桶分开：未缓存输入 / 缓存命中 / 输出
  store.days.set(key, d);
  store.total.in += inp + cache; store.total.out += outp; store.total.cached += cache; store.total.cost += c; store.total.n++;
  const g = store.models.get(model) || (store.models.set(model, { tin: 0, tcache: 0, tout: 0, cost: 0 }), store.models.get(model));
  g.tin += inp; g.tcache += cache; g.tout += outp; g.cost += c;
}
const wbAdd = (ts, model, inp, cache, outp) => addRec(wb, ts, model, inp, cache, outp);
function wbLine(r) {
  const u = r.message && r.message.usage;
  if (!u) return;
  const ts = r.timestamp || r.ts; if (!ts) return;
  const m = (r.providerData && r.providerData.model) || 'unknown';
  wbAdd(ts, m, u.input_tokens || 0, u.cache_read_input_tokens || 0, u.output_tokens || 0);
}
const dmCache = new Map(); let dmAt = 0;
function dirMtime(dp) {
  // 目录活跃度 = 内部 .jsonl 最大 mtime（追加写不更新目录 mtime）；30s 缓存
  if (Date.now() - dmAt > 30000) { dmCache.clear(); dmAt = Date.now(); }
  if (dmCache.has(dp)) return dmCache.get(dp);
  let mx = 0;
  try { for (const f of fs.readdirSync(dp)) { if (!f.endsWith('.jsonl')) continue; try { const t = fs.statSync(path.join(dp, f)).mtimeMs; if (t > mx) mx = t; } catch (e) {} } } catch (e) {}
  dmCache.set(dp, mx);
  return mx;
}
function wbScan(budgetMs) {
  const t0 = Date.now(); const now = Date.now();
  if (!fs.existsSync(WB_DIR)) { wb.warmed = true; return; }
  for (const dir of fs.readdirSync(WB_DIR).sort((a, b) => dirMtime(path.join(WB_DIR, b)) - dirMtime(path.join(WB_DIR, a)))) {
    const dp = path.join(WB_DIR, dir);
    let stat; try { stat = fs.statSync(dp); } catch (e) { continue; }
    if (!stat.isDirectory()) continue;
    let fl; try { fl = fs.readdirSync(dp).sort((a, b) => { try { return fs.statSync(path.join(dp, b)).mtimeMs - fs.statSync(path.join(dp, a)).mtimeMs; } catch (e) { return 0; } }); } catch (e) { continue; }
    for (const f of fl) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dp, f);
      let s; try { s = fs.statSync(fp); } catch (e) { continue; }
      if (now - s.mtimeMs > WB_WINDOW_MS && (wb.warmed || wb.off.has(fp))) continue;
      if (now - s.mtimeMs > WB_WINDOW_MS && !wb.off.has(fp) && wb.warmed) continue;
      let size = s.size;
      let prev = wb.off.get(fp) || 0;
      if (size < prev) prev = 0;                       // 截断重写：整读
      if (size === prev && wb.off.has(fp)) continue;   // 无增量
      if (!wb.warmed && prev === 0 && now - s.mtimeMs > WB_WINDOW_MS) { wb.off.set(fp, size); continue; }
      try {
        const fd = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(size - prev);
        fs.readSync(fd, buf, 0, size - prev, prev);
        fs.closeSync(fd);
        const text = buf.toString('utf8');
        const nl = text.lastIndexOf('\n');
        if (nl < 0) continue;
        const full = text.slice(0, nl);
        wb.off.set(fp, prev + Buffer.byteLength(full) + 1);
        for (const ln of full.split('\n')) {
          if (ln.indexOf('"usage"') < 0) continue;     // 快路径：多数行无 usage
          try { wbLine(JSON.parse(ln)); } catch (e) {}
        }
      } catch (e) { /* 单文件失败不致命 */ }
      if (Date.now() - t0 > budgetMs) return;          // 时间片用尽，下轮续
    }
  }
  if (!wb.warmed) wb.warmed = true;
}

// ── DSH 会话扫描器（DeepSeek Harness，zstd 归档）──
// 文件随会话保存整写重压，字节 offset 失效：按 mtime+size 判脏，整包解压后行指纹去重，
// 重复解析只补新增行、不双计。usage 在 type=assistant/* 行的 data.usage，模型取
// data.message.source 的 provider:model（csu=走校园网关配额，workbuddy-global=官方通道）。
const zlib = require('zlib');
const dsh = { st: new Map(), warmed: !DSH_DIR || !fs.existsSync(DSH_DIR), days: new Map(), total: { in: 0, out: 0, cached: 0, cost: 0, n: 0 }, models: new Map() };
function dshListFiles() {
  const out = [];
  if (!DSH_DIR) return out;
  let ws; try { ws = fs.readdirSync(DSH_DIR); } catch (e) { return out; }
  for (const w of ws) {
    const wp = path.join(DSH_DIR, w);
    let es; try { es = fs.readdirSync(wp); } catch (e) { continue; }
    for (const e2 of es) {
      const sp = path.join(wp, e2);
      let st; try { st = fs.statSync(sp); } catch (e) { continue; }
      if (st.isFile()) { if (e2.endsWith('.jsonl.zstd')) out.push(sp); }
      else if (st.isDirectory()) {
        let fl; try { fl = fs.readdirSync(sp); } catch (e) { continue; }
        for (const f of fl) if (f.endsWith('.jsonl.zstd')) out.push(path.join(sp, f));
      }
    }
  }
  out.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (e) { return 0; } });
  return out;
}
function dshFeed(fp, text, prev) {
  const keys = prev ? prev.keys : new Set();
  for (const ln of text.split('\n')) {
    if (ln.indexOf('"usage"') < 0) continue;             // 快路径：多数行无 usage
    let o; try { o = JSON.parse(ln); } catch (e) { continue; }
    if (typeof o.type !== 'string' || o.type.indexOf('assistant/') !== 0) continue;
    const da = o.data; if (!da || !da.usage) continue;
    const k = ln.length + '#' + zlib.crc32(ln);          // 行指纹：整写重写后识别旧行
    if (keys.has(k)) continue;
    keys.add(k);
    const u = da.usage;
    const src = (da.message && da.message.source) || {};
    const model = (src.provider ? src.provider + ':' : '') + (src.model || 'unknown');
    addRec(dsh, o.time || Date.now(), model, u.inputTokens || 0, u.cacheReadTokens || 0, u.outputTokens || 0);
  }
}
// DSH 的 .zstd 是「每次落盘追加一帧」的多帧拼接流，Node 内建 zstd 流只认单帧，
// 故按 RFC8878 手工切帧（帧头定长字段 + 块链扫到 Last_Block + 帧尾校验和），逐帧解压拼接。
function zstdFrameLen(buf, p) {
  const start = p; p += 4;
  const fhd = buf[p++];
  const fcsField = fhd >> 6, singleSeg = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictIdFlag = fhd & 3;
  if (!singleSeg) p += 1;                                        // Window_Descriptor 定长 1 字节
  p += [0, 1, 2, 4][dictIdFlag];                                 // Dictionary_ID
  p += fcsField === 0 ? (singleSeg ? 1 : 0) : [0, 2, 4, 8][fcsField];  // Frame_Content_Size
  for (;;) {
    const bh = buf.readUIntLE(p, 3); p += 3;
    const last = bh & 1, type = (bh >> 1) & 3, size = bh >> 3;
    if (type === 3) throw new Error('zstd 保留块类型');
    p += type === 1 ? 1 : size;                                  // RLE 块体 1 字节；Raw/Compressed 走 size
    if (last) break;
  }
  if (checksum) p += 4;                                          // 帧尾 xxhash64
  return p - start;
}
function zstdDecodeMulti(buf) {
  const parts = []; let p = 0;
  while (p + 4 <= buf.length) {
    const magic = buf.readUInt32LE(p);
    if (magic === 0xfd2fb528) {
      const len = zstdFrameLen(buf, p);
      parts.push(zlib.zstdDecompressSync(buf.subarray(p, p + len)));
      p += len;
    } else if (magic === 0x184d2a5e) {                           // skippable 帧
      p += 8 + buf.readUInt32LE(p + 4);
    } else break;                                                // 半写入的尾帧：下轮再读
  }
  return Buffer.concat(parts);
}
const dshDecompress = (fp) => Promise.resolve(zstdDecodeMulti(fs.readFileSync(fp)).toString('utf8'));
let dshBusy = false;
async function dshScan(budgetMs) {                       // 单轮预算内处理尽量多的"脏"文件，大文件下轮续
  if (dshBusy) return; dshBusy = true;
  const t0 = Date.now();
  try {
    for (const fp of dshListFiles()) {
      let s; try { s = fs.statSync(fp); } catch (e) { continue; }
      if (s.size > DSH_FILE_MAX) continue;
      const prev = dsh.st.get(fp);
      if (prev && prev.m === s.mtimeMs && prev.z === s.size) continue;   // 未变化
      try { dshFeed(fp, (await dshDecompress(fp)).toString('utf8'), prev); }
      catch (e) { /* 半写入损坏的归档：记住指纹跳过，下轮再试 */ }
      dsh.st.set(fp, { m: s.mtimeMs, z: s.size, keys: (prev && prev.keys) || new Set() });
      if (Date.now() - t0 > budgetMs) return;
    }
    dsh.warmed = true;
  } finally { dshBusy = false; }
}

// ── Codex 会话扫描器（rollout-*.jsonl 追加写，字节 offset 增量）──
// 用量在 event_msg/token_count 行的 payload.info.last_token_usage（每请求增量，
// total_token_usage 是会话累计不能用）；total = input + cached + output + reasoning。
// 模型名取 turn_context.payload.model 并跨行保留；pricing 复用全局 USAGE_PRICED_MODEL 机制。
const codex = { off: new Map(), st: new Map(), warmed: !CODEX_DIRS.length, days: new Map(), total: { in: 0, out: 0, cached: 0, cost: 0, n: 0 }, models: new Map() };
function codexListFiles() {
  const out = [];
  for (const dir of CODEX_DIRS) {
    let ws; try { ws = fs.readdirSync(dir); } catch (e) { continue; }
    for (const w of ws) {
      const p1 = path.join(dir, w);
      let st1; try { st1 = fs.statSync(p1); } catch (e) { continue; }
      if (st1.isFile()) { if (w.endsWith('.jsonl')) out.push(p1); continue; }      // archived_sessions 平铺
      let ms; try { ms = fs.readdirSync(p1); } catch (e) { continue; }
      for (const m2 of ms) {
        const p2 = path.join(p1, m2);
        let st2; try { st2 = fs.statSync(p2); } catch (e) { continue; }
        if (st2.isFile()) { if (m2.endsWith('.jsonl')) out.push(p2); continue; }
        let fl; try { fl = fs.readdirSync(p2); } catch (e) { continue; }           // sessions/YYYY/MM/DD 三层
        for (const f of fl) if (f.endsWith('.jsonl')) out.push(path.join(p2, f));
      }
    }
  }
  out.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (e) { return 0; } });
  return out;
}
function codexLine(r, st) {
  const p = r.payload; if (!p) return;
  if (r.type === 'turn_context' && p.model) st.model = p.model;
  else if (r.type === 'session_meta' && p.model && !st.model) st.model = p.model;
  if (r.type !== 'event_msg' || p.type !== 'token_count') return;
  const u = p.info && p.info.last_token_usage; if (!u) return;
  const inp = u.input_tokens || 0, cache = u.cached_input_tokens || 0;
  const outp = (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);   // 计费含思考段
  if (!inp && !cache && !outp) return;
  addRec(codex, r.timestamp || Date.now(), st.model || 'unknown', inp, cache, outp);
}
function codexScan(budgetMs) {
  const t0 = Date.now();
  for (const fp of codexListFiles()) {
    let s; try { s = fs.statSync(fp); } catch (e) { continue; }
    let prev = codex.off.get(fp) || 0;
    if (s.size < prev) prev = 0;                        // 截断重写：整读
    if (s.size === prev && codex.off.has(fp)) continue; // 无增量
    try {
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(s.size - prev);
      fs.readSync(fd, buf, 0, s.size - prev, prev);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const nl = text.lastIndexOf('\n');
      if (nl < 0) continue;                             // 不足一行，下轮再读
      const full = text.slice(0, nl);
      codex.off.set(fp, prev + Buffer.byteLength(full) + 1);
      let st = codex.st.get(fp); if (!st) { st = { model: '' }; codex.st.set(fp, st); }
      for (const ln of full.split('\n')) {
        if (ln.indexOf('"token_count"') < 0 && ln.indexOf('"turn_context"') < 0) continue;
        try { codexLine(JSON.parse(ln), st); } catch (e) {}
      }
    } catch (e) { /* 单文件失败不致命 */ }
    if (Date.now() - t0 > budgetMs) return;
  }
  if (!codex.warmed) codex.warmed = true;
}

let cache = { at: 0, data: null };
function collect() {
  if (Date.now() - cache.at < 3000 && cache.data) return cache.data;
  wbScan(400);
  codexScan(200);   // Codex 会话同步增量（文件少、单轮足够）
  const days = new Map();
  const models = new Map();
  let n = 0;
  const add = (ts, m, ti, to, c, countMsg) => {
    const key = bjDate(ts);
    const rec = days.get(key) || { in: 0, out: 0, cost: 0, n: 0, models: {} };
    rec.in += ti; rec.out += to; rec.cost += c || 0;
    if (countMsg) rec.n++;
    const f = fam(m);
    const mb = rec.models[f] || (rec.models[f] = { tin: 0, tcache: 0, tout: 0 });
    mb.tin += ti; mb.tout += to;                       // 附加源无缓存回报：tcache 恒 0
    days.set(key, rec);
    const g = models.get(f) || (models.set(f, { tin: 0, tcache: 0, tout: 0, cost: 0 }), models.get(f));
    g.tin += ti; g.tout += to; g.cost += c || 0;
    if (countMsg) n++;
  };
  for (const f of EXTRA) {
    if (!fs.existsSync(f)) continue;
    for (const ln of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!ln.trim()) continue;
      let r; try { r = JSON.parse(ln); } catch (e) { continue; }
      const ti = (r.tokens && r.tokens.in) || 0, to = (r.tokens && r.tokens.out) || 0;
      if (r.tokensByModel && Object.keys(r.tokensByModel).length) {
        for (const [m, v] of Object.entries(r.tokensByModel)) add(r.ts, m, v.tin || 0, v.tout || 0, v.cost || 0, false);
        const dk = bjDate(r.ts); const drec = days.get(dk); if (drec) { drec.n++; n++; }
      } else add(r.ts, 'unknown', ti, to, r.costCNY || 0, true);
    }
  }
  // transcript 并入：按真实模型名聚线（与附加源同名模型合并，两源物理隔离不重复计数）
  if (wb.total.n) {
    for (const [k, d] of wb.days) {
      const rec = days.get(k) || { in: 0, out: 0, cost: 0, n: 0, models: {} };
      rec.in += d.in; rec.out += d.out; rec.cost += d.cost; rec.n += d.n;
      for (const [m, v] of Object.entries(d.models)) {
        const mb = rec.models[m] || (rec.models[m] = { tin: 0, tcache: 0, tout: 0 });
        mb.tin += v.tin; mb.tcache += v.tcache; mb.tout += v.tout;
      }
      days.set(k, rec);
    }
    for (const [m, v] of wb.models) {
      const g = models.get(m) || (models.set(m, { tin: 0, tcache: 0, tout: 0, cost: 0 }), models.get(m));
      g.tin += v.tin; g.tcache = (g.tcache || 0) + v.tcache; g.tout += v.tout; g.cost += v.cost;
    }
    n += wb.total.n;
  }
  // DSH 并入：与 transcript 同款三桶聚合（模型名带 provider 前缀，与 WB 模型天然不重名、不串账）
  if (dsh.total.n) {
    for (const [k, d] of dsh.days) {
      const rec = days.get(k) || { in: 0, out: 0, cost: 0, n: 0, models: {} };
      rec.in += d.in; rec.out += d.out; rec.cost += d.cost; rec.n += d.n;
      for (const [m, v] of Object.entries(d.models)) {
        const mb = rec.models[m] || (rec.models[m] = { tin: 0, tcache: 0, tout: 0 });
        mb.tin += v.tin; mb.tcache += v.tcache; mb.tout += v.tout;
      }
      days.set(k, rec);
    }
    for (const [m, v] of dsh.models) {
      const g = models.get(m) || (models.set(m, { tin: 0, tcache: 0, tout: 0, cost: 0 }), models.get(m));
      g.tin += v.tin; g.tcache = (g.tcache || 0) + v.tcache; g.tout += v.tout; g.cost += v.cost;
    }
    n += dsh.total.n;
  }
  // Codex 并入：同款三桶聚合（rollout 与 transcript/dsh 物理隔离不重叠）
  if (codex.total.n) {
    for (const [k, d] of codex.days) {
      const rec = days.get(k) || { in: 0, out: 0, cost: 0, n: 0, models: {} };
      rec.in += d.in; rec.out += d.out; rec.cost += d.cost; rec.n += d.n;
      for (const [m, v] of Object.entries(d.models)) {
        const mb = rec.models[m] || (rec.models[m] = { tin: 0, tcache: 0, tout: 0 });
        mb.tin += v.tin; mb.tcache += v.tcache; mb.tout += v.tout;
      }
      days.set(k, rec);
    }
    for (const [m, v] of codex.models) {
      const g = models.get(m) || (models.set(m, { tin: 0, tcache: 0, tout: 0, cost: 0 }), models.get(m));
      g.tin += v.tin; g.tcache = (g.tcache || 0) + v.tcache; g.tout += v.tout; g.cost += v.cost;
    }
    n += codex.total.n;
  }
  let tin = 0, tout = 0, cost = 0;
  for (const d of days.values()) { tin += d.in; tout += d.out; cost += d.cost; }
  let L = {};
  try { L = JSON.parse(fs.readFileSync(path.join(ROOT, 'ledger.json'), 'utf-8')); } catch (e) {}
  const items = [];
  for (const [k, v] of Object.entries(L)) if (v && typeof v.costCNY === 'number') items.push([k, v.costCNY]);
  const ledgerTotal = items.length ? +items.reduce((s, x) => s + x[1], 0).toFixed(2) : null;
  const todayK = bjDate(Date.now());
  const today = days.get(todayK) || { in: 0, out: 0, cost: 0, n: 0, models: {} };
  const wbToday = wb.days.get(todayK) || { in: 0, out: 0, cached: 0, cost: 0, n: 0 };
  const dshToday = dsh.days.get(todayK) || { in: 0, out: 0, cached: 0, cost: 0, n: 0 };
  const codexToday = codex.days.get(todayK) || { in: 0, out: 0, cached: 0, cost: 0, n: 0 };
  const mSort = (m) => [...m.entries()].sort((a, b) => (b[1].tin + (b[1].tcache || 0) + b[1].tout) - (a[1].tin + (a[1].tcache || 0) + a[1].tout)).map(([k, v]) => ({ m: k, ...v }));
  const dArr = (store) => [...store.days.entries()].sort().map(([d, v]) => ({ d, ...v }));
  cache = { at: Date.now(), data: {
    updated: new Date().toLocaleString('zh-CN'),
    extra: EXTRA.length,
    today, total: { in: tin, out: tout, cost, n },
    wb: { warmed: wb.warmed, today: wbToday, total: wb.total },
    dsh: { warmed: dsh.warmed, today: dshToday, total: dsh.total },
    codex: { warmed: codex.warmed, today: codexToday, total: codex.total },
    bySrc: {
      wb: { days: dArr(wb), models: mSort(wb.models), total: { ...wb.total }, today: { ...wbToday } },
      dsh: { days: dArr(dsh), models: mSort(dsh.models), total: { ...dsh.total }, today: { ...dshToday } },
      codex: { days: dArr(codex), models: mSort(codex.models), total: { ...codex.total }, today: { ...codexToday } },
    },
    days: [...days.entries()].sort().map(([d, v]) => ({ d, ...v })),
    models: mSort(models),
    ledger: { totalCost: ledgerTotal, items, since: L.since },
  } };
  return cache.data;
}

const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Token 用量统计</title><style>
:root{color-scheme:dark}*{box-sizing:border-box;margin:0}
body{background:#0d1117;color:#dbe4f3;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;padding:26px 30px;max-width:880px;margin:0 auto}
h1{font-size:18px;font-weight:600}
.sub{color:#7d8aa5;font-size:12px;margin:2px 0 16px}
#pulse{width:7px;height:7px;border-radius:50%;background:#3d4c6e;display:inline-block;margin-right:6px}
#pulse.on{background:#7ee0a3;animation:p 1.6s infinite}@keyframes p{50%{opacity:.35}}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px;margin-bottom:14px}
.mt{background:#131a29;border:1px solid #223052;border-radius:12px;padding:10px 12px}
.mt .lb{color:#7d8aa5;font-size:11px}.mt .v{font-size:16px;font-weight:700;color:#7ee0a3;font-variant-numeric:tabular-nums}.mt .v.b{color:#4c8dff}.mt .v.p{color:#c792ea}
.panel{background:#131a29;border:1px solid #223052;border-radius:14px;padding:16px 18px;margin-bottom:14px}
.pt{font-size:13.5px;color:#dbe4f3;font-weight:600;margin-bottom:2px;display:flex;justify-content:space-between;align-items:center}
.desc{color:#667391;font-size:11.5px;margin-bottom:10px}
.pills{display:inline-flex;background:#0f1626;border:1px solid #223052;border-radius:8px;padding:2px;gap:2px}
.pills button{background:transparent;border:none;color:#7d8aa5;font-size:11.5px;padding:2px 10px;border-radius:6px;cursor:pointer}
.pills button.on{background:#233150;color:#dbe4f3}
.tfam{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.tpill{display:inline-flex;align-items:center;gap:5px;background:#0f1626;border:1px solid #223052;color:#aab6cf;font-size:11px;padding:3px 9px;border-radius:14px;cursor:pointer;user-select:none;transition:opacity .15s}
.tpill i{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.tpill:hover{border-color:#33436b}
.tpill.off{opacity:.38;text-decoration:line-through}
.tpill.rst{color:#7ee0a3;border-color:#25443a}
.hmgrid{display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;grid-auto-columns:12px;gap:3px;overflow-x:auto;padding-bottom:2px}
.hc{width:12px;height:12px;border-radius:3px;background:transparent;position:relative}
.hc.fill{background:#182032}
.mlabels{display:flex;color:#667391;font-size:10px;margin-top:5px;position:relative;min-height:14px}
.legend{display:flex;gap:6px;align-items:center;color:#667391;font-size:11px;margin-top:7px}
.legend i{width:11px;height:11px;border-radius:3px;display:inline-block}
svg{width:100%;display:block}.ax{fill:#667391;font-size:10px}
.flex{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.mods{flex:1;min-width:240px}
.mrow{display:grid;grid-template-columns:10px 96px 1fr 150px;gap:8px;align-items:center;padding:5px 0;font-size:12.5px}
.dot{width:9px;height:9px;border-radius:50%}
.mv{color:#9fb2d8;text-align:right;font-variant-numeric:tabular-nums;font-size:12px}
.mv small{color:#667391}
.coins{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.coin{background:#101827;border:1px solid #223052;border-radius:12px;padding:10px 14px}
.coin .lb{font-size:11px;color:#7d8aa5}.coin .v{font-size:15px;font-weight:650;font-variant-numeric:tabular-nums}
.foot{color:#57637e;font-size:11px;margin-top:4px}
#tip{position:fixed;pointer-events:none;background:#1b2436;border:1px solid #33415f;border-radius:10px;padding:7px 11px;font-size:12px;color:#dbe4f3;display:none;z-index:9;box-shadow:0 6px 20px rgba(0,0,0,.5);white-space:pre-line}
@media(max-width:760px){.coins{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<h1>Token 用量统计</h1>
<div class="sub">逐条精确 Token 统计 · 每 5 秒自动刷新 <span id="pulse"></span> · <span id="upd"></span></div>
<div style="margin:-6px 0 12px"><span class="pills" id="srcp"><button data-s="all" class="on">全部来源</button><button data-s="wb">WorkBuddy</button><button data-s="dsh">DSH</button><button data-s="codex">Codex</button></span></div>
<div class="metrics" id="metrics"></div>
<div class="panel"><div class="pt">Token 活跃 <span class="desc" id="hmMax"></span></div>
<div class="hmgrid" id="hm"></div><div class="mlabels" id="hmM"></div>
<div class="legend">少 <i style="background:#182032"></i><i style="background:rgba(29,78,216,.4)"></i><i style="background:rgba(76,141,255,.55)"></i><i style="background:#4c8dff"></i><i style="background:#7ee0a3"></i> 多</div></div>
<div class="panel"><div class="pt">每日 Token 趋势图 <span class="pills" id="rng"><button data-n="7" class="on">近 7 日</button><button data-n="30">近 30 日</button></span></div>
<div class="desc" id="tinfo"></div><div class="tfam" id="tfam"></div><div id="trend"></div></div>
<div class="panel"><div class="pt">模型用量</div><div class="desc">各数据源按真实模型名合并（token 无重叠：数据源物理隔离）</div>
<div class="flex"><div id="pie" style="width:230px"></div><div class="mods" id="mods"></div></div></div>
<div class="panel"><div class="pt">模型 Token 分解</div><div class="desc">点选模型查看输入未缓存 / 输入缓存命中 / 输出的条形占比（缓存数据取决于来源是否回报）</div>
<div class="pills" id="msel" style="flex-wrap:wrap;margin:4px 0 12px"></div><div id="mbars"></div></div>
<div class="panel"><div class="pt">费用 <span class="desc" id="coinsSince"></span></div><div class="coins" id="coins"></div>
<div class="desc" style="margin-top:8px">费用只对配置了价目的模型折算（缓存命中按命中价）；无价目模型只计 token 不折钱。</div></div>
<div class="foot">数据源：WorkBuddy 会话 transcript + DSH 会话 zstd 归档 + Codex rollout jsonl（顶部可拆分查看；可选扩展：附加 JSONL / ledger.json） · node usage-server.js</div>
<div id="tip"></div>
<script>
var COL={Qwen:'#4c8dff','custom-local:Qwen':'#8fb8ff',DeepSeek:'#f0b35c',GLM:'#7ee0a3',unknown:'#667391'};
var PAL=['#4c8dff','#7ee0a3','#f0b35c','#c792ea','#5fd4d4','#e07bb0','#a78bfa','#f472b6','#facc15','#6ee7b7','#8fb8ff','#fb923c','#667391'];
function colOf(m,i){return COL[m]||PAL[i%PAL.length]}
var D=null, RANGE=7, THIDE={}, SELM=decodeURIComponent((location.hash||'').replace(/^#/,''));
var SRC='all';   // 数据源视图：all / wb / dsh
function view(D){ if(SRC!=='all'&&D.bySrc&&D.bySrc[SRC])return D.bySrc[SRC]; return {days:D.days,models:D.models,total:D.total,today:D.today}; }
function fN(v){return v>=1e8?(v/1e8).toFixed(2)+' 亿':v>=1e4?(v/1e4).toFixed(1)+' 万':String(v)}
function fY(v){return '¥'+v.toLocaleString('zh-CN',{maximumFractionDigits:v>=100?0:2})}
var tip=document.getElementById('tip');
function showTip(e,txt){tip.textContent=txt;tip.style.display='block';tip.style.left=Math.min(e.clientX+14,innerWidth-200)+'px';tip.style.top=(e.clientY+12)+'px'}
function hideTip(){tip.style.display='none'}
function shade(r){return r<=0?'#182032':r<.15?'rgba(29,78,216,.4)':r<.4?'rgba(76,141,255,.55)':r<.75?'#4c8dff':'#7ee0a3'}
function streak(days){var set={};for(var i=0;i<days.length;i++)set[days[i].d]=1;var best=0;var t=new Date();
  for(var k=0;k<400;k++){var s=new Date(t.getTime()-k*864e5+8*36e5).toISOString().slice(0,10);
  if(set[s]){best++}else if(k>0&&best>0)break}return best}
function metrics(v,D){
  var tot=v.total.in+v.total.out;
  var topM=v.models[0]?v.models[0].m:'-';
  var ct=0,ca=0;   // 缓存命中按当前源视图累加
  if((SRC==='all'||SRC==='wb')&&D.wb){ct+=D.wb.today.cached;ca+=D.wb.total.cached}
  if((SRC==='all'||SRC==='dsh')&&D.dsh){ct+=D.dsh.today.cached;ca+=D.dsh.total.cached}
  if((SRC==='all'||SRC==='codex')&&D.codex){ct+=D.codex.today.cached;ca+=D.codex.total.cached}
  var items=[['Token 消耗总量',fN(tot),''],['今日 Token',fN(v.today.in+v.today.out),'']];
  if(D.extra){var wbT=D.wb?D.wb.today:{in:0,out:0},dsT=D.dsh?D.dsh.today:{in:0,out:0},cdX=D.codex?D.codex.today:{in:0,out:0};
    items.push(['WorkBuddy 今日',fN(wbT.in+wbT.out),'p'],['DSH 今日',fN(dsT.in+dsT.out),'b'],['Codex 今日',fN(cdX.in+cdX.out),''],['附加源今日',fN((D.today.in+D.today.out)-(wbT.in+wbT.out)-(dsT.in+dsT.out)-(cdX.in+cdX.out)),''])}
  items=items.concat([
   ['缓存命中·今日',fN(ct),'p'],['缓存命中·累计',fN(ca),'p'],['对话数',v.total.n.toLocaleString('zh-CN'),'b'],
   ['活跃天数',v.days.length,''],['连续活跃',streak(v.days)+' 天',''],['主力模型',topM,'']]);
  document.getElementById('metrics').innerHTML=items.map(function(x){return '<div class="mt"><div class="lb">'+x[0]+'</div><div class="v '+x[2]+'">'+x[1]+'</div></div>'}).join('');
}
function heatmap(d){
  var byDay={};for(var i=0;i<d.days.length;i++){var x=d.days[i];byDay[x.d]=(x.in+x.out)}
  var maxV=1;for(var k in byDay)if(byDay[k]>maxV)maxV=byDay[k];
  document.getElementById('hmMax').textContent='峰值单日 '+fN(maxV);
  var grid=[];var now=new Date(Date.now()+8*36e5);
  var dow=now.getUTCDay();
  var todayStr=now.toISOString().slice(0,10);
  var startT=new Date(now.getTime()-(dow+51*7)*864e5);
  startT=new Date(Date.UTC(startT.getUTCFullYear(),startT.getUTCMonth(),startT.getUTCDate()));
  var cur=startT,prevM=-1,mlab='';
  for(var col=0;col<52;col++){
    for(var row=0;row<7;row++){
      var s=cur.toISOString().slice(0,10);
      if(s>todayStr){grid.push('<div class="hc"></div>')}
      else{var v=byDay[s]||0;var r=v?Math.pow(v/maxV,.45):0;
        grid.push('<div class="hc fill" style="background:'+(v?shade(r):'#182032')+'" data-k="'+s+' '+(v?fN(v)+' tok':'0 tok')+'"></div>')}
      cur=new Date(cur.getTime()+864e5);
    }
    var m0=new Date(cur.getTime()-7*864e5);
    if(m0.getUTCMonth()!==prevM){prevM=m0.getUTCMonth();
      if(m0.getUTCMonth()===0)mlab+='<span style="position:absolute;left:'+(col*15)+'px">'+(m0.getUTCFullYear())+'年</span>';
      else mlab+='<span style="position:absolute;left:'+(col*15)+'px">'+(m0.getUTCMonth()+1)+'月</span>';
    }
  }
  var hm=document.getElementById('hm');hm.innerHTML=grid.join('');
  document.getElementById('hmM').innerHTML=mlab;
  hm.onmousemove=function(e){var t=e.target;if(t.dataset.k)showTip(e,t.dataset.k.replace(/ /,'\\n'));else hideTip()};
  hm.onmouseleave=hideTip;
}
function trend(d){
  var rows=d.days.slice(-RANGE);
  var W2=function(mb){return (mb.tin||0)+(mb.tcache||0)+(mb.tout||0)};
  var fcol=function(f){return COL[f]||'#667391'};
  var famTot={};for(var i=0;i<rows.length;i++)for(var f in rows[i].models)famTot[f]=(famTot[f]||0)+W2(rows[i].models[f]);
  var fl=Object.keys(famTot).sort(function(a,b){return famTot[b]-famTot[a]});
  var shown=fl.filter(function(f){return !THIDE[f]});
  var anyHidden=shown.length!==fl.length;
  var pills=fl.map(function(f){return '<span class="tpill'+(THIDE[f]?' off':'')+'" data-f="'+encodeURIComponent(f)+'"><i style="background:'+fcol(f)+'"></i>'+f+'</span>'}).join('');
  if(anyHidden)pills+='<span class="tpill rst" data-f="__all">全部显示</span>';
  var tfam=document.getElementById('tfam');tfam.innerHTML=pills;
  var maxV=1;for(var i=0;i<rows.length;i++)for(var j=0;j<shown.length;j++){var mb=rows[i].models[shown[j]]||{};var w=W2(mb);if(w>maxV)maxV=w}
  var pk=rows.reduce(function(a,b){return (b.in+b.out)>(a.in+a.out)?b:a},{d:'-',in:0,out:0});
  document.getElementById('tinfo').textContent='共 '+d.days.length+' 天 · 峰值 '+pk.d.slice(5)+' '+fN(pk.in+pk.out)+' · '+(anyHidden?('已选 '+shown.length+'/'+fl.length+' 个模型 · Y 轴随所选定标（点模型名可显示/隐藏）'):'Y 轴按单模型折线峰值定标 · 点下方模型名可筛选');
  var W=680,H=185,P=46;
  var xs=function(i){return rows.length<2?W/2:P+i*(W-P*2)/(rows.length-1)};
  var ys=function(v){return H-28-(v/maxV)*(H-56)};
  var svg='<svg viewBox="0 0 '+W+' '+H+'">';
  svg+='<text x="6" y="16" class="ax">'+fN(maxV)+'</text><text x="6" y="'+(H-24)+'" class="ax">0</text>';
  for(var j=0;j<shown.length;j++){var f=shown[j];var col=fcol(f);var pts=[];
    for(var i=0;i<rows.length;i++){var mb2=rows[i].models[f]||{};pts.push(xs(i).toFixed(1)+','+ys(W2(mb2)).toFixed(1))}
    svg+='<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+col+'" stroke-width="2"/>';
    for(var i=0;i<rows.length;i++){var mb3=rows[i].models[f]||{};var v2=W2(mb3);
      svg+='<circle cx="'+xs(i).toFixed(1)+'" cy="'+ys(v2).toFixed(1)+'" r="3" fill="'+col+'" data-k="'+rows[i].d+'\\n'+f+': '+fN(v2)+' tok"/>'}
  }
  svg+='<line x1="'+P+'" y1="'+(H-28)+'" x2="'+(W-P)+'" y2="'+(H-28)+'" stroke="#2a3350"/>';
  for(var i=0;i<rows.length;i++){var st=RANGE===7?1:Math.ceil(rows.length/8);
    if(i%st===0)svg+='<text x="'+xs(i).toFixed(1)+'" y="'+(H-10)+'" class="ax" text-anchor="middle">'+rows[i].d.slice(5)+'</text>'}
  svg+='</svg>';
  var el=document.getElementById('trend');el.innerHTML=svg;
  el.onmousemove=function(e){var t=e.target;if(t.dataset.k)showTip(e,t.dataset.k);else hideTip()};
  el.onmouseleave=hideTip;
}
function pie(d){
  var T=function(x){return (x.tin||0)+(x.tcache||0)+(x.tout||0)};
  var ms=d.models.slice(0,6);if(d.models.length>6){var o={m:'其他模型',tin:0,tcache:0,tout:0};for(var oi=6;oi<d.models.length;oi++){o.tin+=d.models[oi].tin||0;o.tcache+=d.models[oi].tcache||0;o.tout+=d.models[oi].tout||0}ms.push(o)}
  var tot=0;for(var i=0;i<ms.length;i++)tot+=T(ms[i]);
  var cx=115,cy=115,R=92,r=52,a=-Math.PI/2,paths='';
  for(var i=0;i<ms.length;i++){var frac=T(ms[i])/(tot||1);var a2=a+frac*2*Math.PI;
    var lg=frac>.5?1:0;
    var p1=[cx+R*Math.cos(a),cy+R*Math.sin(a)],p2=[cx+R*Math.cos(a2),cy+R*Math.sin(a2)];
    var q1=[cx+r*Math.cos(a2),cy+r*Math.sin(a2)],q2=[cx+r*Math.cos(a),cy+r*Math.sin(a)];
    paths+='<path d="M'+p1+' A '+R+' '+R+' 0 '+lg+' 1 '+p2+' L '+q1+' A '+r+' '+r+' 0 '+lg+' 0 '+q2+' Z" fill="'+colOf(ms[i].m,i)+'" opacity=".9" data-k="'+ms[i].m+'\\n'+fN(T(ms[i]))+' tok · '+(frac*100).toFixed(1)+'%'+(ms[i].tcache>1e4?'\\n缓存命中 '+fN(ms[i].tcache):'')+'"/>';
    a=a2;}
  var el=document.getElementById('pie');
  el.innerHTML='<svg viewBox="0 0 230 230">'+paths+'<text x="115" y="110" text-anchor="middle" style="fill:#dbe4f3;font-size:15px;font-weight:700">'+fN(tot)+'</text><text x="115" y="130" text-anchor="middle" class="ax">tokens</text></svg>';
  el.onmousemove=function(e){var t=e.target;if(t.dataset.k)showTip(e,t.dataset.k);else hideTip()};
  el.onmouseleave=hideTip;
  document.getElementById('mods').innerHTML=ms.map(function(x,i){
    var tt=T(x);return '<div class="mrow"><span class="dot" style="background:'+colOf(x.m,i)+'"></span><b>'+x.m+'</b>'+
    '<div style="background:#1b2436;border-radius:5px;height:9px"><div style="width:'+(100*tt/(tot||1)).toFixed(1)+'%;height:100%;border-radius:5px;background:'+colOf(x.m,i)+'"></div></div>'+
    '<span class="mv">'+fN(tt)+' <small>'+(100*tt/(tot||1)).toFixed(1)+'%'+(x.tcache>1e4?' · 含缓存'+fN(x.tcache):'')+'</small></span></div>'}).join('');
}
// 模型 Token 分解条形图（点选模型 → 输入未缓存 / 输入缓存命中 / 输出 三段）
function breakdown(d){
  var sel=SELM;if(!sel||!d.models.some(function(m){return m.m===sel}))sel=d.models.length?d.models[0].m:'';
  var box=document.getElementById('msel'),area=document.getElementById('mbars');
  box.innerHTML=d.models.map(function(m){return '<button data-m="'+m.m+'" class="'+(m.m===sel?'on':'')+'">'+m.m+'</button>'}).join('');
  var m=d.models.filter(function(x){return x.m===sel})[0];
  if(!m){area.innerHTML='<span class="desc">暂无数据</span>';return}
  var unc=m.tin||0,cach=m.tcache||0,outp=m.tout||0,tot=unc+cach+outp;
  if(!tot){area.innerHTML='<span class="desc">该模型无 token 记录</span>';return}
  var segs=[['输入·未缓存',unc,'#4c8dff'],['输入·缓存命中',cach,cach?'#2f9e63':'transparent'],['输出',outp,'#f0b35c']];
  var html='<div style="display:flex;height:26px;border-radius:7px;overflow:hidden;background:#0f1626;border:1px solid #223052">';
  segs.forEach(function(s){if(s[1]<=0)return;var pc=100*s[1]/tot;if(pc>2.5)html+='<div style="width:'+pc+'%;background:'+s[2]+';display:flex;align-items:center;justify-content:center;font-size:11px;color:#0d1117;font-weight:600;white-space:nowrap;overflow:hidden">'+pc.toFixed(0)+'%</div>';else html+='<div style="width:'+pc+'%;background:'+s[2]+'" title="'+s[0]+'"></div>'});
  html+='</div><div class="legend" style="margin-top:9px;gap:16px">';
  segs.forEach(function(s){html+='<span><i style="background:'+s[2]+';margin-right:5px"></i>'+s[0]+' <b style="color:#dbe4f3">'+fN(s[1])+'</b> <small style="color:#667391">('+(100*s[1]/tot).toFixed(1)+'%)</small></span>'});
  html+='</div>';
  area.innerHTML=html;
}
function coins(d){
  var l=d.ledger;if(!l||l.totalCost==null){document.getElementById('coins').innerHTML='<span class="desc">未配置 ledger.json（费用面板可忽略）</span>';return}
  document.getElementById('coinsSince').textContent='账本统计期 '+(l.since||'')+' 起';
  var cells=[['账本合计',l.totalCost,'#7ee0a3']].concat(l.items.map(function(x){return [x[0],x[1],'']}));
  document.getElementById('coins').innerHTML=cells.map(function(x){
   return '<div class="coin"><div class="lb">'+x[0]+'</div><div class="v" style="color:'+(x[2]||'#dbe4f3')+'">'+fY(x[1])+'</div></div>'}).join('');
}
function render(){if(!D)return;var V=view(D);metrics(V,D);heatmap(V);trend(V);pie(V);breakdown(V);coins(D);
  document.getElementById('srcp').style.display=((D.dsh&&D.dsh.total.n)||(D.codex&&D.codex.total.n))?'':'none';   // DSH/Codex 均无数据时才收起来源开关
  var w=(D.wb&&D.wb.warmed&&D.dsh&&D.dsh.warmed)?'':'（历史数据正在预热扫描…）';
  document.getElementById('upd').textContent='最近刷新时间：'+D.updated+' '+w}
async function tick(){try{D=await (await fetch('/api/data')).json();document.getElementById('pulse').className='on';render()}catch(e){document.getElementById('pulse').className=''}}
document.getElementById('rng').onclick=function(e){var b=e.target.closest('button');if(!b)return;RANGE=+b.dataset.n;
  var bs=this.querySelectorAll('button');for(var i=0;i<bs.length;i++)bs[i].className=bs[i]===b?'on':'';if(D)trend(view(D))};
document.getElementById('srcp').onclick=function(e){var b=e.target.closest('button');if(!b)return;SRC=b.dataset.s;
  var bs=this.querySelectorAll('button');for(var i=0;i<bs.length;i++)bs[i].className=bs[i]===b?'on':'';if(D)render()};
document.getElementById('tfam').onclick=function(e){var b=e.target.closest('.tpill');if(!b)return;var f=b.dataset.f;
  if(f==='__all'){THIDE={}}else{var k=decodeURIComponent(f);if(THIDE[k])delete THIDE[k];else THIDE[k]=1}if(D)trend(view(D))};
document.getElementById('msel').onclick=function(e){var b=e.target.closest('button');if(!b)return;SELM=b.dataset.m;history.replaceState(null,'','#'+encodeURIComponent(SELM));if(D)breakdown(view(D))};
addEventListener('hashchange',function(){SELM=decodeURIComponent(location.hash.slice(1));if(D)breakdown(view(D))});
tick();setInterval(tick,5000);
</script></body></html>`;

function _elog(e){ try{ require('fs').appendFileSync(require('path').join(__dirname,'usage-server.err.log'), new Date().toISOString()+' '+((e&&(e.stack||e.message))||e)+'\n'); }catch(_){} }
process.on('uncaughtException', (e)=>_elog(e));
process.on('unhandledRejection', (r)=>_elog(r));
const IDLE_MS = +(process.env.USAGE_IDLE_MS || 0);   // >0：连续无访问超过该毫秒数则自退（按需启动场景）；0=常驻不关
let lastHit = Date.now();
const srv = http.createServer((req, res) => {
  lastHit = Date.now();
  try {
    if (req.url.startsWith('/api/data')) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(collect())); }
    else if (req.url === '/' || req.url.startsWith('/index')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); }
    else { res.writeHead(404); res.end(); }
  } catch (e) { _elog(e); try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"collect failed"}'); } catch (_) {} }
});
srv.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(0); _elog(e); });   // 已有实例在跑 → 静默退出（重复触发免疫）；其它监听错误仅记录不崩
srv.listen(PORT, '127.0.0.1', () => console.log('用量看板 http://127.0.0.1:' + PORT));
if (IDLE_MS > 0) setInterval(() => { if (Date.now() - lastHit > IDLE_MS) { _elog('空闲 ' + Math.round(IDLE_MS / 1000) + 's 无访问，自动退出'); process.exit(0); } }, 30000).unref();
// 启动即后台预热：不等前端轮询，主动多轮增量扫描直到完成（每轮预算 500ms，事件循环其余时间照常响应）
if (!wb.warmed) { const _warm = setInterval(() => { try { wbScan(500); } catch (e) { _elog(e); } if (wb.warmed) { clearInterval(_warm); _elog('预热完成 n=' + wb.total.n); } }, 150); _warm.unref(); }
// DSH 独立节拍：2s 一轮增量（内部防重入），运行期持续吸收新会话写入
const _dsh = setInterval(() => { dshScan(1200).catch((e) => _elog(e)); }, 2000); _dsh.unref();
dshScan(1200).catch((e) => _elog(e));
