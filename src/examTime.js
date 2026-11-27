// Jam mulai ujian disimpan baku "HH:MM WIT" dan selalu kelipatan 5 menit (07:00, 07:05, 07:10, ...).
// Terima ketikan "7.10", "07:10", "07.10 WIT". Kembalikan null bila tidak sah.
function normalizeStartTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})[:.](\d{2})(?:\s*(?:WIT|WITA|WIB))?$/i);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59 || min % 5 !== 0) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')} WIT`;
}

// Label lama menggabungkan sesi dan jam, mis. "Sesi 1 (08:00 WIT)". Pecah menjadi nama sesi + jam baku.
// Jam di dalam label tidak harus kelipatan 5 (data lama apa adanya).
function splitSessionLabel(label) {
  const text = String(label || '').trim();
  const m = text.match(/^(.*?)\s*\(\s*(\d{1,2})[:.](\d{2})\s*(?:WIT|WITA|WIB)?\s*\)\s*$/i);
  if (!m || !m[1]) return { session: text, time: null };
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return { session: text, time: null };
  return { session: m[1].trim(), time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')} WIT` };
}

module.exports = { normalizeStartTime, splitSessionLabel };
