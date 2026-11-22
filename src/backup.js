// Backup database SQLite: snapshot konsisten via VACUUM INTO (aman saat ujian berjalan, WAL ikut terbaca).
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_RE = /^cbt-backup-\d{8}-\d{6}(-\d+)?\.db$/;
const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => BACKUP_RE.test(f))
    .map(f => ({ name: f, file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

function createBackup(db, dir, { keep = 36 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const base = `cbt-backup-${stamp()}`;
  let file = path.resolve(dir, `${base}.db`);
  for (let i = 2; fs.existsSync(file); i++) file = path.resolve(dir, `${base}-${i}.db`);
  db.prepare('VACUUM INTO ?').run(file);

  const all = listBackups(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(old.file, { force: true });
  return file;
}

function backupStatus(dir) {
  const all = listBackups(dir);
  if (all.length === 0) return { last: null, count: 0 };
  return { last: new Date(all[all.length - 1].mtime).toISOString(), count: all.length };
}

function startBackupSchedule(db, dir, { intervalMs = 10 * 60 * 1000, firstDelayMs = 60 * 1000, keep = 36 } = {}) {
  const run = () => {
    try {
      const file = createBackup(db, dir, { keep });
      console.log(`[backup] tersimpan: ${path.basename(file)}`);
    } catch (err) {
      console.error('[backup] GAGAL:', err.message);
    }
  };
  let interval = null;
  const first = setTimeout(() => {
    run();
    interval = setInterval(run, intervalMs);
    interval.unref();
  }, firstDelayMs);
  first.unref();
  return { stop() { clearTimeout(first); if (interval) clearInterval(interval); } };
}

module.exports = { createBackup, backupStatus, startBackupSchedule };
