const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');
const { verifyPassword } = require('../src/security');

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db, { enforceDefaultPasswordChange: false }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => {
    const r = await fetch(`${base}/api/staff/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    }).then(r => r.json());
    return { Authorization: `Bearer ${r.staffToken}` };
  };
  return { db, base, login };
}

function xlsxOf(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Akun');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function upload(base, auth, buf, name = 'akun.xlsx') {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const res = await fetch(`${base}/api/operator/staff/import-excel`, { method: 'POST', headers: auth, body: fd });
  return { status: res.status, body: await res.json() };
}

test('template akun staf: file Excel dengan kolom yang benar, hanya operator', async (t) => {
  const { base, login } = setup(t);
  assert.equal((await fetch(`${base}/api/operator/template-staff-excel`, { headers: await login('guru', 'guru123') })).status, 403);
  const res = await fetch(`${base}/api/operator/template-staff-excel`, { headers: await login('operator', 'admin123') });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Template-Import-Akun-Guru-Pengawas/);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  const header = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0];
  assert.deepEqual(header, ['Peran', 'Nama Lengkap', 'Username', 'Password', 'Mapel / Ruang']);
});

test('impor akun staf: membuat guru & pengawas dengan password ter-hash dan mapel/ruang', async (t) => {
  const { db, base, login } = setup(t);
  const auth = await login('operator', 'admin123');
  const r = await upload(base, auth, xlsxOf([
    { Peran: 'Guru', 'Nama Lengkap': 'Ibu Ani, S.Pd.', Username: 'bu_ani', Password: 'Ani#2026', 'Mapel / Ruang': 'Matematika, Fisika' },
    { Peran: 'pengawas', 'Nama Lengkap': 'Bpk. Udin', Username: 'pak_udin', Password: 'Udin#2026', 'Mapel / Ruang': 'Ruang 03' }
  ]));
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 2);
  assert.equal(r.body.updated, 0);
  assert.deepEqual(r.body.skipped, []);

  const ani = db.prepare("SELECT * FROM users WHERE username = 'bu_ani'").get();
  assert.equal(ani.role, 'guru');
  assert.equal(ani.subject, 'Matematika, Fisika');
  assert.equal(ani.room, null);
  assert.ok(verifyPassword('Ani#2026', ani.password));
  assert.notEqual(ani.password, 'Ani#2026');

  const udin = db.prepare("SELECT * FROM users WHERE username = 'pak_udin'").get();
  assert.equal(udin.role, 'pengawas');
  assert.equal(udin.room, 'Ruang 03');
  assert.equal(udin.subject, null);
});

test('impor akun staf: username lama diperbarui, password kosong = tetap; operator tidak bisa dibuat/ditimpa', async (t) => {
  const { db, base, login } = setup(t);
  const auth = await login('operator', 'admin123');
  const r = await upload(base, auth, xlsxOf([
    { Peran: 'guru', 'Nama Lengkap': 'Ibu Siti (baru)', Username: 'guru', Password: '', 'Mapel / Ruang': 'Kimia' },
    { Peran: 'operator', 'Nama Lengkap': 'Penyusup', Username: 'op2', Password: 'x12345678' },
    { Peran: 'guru', 'Nama Lengkap': 'Timpa Operator', Username: 'operator', Password: 'x12345678', 'Mapel / Ruang': 'Kimia' },
    { Peran: 'guru', 'Nama Lengkap': '', Username: 'tanpa_nama', Password: 'x12345678' },
    { Peran: 'guru', 'Nama Lengkap': 'Tanpa Password', Username: 'baru_tanpa_pw', Password: '' }
  ]));
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 0);
  assert.equal(r.body.updated, 1);
  assert.deepEqual(r.body.skipped.map(s => s.row), [3, 4, 5, 6]);

  const guru = db.prepare("SELECT * FROM users WHERE username = 'guru'").get();
  assert.equal(guru.full_name, 'Ibu Siti (baru)');
  assert.equal(guru.subject, 'Kimia');
  assert.ok(verifyPassword('guru123', guru.password), 'password lama tetap bila kolom password kosong');

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'op2'").get().n, 0);
  const op = db.prepare("SELECT * FROM users WHERE username = 'operator'").get();
  assert.equal(op.role, 'operator');
  assert.ok(verifyPassword('admin123', op.password), 'akun operator tidak boleh ditimpa lewat impor');
});

test('impor akun staf: hanya operator, dan menolak file bukan Excel', async (t) => {
  const { base, login } = setup(t);
  const buf = xlsxOf([{ Peran: 'guru', 'Nama Lengkap': 'A', Username: 'a_guru', Password: 'x12345678' }]);
  assert.equal((await upload(base, await login('pengawas', 'pengawas123'), buf)).status, 403);
  assert.equal((await upload(base, await login('operator', 'admin123'), Buffer.from('bukan excel'), 'akun.txt')).status, 400);
});
