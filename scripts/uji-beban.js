#!/usr/bin/env node
/*
 * UJI BEBAN CBT SMA Negeri 3 Buru — simulasi siswa & pengawas mengerjakan ujian bersamaan.
 *
 *   node scripts/uji-beban.js --siswa 500 --pengawas 15 --menit 5
 *
 * Skrip menyalakan SERVER TES TERPISAH (port 8199, database sementara), jadi data asli dan ujian
 * yang sedang berjalan tidak tersentuh. Tujuan selalu 127.0.0.1 — tidak ada opsi alamat luar.
 * Jalankan di luar jam ujian karena memakai tenaga VPS yang sama.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OPTIONS = {
  siswa: { def: 500, help: 'jumlah siswa tes' },
  pengawas: { def: 15, help: 'jumlah pengawas tes (= jumlah ruang)' },
  menit: { def: 5, help: 'lama uji (menit, boleh pecahan)' },
  datang: { def: 60, help: 'siswa datang bertahap selama N detik pertama' },
  port: { def: 8199, help: 'port server tes' }
};
const CLASS_NAME = 'XII IPA 1';
const PENGAWAS_PASSWORD = 'UjiBeban#2026';
const TARGET_PG = 40;
const POLL_SESSION_MS = 6000;   // sama dengan ujian.html
const POLL_ROOM_MS = 2500;      // sama dengan pengawas.html
const ANSWER_MIN_MS = 20000;
const ANSWER_MAX_MS = 40000;
const REQUEST_TIMEOUT_MS = 30000;

// ---------- argumen ----------
function parseArgs(argv) {
  const opts = Object.fromEntries(Object.entries(OPTIONS).map(([k, v]) => [k, v.def]));
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    const key = a.replace(/^--/, '');
    if (!a.startsWith('--') || !(key in OPTIONS)) {
      fail(`Opsi tidak dikenal: ${a}\nOpsi yang tersedia: ${Object.keys(OPTIONS).map(k => '--' + k).join(', ')}, --json`);
    }
    const val = Number(argv[++i]);
    if (!Number.isFinite(val) || val <= 0) fail(`Nilai untuk --${key} harus angka lebih dari 0.`);
    opts[key] = val;
  }
  opts.siswa = Math.round(opts.siswa);
  opts.pengawas = Math.max(1, Math.round(opts.pengawas));
  opts.port = Math.round(opts.port);
  return { opts, json };
}

function printHelp() {
  console.log('Uji beban CBT: node scripts/uji-beban.js [opsi]\n');
  for (const [k, v] of Object.entries(OPTIONS)) console.log(`  --${k.padEnd(9)} ${v.help} (bawaan ${v.def})`);
  console.log('  --json      cetak ringkasan sebagai JSON');
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

// ---------- utilitas ----------
const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
const rand = (min, max) => min + Math.random() * (max - min);
const pad = (n, w) => String(n).padStart(w, '0');

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

// ---------- statistik ----------
const stats = new Map();
const errorSamples = [];
function record(label, ms, ok, detail) {
  if (!stats.has(label)) stats.set(label, { times: [], errors: 0 });
  const s = stats.get(label);
  s.times.push(ms);
  if (!ok) {
    s.errors++;
    if (errorSamples.length < 15) errorSamples.push(`${label}: ${detail}`);
  }
}

function summarize(extra) {
  const endpoints = {};
  let all = [];
  let totalErrors = 0;
  for (const [label, s] of stats) {
    const sorted = s.times.slice().sort((a, b) => a - b);
    all = all.concat(s.times);
    totalErrors += s.errors;
    endpoints[label] = {
      count: s.times.length,
      errors: s.errors,
      median: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      max: Math.round(sorted[sorted.length - 1] || 0)
    };
  }
  all.sort((a, b) => a - b);
  const totalRequests = all.length;
  const p95 = Math.round(percentile(all, 95));
  const errorRate = totalRequests ? totalErrors / totalRequests : 1;
  let verdict = 'TIDAK SANGGUP';
  if (p95 < 1000 && errorRate < 0.01) verdict = 'SANGGUP';
  else if (p95 <= 3000 && errorRate < 0.05) verdict = 'BERAT';
  return { verdict, totalRequests, totalErrors, errorRate, p95, endpoints, errorSamples, ...extra };
}

// ---------- HTTP ----------
function makeClient(base) {
  return async function request(label, method, url, { body, headers } = {}) {
    const t0 = performance.now();
    try {
      const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await res.text();
      const ms = performance.now() - t0;
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      record(label, ms, res.ok, `HTTP ${res.status} ${(data && data.error) || ''}`.trim());
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      record(label, performance.now() - t0, false, err.name === 'TimeoutError' ? 'waktu habis (30 dtk)' : err.message);
      return { ok: false, status: 0, data: null };
    }
  };
}

// ---------- data tes ----------
function prepareData(dbPath, opts) {
  const { initDb } = require(path.join(ROOT, 'src', 'db'));
  const { hashPassword } = require(path.join(ROOT, 'src', 'security'));
  const db = initDb(dbPath);
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC').get();
  db.prepare('UPDATE exams SET class_target = ?, duration_minutes = 600 WHERE id = ?').run(CLASS_NAME, exam.id);

  const rooms = Array.from({ length: opts.pengawas }, (_, i) => `Ruang ${pad(i + 1, 2)}`);
  const insertStudent = db.prepare(`INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password, birth_info)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const students = [];
  db.transaction(() => {
    for (let i = 1; i <= opts.siswa; i++) {
      const s = { exam_number: `UB-${pad(i, 4)}`, password: `UB${pad(i, 4)}`, room: rooms[(i - 1) % rooms.length] };
      insertStudent.run(s.exam_number, `99${pad(i, 8)}`, `Siswa Uji ${i}`, CLASS_NAME, s.room, Math.ceil(i / rooms.length), s.password, '-');
      students.push(s);
    }
    const insertUser = db.prepare('INSERT INTO users (username, password, full_name, role, subject, room) VALUES (?, ?, ?, ?, ?, ?)');
    const hashed = hashPassword(PENGAWAS_PASSWORD);
    rooms.forEach((room, i) => insertUser.run(`ub_pengawas_${pad(i + 1, 2)}`, hashed, `Pengawas Uji ${i + 1}`, 'pengawas', null, room));

    const maxNo = db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM questions WHERE exam_id = ?').get(exam.id).n;
    const pgCount = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE exam_id = ? AND type = 'PG'").get(exam.id).n;
    const insertQ = db.prepare(`INSERT INTO questions (exam_id, number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key)
      VALUES (?, ?, 'PG', ?, ?, ?, ?, ?, ?, ?)`);
    for (let k = 1; k <= TARGET_PG - pgCount; k++) {
      insertQ.run(exam.id, maxNo + k,
        `Soal uji beban nomor ${maxNo + k}. Bacalah pernyataan berikut dengan cermat lalu pilih jawaban yang paling tepat sesuai materi yang telah dipelajari.`,
        'Pilihan jawaban A untuk soal uji beban', 'Pilihan jawaban B untuk soal uji beban', 'Pilihan jawaban C untuk soal uji beban',
        'Pilihan jawaban D untuk soal uji beban', 'Pilihan jawaban E untuk soal uji beban', 'ABCDE'[k % 5]);
    }
  })();
  db.close();
  return { students, rooms };
}

// ---------- server tes ----------
async function startServer(tmp, opts) {
  const logLines = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: path.join(tmp, 'uji-beban.db'), BACKUP_DIR: path.join(tmp, 'backups'), PORT: String(opts.port), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const keep = (d) => { logLines.push(...String(d).split('\n')); if (logLines.length > 40) logLines.splice(0, logLines.length - 40); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const base = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`Server tes berhenti saat menyala (kode ${exited}).\n${logLines.join('\n')}`);
    try {
      const r = await fetch(base + '/api/server-info', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { child, base, logLines };
    } catch {}
    await sleep(300);
  }
  child.kill();
  throw new Error(`Server tes tidak menyala dalam 30 detik.\n${logLines.join('\n')}`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 5000);
  });
}

function removeDir(dir) {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* Windows: file DB masih terkunci sebentar */ }
    const until = Date.now() + 300; while (Date.now() < until) {}
  }
}

// ---------- simulasi ----------
async function runSimulation(base, data, opts, log) {
  const request = makeClient(base);
  const startAt = Date.now();
  const endAt = startAt + opts.menit * 60000;
  const remaining = () => endAt - Date.now();
  let active = 0;
  let finished = 0;

  // Pengawas: login lalu pantau ruang tiap 2,5 detik
  const pengawasTokens = [];
  for (let i = 0; i < data.rooms.length; i++) {
    const r = await request('pengawas_login', 'POST', '/api/staff/login', { body: { username: `ub_pengawas_${pad(i + 1, 2)}`, password: PENGAWAS_PASSWORD, role: 'pengawas' } });
    pengawasTokens.push(r.ok ? r.data.staffToken : null);
  }
  const staffAuth = { Authorization: `Bearer ${pengawasTokens.find(Boolean) || ''}` };

  let tokenPromise = null;
  const getToken = (force) => {
    if (!tokenPromise || force) {
      tokenPromise = request('token', 'GET', `/api/ujian/active-token?class_name=${encodeURIComponent(CLASS_NAME)}`, { headers: staffAuth })
        .then(r => (r.ok ? r.data.token : null));
    }
    return tokenPromise;
  };

  const pengawasLoops = pengawasTokens.map(async (tok, i) => {
    if (!tok) return;
    await sleep(rand(0, POLL_ROOM_MS));
    while (remaining() > 0) {
      await request('pengawas_ruang', 'GET', `/api/pengawas/room?room=${encodeURIComponent(data.rooms[i])}`, { headers: { Authorization: `Bearer ${tok}` } });
      await sleep(Math.min(POLL_ROOM_MS, remaining()));
    }
  });

  async function student(s) {
    await sleep(rand(0, Math.min(opts.datang * 1000, Math.max(0, remaining() - 1000))));
    let login = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(attempt > 0);
      login = await request('login', 'POST', '/api/ujian/login', { body: { exam_number: s.exam_number, password: s.password, token } });
      if (login.status !== 403) break; // 403 = token berganti → ambil token baru sekali
    }
    if (!login || !login.ok) return;
    active++;
    const sid = login.data.sessionId;
    const h = { 'X-Session-Token': login.data.sessionToken };
    const sess = await request('sesi', 'GET', `/api/ujian/session/${sid}`, { headers: h });
    if (!sess.ok) { active--; return; }
    const questions = sess.data.questions || [];
    const pg = questions.filter(q => q.type === 'PG');
    const essays = questions.filter(q => q.type === 'ESAI');

    const pollLoop = (async () => {
      await sleep(Math.min(POLL_SESSION_MS, remaining()));
      while (remaining() > 0) {
        await request('sesi_ulang', 'GET', `/api/ujian/session/${sid}`, { headers: h });
        await sleep(Math.min(POLL_SESSION_MS, remaining()));
      }
    })();
    const answerLoop = (async () => {
      while (remaining() > 0 && pg.length) {
        const q = pg[Math.floor(Math.random() * pg.length)];
        await request('heartbeat', 'POST', '/api/ujian/heartbeat', { body: { sessionId: sid, currentQuestionNumber: q.number }, headers: h });
        await request('jawab', 'POST', '/api/ujian/answer', { body: { sessionId: sid, questionId: q.id, chosenOption: 'ABCDE'[Math.floor(Math.random() * 5)] }, headers: h });
        await sleep(Math.min(rand(ANSWER_MIN_MS, ANSWER_MAX_MS), remaining()));
      }
    })();
    await Promise.all([pollLoop, answerLoop]);

    for (const q of essays) {
      await request('esai', 'POST', '/api/ujian/essay-answered', { body: { sessionId: sid, questionId: q.id }, headers: h });
    }
    const fin = await request('selesai', 'POST', '/api/ujian/finish', { body: { sessionId: sid }, headers: h });
    if (fin.ok) finished++;
    active--;
  }

  const progress = setInterval(() => {
    const sec = Math.round((Date.now() - startAt) / 1000);
    let reqs = 0, errs = 0;
    for (const s of stats.values()) { reqs += s.times.length; errs += s.errors; }
    log(`[${pad(Math.floor(sec / 60), 2)}:${pad(sec % 60, 2)}] siswa aktif ${active}/${data.students.length}, permintaan ${reqs}, gagal ${errs}`);
  }, 10000);

  await Promise.all([...data.students.map(student), ...pengawasLoops]);
  clearInterval(progress);
  return { finished, students: data.students.length, pengawas: data.rooms.length, seconds: Math.round((Date.now() - startAt) / 1000) };
}

// ---------- laporan ----------
const LABELS = {
  pengawas_login: 'Login pengawas', token: 'Ambil token', login: 'Login siswa', sesi: 'Buka soal',
  sesi_ulang: 'Cek sesi (tiap 6 dtk)', heartbeat: 'Sinyal aktif', jawab: 'Kirim jawaban', esai: 'Tandai esai',
  selesai: 'Selesai ujian', pengawas_ruang: 'Pantau ruang (2,5 dtk)'
};

function printReport(sum, opts) {
  const line = '─'.repeat(78);
  console.log(`\n${line}\n HASIL UJI BEBAN — ${opts.siswa} siswa, ${opts.pengawas} pengawas, ${opts.menit} menit (${os.hostname()})\n${line}`);
  console.log(` ${'Jenis permintaan'.padEnd(26)}${'Jumlah'.padStart(8)}${'Gagal'.padStart(7)}${'Biasa'.padStart(10)}${'95%'.padStart(10)}${'Terlama'.padStart(11)}`);
  for (const key of Object.keys(LABELS)) {
    const e = sum.endpoints[key];
    if (!e) continue;
    console.log(` ${LABELS[key].padEnd(26)}${String(e.count).padStart(8)}${String(e.errors).padStart(7)}${(e.median + ' ms').padStart(10)}${(e.p95 + ' ms').padStart(10)}${(e.max + ' ms').padStart(11)}`);
  }
  console.log(line);
  console.log(` Total permintaan: ${sum.totalRequests}, gagal: ${sum.totalErrors} (${(sum.errorRate * 100).toFixed(2)}%), 95% selesai dalam ${sum.p95} ms`);
  console.log(` Siswa berhasil Selesai: ${sum.finished}/${sum.students}`);
  if (sum.errorSamples.length) console.log(' Contoh kegagalan:\n   - ' + sum.errorSamples.slice(0, 8).join('\n   - '));
  const icon = { SANGGUP: '✅', BERAT: '⚠️ ', 'TIDAK SANGGUP': '❌' }[sum.verdict];
  const note = {
    SANGGUP: 'Server sanggup melayani beban ini dengan lancar.',
    BERAT: 'Server masih jalan tetapi lambat; siswa akan merasakan jeda. Pertimbangkan VPS lebih kuat atau sesi dibagi.',
    'TIDAK SANGGUP': 'Server tidak sanggup; bagi siswa ke beberapa sesi atau tingkatkan VPS sebelum ujian.'
  }[sum.verdict];
  console.log(`\n ${icon} KESIMPULAN: ${sum.verdict} — ${note}\n${line}`);
}

// ---------- utama ----------
async function main() {
  const { opts, json } = parseArgs(process.argv.slice(2));
  const log = (m) => (json ? process.stderr : process.stdout).write(m + '\n');

  if (!(await checkPortFree(opts.port))) {
    fail(`Port ${opts.port} sudah dipakai. Hentikan program di port itu atau pilih port lain dengan --port.`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbt-uji-beban-'));
  let server = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stopServer(server && server.child);
    removeDir(tmp);
  };
  process.on('SIGINT', async () => { log('\nDihentikan. Mematikan server tes & menghapus data sementara...'); await cleanup(); process.exit(130); });

  try {
    log(`Menyiapkan data tes: ${opts.siswa} siswa, ${opts.pengawas} ruang/pengawas...`);
    const data = prepareData(path.join(tmp, 'uji-beban.db'), opts);
    log(`Menyalakan server tes di port ${opts.port} (database sementara, data asli tidak tersentuh)...`);
    server = await startServer(tmp, opts);
    log(`Uji berjalan ${opts.menit} menit. Siswa datang bertahap selama ${opts.datang} detik. Tekan Ctrl+C untuk berhenti.`);
    const extra = await runSimulation(server.base, data, opts, log);
    const sum = summarize(extra);
    await cleanup();
    if (json) console.log(JSON.stringify(sum));
    else printReport(sum, opts);
    process.exit(sum.verdict === 'SANGGUP' ? 0 : 1);
  } catch (err) {
    await cleanup();
    fail('Uji beban gagal: ' + err.message);
  }
}

main();
