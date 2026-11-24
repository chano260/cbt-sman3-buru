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

const PG_OPTS = 'A. a\nB. b\nC. c\nD. d\nE. e';

test('bacaan bersama "text for question 32 to 35" dipasang di atas setiap soal 32 sampai 35', () => {
  const result = parseQuestionsFromText(`
  [PG]
  31. Soal sebelumnya?
  ${PG_OPTS}
  KUNCI: A
  The following text for question 32 to 35
  Social Media Age Limits
  Should social media platforms enforce strict age limits of 16 or older?
  32. Read the text below and then rearrange the sentences!
  - I was more scared than I had ever been
  ${PG_OPTS}
  KUNCI: B
  33. What is the main idea of the text?
  ${PG_OPTS}
  KUNCI: C
  35. Which statement is true?
  ${PG_OPTS}
  KUNCI: D
  36. Choose the correct spelling.
  ${PG_OPTS}
  KUNCI: E
  `);
  assert.deepEqual(result.map(q => q.number), [31, 32, 33, 35, 36]);
  const passage = 'The following text for question 32 to 35\nSocial Media Age Limits\nShould social media platforms enforce strict age limits of 16 or older?';
  assert.equal(result[1].question_text, passage + '\n\nRead the text below and then rearrange the sentences!\n- I was more scared than I had ever been');
  assert.equal(result[2].question_text, passage + '\n\nWhat is the main idea of the text?');
  assert.ok(result[3].question_text.startsWith(passage));
  assert.equal(result[4].question_text, 'Choose the correct spelling.', 'soal di luar rentang yang tidak merujuk bacaan tidak ikut');
  assert.equal(result[0].option_e, 'e', 'bacaan tidak menempel ke opsi soal sebelumnya');
  assert.equal(result[1].answer_key, 'B');
});

test('judul bacaan berbahasa Indonesia ("teks berikut untuk soal nomor 5-6") dan tanpa KUNCI sebelumnya', () => {
  const result = parseQuestionsFromText(`
  [PG]
  4. Soal empat
  ${PG_OPTS}
  Bacalah teks berikut untuk soal nomor 5–6!
  Pada suatu hari seekor kancil pergi ke hutan.
  5. Siapa tokoh utama?
  ${PG_OPTS}
  KUNCI: A
  6. Di mana latarnya?
  ${PG_OPTS}
  KUNCI: B
  `);
  assert.deepEqual(result.map(q => q.number), [4, 5, 6]);
  assert.equal(result[0].option_e, 'e', 'judul bacaan memutus soal 4, tidak menempel ke opsi E');
  for (const q of result.slice(1)) {
    assert.ok(q.question_text.startsWith('Bacalah teks berikut untuk soal nomor 5–6!\nPada suatu hari seekor kancil pergi ke hutan.\n\n'));
  }
});

test('teks tanpa nomor tanpa rentang dipasang ke soal berikutnya saja; judul template sebelum [PG] tidak ikut', () => {
  const result = parseQuestionsFromText(`
  TEMPLATE BANK SOAL CBT
  Petunjuk: gunakan penanda [PG] dan [ESAI].
  [PG]
  1. Soal satu
  ${PG_OPTS}
  KUNCI: A
  Perhatikan tabel berikut.
  2. Soal dua
  ${PG_OPTS}
  KUNCI: B
  3. Soal tiga
  ${PG_OPTS}
  KUNCI: C
  `);
  assert.equal(result[0].question_text, 'Soal satu');
  assert.equal(result[1].question_text, 'Perhatikan tabel berikut.\n\nSoal dua');
  assert.equal(result[2].question_text, 'Soal tiga');
});

test('gambar di dalam bacaan bersama ikut ke setiap soal dalam rentang yang belum bergambar', () => {
  const result = parseQuestionsFromText(`
  [PG]
  Teks berikut untuk soal 1 sampai 2
  IMG_DATA:data:image/png;base64,PSG
  1. Soal satu
  ${PG_OPTS}
  KUNCI: A
  2. Soal dua
  IMG_DATA:data:image/png;base64,OWN
  ${PG_OPTS}
  KUNCI: B
  `);
  assert.equal(result[0].image_data, 'data:image/png;base64,PSG');
  assert.equal(result[1].image_data, 'data:image/png;base64,OWN', 'gambar milik soal sendiri tidak ditimpa');
});

test('opsi yang menyebut "nomor 1 dan 3" atau kata seperti "piano 3 and 4" bukan judul bacaan', () => {
  const result = parseQuestionsFromText(`
  [PG]
  1. Perhatikan pernyataan berikut!
  A. Nomor 1 dan 2 benar
  B. Nomor 1 dan 3 benar
  C. Nomor 2 dan 4 benar
  D. Semua benar
  E. Semua salah
  KUNCI: B
  2. Alat musik apa yang dimainkan?
  A. Gitar
  B. Biola
  C. Drum
  D. Suling
  E. Grand piano 3 and 4
  KUNCI: A
  `);
  assert.deepEqual(result.map(q => q.number), [1, 2]);
  assert.equal(result[0].option_b, 'Nomor 1 dan 3 benar');
  assert.equal(result[0].option_c, 'Nomor 2 dan 4 benar');
  assert.equal(result[1].question_text, 'Alat musik apa yang dimainkan?');
  assert.equal(result[1].option_e, 'Grand piano 3 and 4');
});

const LONG_STORY = 'A farmer came across a bird with a broken wing. He picked it up, took it home and looked after it lovingly, feeding it and keeping it warm.\nWhen the wing was healed, the farmer discovered that the bird could talk and that it was very grateful.\nOne day the bird flew away, but it came back every spring to sing for the farmer.';

test('bacaan di dalam soal pertama otomatis dipasang di soal-soal pendek berikutnya yang merujuk teks', () => {
  const result = parseQuestionsFromText(`
  [PG]
  1. ${LONG_STORY.split('\n').join('\n  ')}
  What is the purpose of the text?
  ${PG_OPTS}
  KUNCI: B
  2. What do we learn from the story?
  ${PG_OPTS}
  KUNCI: D
  3. The word 'discover' (paragraph 2) means ....
  ${PG_OPTS}
  KUNCI: B
  4. For further information we can ....
  ${PG_OPTS}
  KUNCI: C
  5. A: Do you like a cup of tea or a cup of coffee?
  B: Wow, thanks. I like coffee.
  A: Here you are.
  What expression is used?
  ${PG_OPTS}
  KUNCI: A
  `);
  assert.deepEqual(result.map(q => q.number), [1, 2, 3, 4, 5]);
  assert.equal(result[0].question_text, LONG_STORY + '\nWhat is the purpose of the text?', 'soal sumber tidak berubah');
  assert.equal(result[1].question_text, LONG_STORY + '\n\nWhat do we learn from the story?');
  assert.equal(result[2].question_text, LONG_STORY + "\n\nThe word 'discover' (paragraph 2) means ....");
  assert.equal(result[3].question_text, LONG_STORY + '\n\nFor further information we can ....', 'satu kelompok bacaan ikut semua');
  assert.ok(result[4].question_text.startsWith('A: Do you like'), 'soal dengan dialog sendiri tidak ditempeli bacaan');
});

test('soal biasa (Matematika) dengan pernyataan bertingkat tidak menempelkan apa pun ke soal berikutnya', () => {
  const result = parseQuestionsFromText(`
  [PG]
  1. Perhatikan pernyataan berikut:
  1) Bilangan prima terkecil adalah 2
  2) Akar dari 16 adalah 4
  3) Pi sama dengan 3,14 tepat
  Pernyataan yang benar adalah ....
  ${PG_OPTS}
  KUNCI: A
  2. Hasil dari 12 x 12 adalah ....
  ${PG_OPTS}
  KUNCI: B
  3. Nilai x jika 2x = 10 adalah ....
  ${PG_OPTS}
  KUNCI: C
  `);
  assert.equal(result[1].question_text, 'Hasil dari 12 x 12 adalah ....');
  assert.equal(result[2].question_text, 'Nilai x jika 2x = 10 adalah ....');
});

test('esai setelah rentang bacaan yang merujuk kesimpulan ikut mendapat bacaan (32-35 lalu 36)', () => {
  const result = parseQuestionsFromText(`
  [ESAI]
  The following text for question 32 to 35
  ${LONG_STORY.split('\n').join('\n  ')}
  32. Rearrange the sentences!
  33. What is the issue being discussed?
  34. Why are young teens vulnerable?
  35. What do opponents say?
  36. What balanced solution does the conclusion suggest?
  `);
  assert.deepEqual(result.map(q => q.number), [32, 33, 34, 35, 36]);
  const head = 'The following text for question 32 to 35\n' + LONG_STORY;
  assert.equal(result[4].question_text, head + '\n\nWhat balanced solution does the conclusion suggest?');
  assert.equal(result[3].question_text, head + '\n\nWhat do opponents say?', 'tidak ditempel dua kali');
});

test('bacaan tidak menyeberang dari bagian PG ke bagian esai', () => {
  const result = parseQuestionsFromText(`
  [PG]
  1. ${LONG_STORY.split('\n').join('\n  ')}
  What is the purpose of the text?
  ${PG_OPTS}
  KUNCI: A
  [ESAI]
  2. Explain the text you have read!
  `);
  assert.equal(result[1].question_text, 'Explain the text you have read!');
});

test('bacaan berupa gambar di soal pertama ikut ke soal-soal pendek berikutnya yang merujuk teks', () => {
  const result = parseQuestionsFromText(`
  [PG]
  1.
  IMG_DATA:data:image/png;base64,STORY
  What is the purpose of the text?
  ${PG_OPTS}
  KUNCI: B
  2. What do we learn from the story?
  ${PG_OPTS}
  KUNCI: D
  3. The word 'discover' (paragraph 2) means ....
  ${PG_OPTS}
  KUNCI: B
  4. A: Do you like tea?
  B: Yes, please.
  A: Here you are.
  What expression is used?
  ${PG_OPTS}
  KUNCI: A
  `);
  assert.equal(result[0].image_data, 'data:image/png;base64,STORY');
  assert.equal(result[1].image_data, 'data:image/png;base64,STORY');
  assert.equal(result[1].question_text, 'What do we learn from the story?', 'tidak ada teks bacaan yang ditambahkan');
  assert.equal(result[2].image_data, 'data:image/png;base64,STORY');
  assert.equal(result[3].image_data, null, 'soal dengan dialog sendiri tidak ikut');
});

test('esai: gambar bacaan "question 32 to 35" ada di 32-35 dan ikut ke 36 yang merujuk kesimpulan', () => {
  const result = parseQuestionsFromText(`
  [ESAI]
  The following text for question 32 to 35
  IMG_DATA:data:image/png;base64,ESSAY
  32. Read the text below and then rearrange the sentences into a good order!
  - I was more scared than I had ever been
  - I had a dream last night
  33. What is the issue being discussed?
  34. Why are young teens vulnerable?
  35. What do opponents say about age restrictions?
  36. What balanced solution does the conclusion suggest?
  `);
  assert.deepEqual(result.map(q => q.number), [32, 33, 34, 35, 36]);
  for (const q of result) assert.equal(q.image_data, 'data:image/png;base64,ESSAY', `soal ${q.number} mendapat gambar bacaan`);
  assert.ok(result[1].question_text.endsWith('What is the issue being discussed?'));
});

test('soal Fisika yang menyebut "di atas" untuk kalimatnya sendiri tidak ketempelan gambar soal sebelumnya', () => {
  const result = parseQuestionsFromText(`
  [PG]
  13.
  IMG_DATA:data:image/png;base64,RANGKAIAN
  Kuat arus berdasarkan gambar adalah ....
  ${PG_OPTS}
  KUNCI: B
  14. Alat yang digunakan untuk menghambat aliran listrik adalah ....
  ${PG_OPTS}
  KUNCI: B
  15. Pada rangkaian bercabang jumlah kuat arus yang masuk sama dengan yang keluar. Pernyataan di atas merupakan bunyi hukum ....
  ${PG_OPTS}
  KUNCI: E
  `);
  assert.equal(result[1].image_data, null);
  assert.equal(result[2].image_data, null);
});
