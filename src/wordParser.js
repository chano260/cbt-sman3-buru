const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

function parseQuestionsFromText(rawText) {
  const lines = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let currentMode = 'PG';
  const questions = [];
  let current = null;

  const pushCurrent = () => {
    if (!current || !current.question_text.trim()) return;
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
      continue;
    }
    if (/^\[?\s*(ESAI|ESSAY|URAIAN)\s*\]?$/i.test(line)) {
      pushCurrent();
      currentMode = 'ESAI';
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
      current[`option_${letter}`] = optMatch[2].trim();
      continue;
    }

    // Cek awal nomor soal baru: "1. Teks..." atau "31) Teks..."
    const numMatch = line.match(/^(\d+)\s*[\.\)]\s*(.+)$/);
    if (numMatch) {
      pushCurrent();
      current = {
        type: currentMode,
        number: Number(numMatch[1]),
        question_text: numMatch[2].trim(),
        image_data: null,
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        option_e: '',
        answer_key: currentMode === 'PG' ? 'A' : null
      };
      continue;
    }

    // Jika baris mengandung tag gambar base64 hasil ekstraksi mammoth
    if (line.startsWith('IMG_DATA:') && current) {
      current.image_data = line.replace('IMG_DATA:', '').trim();
      continue;
    }

    // Lanjutan teks soal multi-baris
    if (current) {
      current.question_text += '\n' + line;
    }
  }

  pushCurrent();

  // Urutkan ulang nomor jika diperlukan tetapi pertahankan nomor asli bila valid
  return questions.map((q, idx) => ({
    ...q,
    number: q.number || idx + 1
  }));
}

async function parseDocxBuffer(buffer) {
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

  // Ubah HTML ke baris teks sambil mempertahankan token gambar
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
