const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const JSZip = require('jszip');
const { replaceMathInDocumentXml } = require('./ommlText');

// Rentang nomor soal pada judul bacaan, mis. "question 32 to 35", "soal nomor 5–6", "soal 1 sampai 2", "no. 3 s.d. 4"
const PASSAGE_RANGE_RE = /\b(?:questions?|numbers?|soal|nomor|no\.?)\s*(\d+)\s*(?:-|–|—|to|until|through|sampai|hingga|s\.?\s*d\.?|and|dan)\s*(\d+)/i;

function parseQuestionsFromText(rawText) {
  const lines = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let currentMode = 'PG';
  const questions = [];
  let current = null;
  let pendingImage = null;
  // Teks tanpa nomor di antara soal (bacaan/wacana). Hanya dikumpulkan setelah penanda [PG]/[ESAI]
  // atau soal pertama, supaya judul & petunjuk di awal dokumen tidak ikut masuk ke soal.
  let started = false;
  // Bacaan bersama dengan rentang nomor ("text for question 32 to 35"): dipasang di setiap soal dalam rentang
  let passage = null;
  // Teks tanpa nomor tanpa rentang: dipasang ke soal tepat sesudahnya saja
  let orphan = [];
  // Nomor bagian ([PG] / [ESAI]) untuk setiap soal, supaya bacaan tidak menyeberang antarbagian
  let section = 0;

  const pushCurrent = () => {
    if (current && current.prefix) {
      current.question_text = [current.prefix, current.question_text].filter(Boolean).join('\n\n');
      current.ctx = current.prefix; // bacaan dari judul rentang, dipakai lagi oleh linkSharedPassages
    }
    // Soal yang hanya berisi gambar (tanpa teks) tetap disimpan
    if (!current || (!current.question_text.trim() && !current.image_data)) return;
    delete current.lastTarget;
    delete current.prefix;
    if (current.type === 'PG') {
      current.answer_key = (current.answer_key || 'A').toUpperCase();
    } else {
      current.answer_key = null;
      current.option_a = null;
      current.option_b = null;
      current.option_c = null;
      current.option_d = null;
      current.option_e = null;
    }
    questions.push(current);
    current = null;
  };

  for (const line of lines) {
    if (/^\[?\s*(PG|PILIHAN\s*GANDA)\s*\]?$/i.test(line)) {
      pushCurrent();
      currentMode = 'PG';
      started = true; passage = null; orphan = []; section++;
      continue;
    }
    if (/^\[?\s*(ESAI|ESSAY|URAIAN)\s*\]?$/i.test(line)) {
      pushCurrent();
      currentMode = 'ESAI';
      started = true; passage = null; orphan = []; section++;
      continue;
    }


    // Cek baris kunci jawaban: KUNCI : B atau Jawaban: C
    const keyMatch = line.match(/^(?:KUNCI(?:\s*JAWABAN)?|JAWABAN)\s*[:=]\s*([A-Ea-e])/i);
    if (keyMatch && current) {
      current.answer_key = keyMatch[1].toUpperCase();
      pushCurrent();
      continue;
    }

    // Cek opsi A. / B) di mode PG
    const optMatch = currentMode === 'PG' && line.match(/^([A-Ea-e])\s*[\.\)]\s*(.+)$/);
    if (optMatch && current) {
      const letter = optMatch[1].toLowerCase();
      const targetKey = `option_${letter}`;
      current[targetKey] = optMatch[2].trim();
      current.lastTarget = targetKey;
      continue;
    }

    // Judul bacaan bersama: "The following text for question 32 to 35", "Teks berikut untuk soal nomor 5–6".
    // Dicek setelah opsi, supaya opsi seperti "B. Nomor 1 dan 3 benar" tetap terbaca sebagai opsi.
    const rangeMatch = !/^\d+\s*[\.\)]/.test(line) && !/^[A-Ea-e]\s*[\.\)]/.test(line) && line.match(PASSAGE_RANGE_RE);
    if (rangeMatch && Number(rangeMatch[2]) >= Number(rangeMatch[1])) {
      // Hanya bila soal sebelumnya sudah lengkap (esai, atau PG yang sudah punya opsi)
      const finished = !current || current.type === 'ESAI' || Boolean(current.option_a);
      if (finished) {
        pushCurrent();
        started = true;
        passage = { from: Number(rangeMatch[1]), to: Number(rangeMatch[2]), lines: [line], image: null, collecting: true };
        continue;
      }
    }

    // Cek awal nomor soal baru: "1. Teks..." atau "31) Teks..."
    // Pada mode PG, jika soal saat ini belum memiliki opsi A sama sekali, baris "1. ..." atau "2. ..."
    // adalah sub-pernyataan di dalam batang soal, BUKAN soal baru!
    // Teks boleh kosong: banyak bank soal menulis "1." sendirian, lalu gambar, lalu teks soal di baris berikutnya.
    const numMatch = line.match(/^(\d+)\s*[\.\)]\s*(.*)$/);
    if (numMatch) {
      const isCompletePg = current && current.type === 'PG' && Boolean(current.option_a);
      // Pada mode esai, "1." / "2." yang nomornya tidak lebih besar dari nomor soal saat ini
      // adalah sub-butir di dalam soal esai (mis. soal 23 berisi "1. Kondisi pertama"), BUKAN soal baru.
      const isNextEsai = current && current.type === 'ESAI' && Number(numMatch[1]) > current.number;
      if (!current || isCompletePg || isNextEsai) {
        pushCurrent();
        started = true;
        const num = Number(numMatch[1]);
        const prefixParts = [];
        let passageImage = null;
        if (passage) {
          passage.collecting = false;
          if (num >= passage.from && num <= passage.to) {
            prefixParts.push(passage.lines.join('\n'));
            passageImage = passage.image;
          } else if (num > passage.to) {
            passage = null;
          }
        }
        if (orphan.length) { prefixParts.push(orphan.join('\n')); orphan = []; }
        current = {
          prefix: prefixParts.join('\n\n'),
          section,
          type: currentMode,
          number: num,
          question_text: numMatch[2].trim(),
          image_data: pendingImage || passageImage,
          option_a: '',
          option_b: '',
          option_c: '',
          option_d: '',
          option_e: '',
          answer_key: currentMode === 'PG' ? 'A' : null,
          lastTarget: 'question_text'
        };
        pendingImage = null;
        continue;
      }
    }

    // Jika baris mengandung tag gambar base64 hasil ekstraksi mammoth
    if (line.startsWith('IMG_DATA:')) {
      const src = line.replace('IMG_DATA:', '').trim();
      // Gambar di atas nomor soal (belum ada soal yang sedang dibaca) disimpan untuk soal berikutnya
      if (current) current.image_data = src;
      else if (passage && passage.collecting) passage.image = passage.image || src;
      else pendingImage = src;
      continue;
    }

    // Lanjutan teks multi-baris (ke opsi terakhir atau ke batang soal)
    if (current) {
      const target = current.lastTarget || 'question_text';
      if (target === 'question_text') {
        current.question_text = current.question_text ? current.question_text + '\n' + line : line;
      } else {
        current[target] = (current[target] + ' ' + line).trim();
      }
    } else if (started) {
      // Bacaan/wacana tanpa nomor sebelum soal berikutnya
      if (passage && passage.collecting) passage.lines.push(line);
      else orphan.push(line);
    }
  }

  pushCurrent();

  linkSharedPassages(questions);
  return questions.map((q, idx) => {
    const { section, ctx, ...rest } = q;
    return { ...rest, number: q.number || idx + 1 };
  });
}

// Kata yang menandakan soal membahas bacaan sebelumnya. "di atas"/"above" sengaja tidak dipakai: sering
// merujuk ke kalimat soal itu sendiri (mis. Fisika "Pernyataan di atas merupakan bunyi hukum ...").
const REFERS_TO_PASSAGE_RE = /\b(text|story|passage|paragraph|letter|dialog(ue)?|conversation|advertisement|announcement|invitation|writer|author|conclusion|teks|bacaan|paragraf|cerita|wacana|surat|percakapan|iklan|pengumuman|penulis|kesimpulan)\b/i;

const textLines = (t) => String(t || '').split('\n').map(l => l.trim()).filter(Boolean);

// Soal yang membawa konteks sendiri (bacaan, dialog, daftar pernyataan, atau gambar)
function hasOwnContext(q) {
  return Boolean(q.image_data) || textLines(q.question_text).length >= 3 || q.question_text.length >= 250;
}

// Banyak bank soal menulis bacaan langsung di dalam soal pertama ("1. A farmer came ... What is the
// purpose of the text?"), lalu soal 2-4 hanya berisi pertanyaan. Siswa melihat soal satu per satu, jadi
// bacaan itu ikut dipasang di soal-soal pendek sesudahnya, sampai soal berikutnya yang punya konteks sendiri.
// Hanya bila minimal satu soal di kelompok itu menyebut bacaannya ("the text", "paragraph", "teks", ...),
// supaya soal biasa (mis. Matematika) tidak ketempelan.
function linkSharedPassages(questions) {
  let source = null;
  let sourceSection = null;
  let group = [];
  const flush = () => {
    if (source && group.length && group.some(q => REFERS_TO_PASSAGE_RE.test(q.question_text))) {
      for (const q of group) {
        if (source.text) q.question_text = source.text + '\n\n' + q.question_text;
        // Bacaan berupa gambar: dipakai soal yang belum punya gambar sendiri
        if (source.image && !q.image_data) q.image_data = source.image;
      }
    }
    group = [];
  };
  for (const q of questions) {
    // Bacaan tidak menyeberang dari bagian PG ke bagian esai (atau sebaliknya)
    if (source && q.section !== sourceSection) { flush(); source = null; }
    if (hasOwnContext(q)) {
      flush();
      // Bacaan = konteks dari judul rentang, atau seluruh baris kecuali baris pertanyaan terakhir;
      // ditambah gambar soal itu (bacaan yang dijadikan gambar)
      const passageText = q.ctx || textLines(q.question_text).slice(0, -1).join('\n');
      const text = passageText.length >= 120 || (q.ctx && q.image_data) ? passageText : '';
      source = text || q.image_data ? { text, image: q.image_data || null } : null;
      sourceSection = q.section;
      continue;
    }
    if (source) group.push(q);
  }
  flush();
}

// Persamaan Word (OMML) dibuang mammoth; ubah dulu menjadi teks biasa di dalam document.xml.
async function convertMathToText(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    return buffer; // bukan zip yang sah: biarkan mammoth yang melaporkan galatnya
  }
  const file = zip.file('word/document.xml');
  if (!file) return buffer;
  const xml = await file.async('string');
  if (!/<m:oMath/.test(xml)) return buffer;
  zip.file('word/document.xml', replaceMathInDocumentXml(xml));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function parseDocxBuffer(buffer) {
  buffer = await convertMathToText(buffer);
  const images = [];
  const htmlRes = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement((image) => {
        return image.read('base64').then((imageBuffer) => {
          const dataUri = `data:${image.contentType};base64,${imageBuffer}`;
          images.push(dataUri);
          return { src: `IMG_TOKEN_${images.length - 1}` };
        });
      })
    }
  );

  const textWithImages = htmlRes.value
    .replace(/<img[^>]*src="IMG_TOKEN_(\d+)"[^>]*>/gi, (_, idx) => `\nIMG_DATA:${images[Number(idx)]}\n`)
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  return parseQuestionsFromText(textWithImages);
}

async function generateWordTemplateBuffer() {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: 'TEMPLATE BANK SOAL CBT — SMA NEGERI 3 BURU', bold: true })]
          }),
          new Paragraph({
            children: [new TextRun({ text: 'Petunjuk: Gunakan penanda [PG] untuk Pilihan Ganda dan [ESAI] untuk Soal Esai (dijawab siswa di lembar kertas).', italics: true })]
          }),
          new Paragraph({ text: '[PG]' }),
          new Paragraph({ text: '1. Ibu kota Provinsi Maluku adalah...' }),
          new Paragraph({ text: 'A. Tual' }),
          new Paragraph({ text: 'B. Ambon' }),
          new Paragraph({ text: 'C. Namlea' }),
          new Paragraph({ text: 'D. Masohi' }),
          new Paragraph({ text: 'E. Dobo' }),
          new Paragraph({ text: 'KUNCI: B' }),
          new Paragraph({ text: '' }),
          new Paragraph({ text: '2. Pada sel volta, elektroda tempat terjadinya reaksi oksidasi disebut...' }),
          new Paragraph({ text: 'A. Katoda' }),
          new Paragraph({ text: 'B. Anoda' }),
          new Paragraph({ text: 'C. Elektrolit' }),
          new Paragraph({ text: 'D. Jembatan garam' }),
          new Paragraph({ text: 'E. Membran semipermeabel' }),
          new Paragraph({ text: 'KUNCI: B' }),
          new Paragraph({ text: '' }),
          new Paragraph({ text: '[ESAI]' }),
          new Paragraph({ text: '31. Jelaskan 3 faktor utama yang memengaruhi pergeseran kesetimbangan kimia beserta contohnya!' }),
          new Paragraph({ text: '32. Mengapa penambahan katalis dapat mempercepat laju reaksi? Tuliskan penjelasan Anda di lembar jawaban kertas!' })
        ]
      }
    ]
  });

  return Packer.toBuffer(doc);
}

module.exports = {
  parseQuestionsFromText,
  parseDocxBuffer,
  generateWordTemplateBuffer
};
