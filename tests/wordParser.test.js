const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuestionsFromText, parseDocxBuffer, generateWordTemplateBuffer } = require('../src/wordParser');

test('parseQuestionsFromText parses PG with key and ESAI blocks tolerantly', () => {
  const sample = `
  [PG]
  1. Ibu kota Provinsi Maluku adalah...
  A. Tual
  B. Ambon
  C. Namlea
  D. Masohi
  E. Dobo
  kunci : b

  2) Hasil dari 5 + 5 adalah...
  a. 8
  b. 9
  c. 10
  d. 11
  e. 12
  KUNCI: C

  [ESAI]
  31. Jelaskan 3 faktor utama kesetimbangan kimia!
  `;
  const result = parseQuestionsFromText(sample);
  assert.equal(result.length, 3);
  assert.equal(result[0].type, 'PG');
  assert.equal(result[0].answer_key, 'B');
  assert.equal(result[1].answer_key, 'C');
  assert.equal(result[2].type, 'ESAI');
  assert.equal(result[2].answer_key, null);
});

test('generateWordTemplateBuffer produces a valid .docx buffer that parseDocxBuffer can parse back', async () => {
  const buf = await generateWordTemplateBuffer();
  const parsed = await parseDocxBuffer(buf);
  assert.ok(parsed.some(q => q.type === 'PG'));
  assert.ok(parsed.some(q => q.type === 'ESAI'));
});

test('parseQuestionsFromText handles sub-numbered statements inside question stem and multiline options', () => {
  const complexSample = `
  [PG]
  1. Perhatikan pernyataan berikut:
  1. Penambahan katalis menurunkan energi aktivasi
  2. Mempercepat tercapainya kesetimbangan
  Pernyataan yang benar adalah...
  A. Pernyataan 1 saja
  yang paling tepat
  B. Pernyataan 2 saja
  C. Keduanya benar
  D. Keduanya salah
  E. Tidak ada yang benar
  KUNCI: C
  `;
  const result = parseQuestionsFromText(complexSample);
  assert.equal(result.length, 1);
  assert.ok(result[0].question_text.includes('1. Penambahan katalis'));
  assert.ok(result[0].question_text.includes('2. Mempercepat tercapainya'));
  assert.equal(result[0].option_a, 'Pernyataan 1 saja yang paling tepat');
  assert.equal(result[0].answer_key, 'C');
});

test('esai: sub-butir bernomor (1. 2.) dan berhuruf (a. b.) tetap satu kesatuan dengan soal esainya', () => {
  const sample = `
  [ESAI]
  23. Petugas perpustakaan mencari buku berdasarkan nomor katalog.
  1. Kondisi pertama, katalog belum terurut.
  2. Kondisi kedua, katalog sudah diurutkan dari terkecil hingga terbesar.
  a. Algoritma apa yang tepat untuk setiap kondisi?
  b. Mengapa Binary Search tidak dapat diterapkan langsung pada data yang belum terurut?
  24. Seorang guru memiliki nilai lima siswa: 75, 60, 90, 65, 80.
  a. Jelaskan bagaimana Bubble Sort mengurutkan data tersebut!
  `;
  const result = parseQuestionsFromText(sample);
  assert.deepEqual(result.map(q => q.number), [23, 24]);
  assert.ok(result.every(q => q.type === 'ESAI'));
  assert.ok(result[0].question_text.includes('1. Kondisi pertama'));
  assert.ok(result[0].question_text.includes('2. Kondisi kedua'));
  assert.ok(result[0].question_text.includes('b. Mengapa Binary Search'));
  assert.ok(result[1].question_text.includes('a. Jelaskan bagaimana Bubble Sort'));
});

test('esai: soal esai pertama boleh bernomor 1 dan nomor berikutnya tetap jadi soal baru', () => {
  const result = parseQuestionsFromText(`
  [ESAI]
  1. Jelaskan pengertian algoritma!
  2. Sebutkan contoh algoritma!
  3. Jelaskan perbedaan FIFO dan LIFO!
  `);
  assert.deepEqual(result.map(q => q.number), [1, 2, 3]);
});

test('nomor soal sendirian di satu baris ("1. ") lalu gambar dan teks soal tetap terbaca sebagai satu soal', () => {
  const result = parseQuestionsFromText(`
  [PG]
  1.
  IMG_DATA:data:image/png;base64,AAAA
  Tiga lampu pijar identik disusun secara seri seperti rangkaian di samping.
  A. Sangat terang
  B. Terang
  C. Redup
  D. Sangat redup
  E. Mati
  KUNCI: E
  2.
  IMG_DATA:data:image/png;base64,BBBB
  Dari grafik di atas, nilai hambatannya adalah ....
  A. 110 ohm
  B. 115 ohm
  C. 120 ohm
  D. 125 ohm
  E. 130 ohm
  KUNCI: D
  3. Alat untuk mengukur kuat arus adalah ....
  A. Osiloskop
  B. Galvanometer
  C. Ohm meter
  D. Voltmeter
  E. Amperemeter
  KUNCI: E
  [ESAI]
  25.
  IMG_DATA:data:image/png;base64,CCCC
  Hitung kuat arus pada gambar!
  `);
  assert.deepEqual(result.map(q => q.number), [1, 2, 3, 25]);
  assert.equal(result[0].image_data, 'data:image/png;base64,AAAA');
  assert.equal(result[0].question_text, 'Tiga lampu pijar identik disusun secara seri seperti rangkaian di samping.');
  assert.equal(result[0].option_e, 'Mati');
  assert.equal(result[0].answer_key, 'E');
  assert.equal(result[1].image_data, 'data:image/png;base64,BBBB');
  assert.equal(result[1].answer_key, 'D');
  assert.equal(result[2].image_data, null);
  assert.equal(result[3].type, 'ESAI');
  assert.equal(result[3].image_data, 'data:image/png;base64,CCCC');
  assert.equal(result[3].question_text, 'Hitung kuat arus pada gambar!');
});

test('gambar yang diletakkan di atas nomor soal ikut ke soal berikutnya', () => {
  const result = parseQuestionsFromText(`
  [PG]
  IMG_DATA:data:image/png;base64,DDDD
  1. Perhatikan gambar di atas!
  A. satu
  B. dua
  C. tiga
  D. empat
  E. lima
  KUNCI: A
  `);
  assert.equal(result.length, 1);
  assert.equal(result[0].image_data, 'data:image/png;base64,DDDD');
});

test('file bank soal: format pemberian nomor lama (teks di baris nomor) tetap sama hasilnya', () => {
  const result = parseQuestionsFromText(`
  [PG]
  1. Perhatikan pernyataan berikut:
  1. Katalis menurunkan energi aktivasi
  Pernyataan yang benar adalah...
  A. a
  B. b
  C. c
  D. d
  E. e
  KUNCI: B
  `);
  assert.equal(result.length, 1);
  assert.ok(result[0].question_text.startsWith('Perhatikan pernyataan berikut:\n1. Katalis'));
});
