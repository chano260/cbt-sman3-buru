// Merender teks rumus matematika (hasil ommlText.js maupun ketikan manual)
// menjadi HTML aman dengan pecahan bertingkat, pangkat asli, dan kurung tinggi.
// Seluruh teks literal di-escape terlebih dahulu agar bebas XSS.
(function (root) {
  function escHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const UNI_SUP = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    '⁺': '+', '⁻': '−', '⁼': '=', '⁽': '(', '⁾': ')',
    'ⁿ': 'n', 'ⁱ': 'i', 'ˣ': 'x', 'ʸ': 'y', 'ᵃ': 'a',
    'ᵇ': 'b', 'ᶜ': 'c', 'ᵏ': 'k', 'ᵐ': 'm', 'ᵗ': 't'
  };
  const UNI_SUP_RE = /^[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱˣʸᵃᵇᶜᵏᵐᵗ]+/;

  function decodeUniSup(s) {
    return [...s].map(ch => UNI_SUP[ch] || ch).join('');
  }

  function findMatchingParen(str, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function looksMath(s) {
    const t = s.trim();
    if (!t || t.length > 140) return false;
    // Tolak kalimat prosa panjang di dalam tanda kurung
    if (/[a-zA-Z]{5,}\s+[a-zA-Z]{4,}/.test(t)) return false;
    return true;
  }

  function readTrailingSup(str, idx) {
    if (idx >= str.length) return null;
    if (str[idx] === '^') {
      if (str[idx + 1] === '(') {
        const end = findMatchingParen(str, idx + 1);
        if (end !== -1) {
          return { html: renderSegment(str.slice(idx + 2, end), true), next: end + 1 };
        }
      }
      const m = str.slice(idx + 1).match(/^(-?[a-zA-Z0-9]+)/);
      if (m) return { html: escHtml(m[1]), next: idx + 1 + m[1].length };
    }
    const um = str.slice(idx).match(UNI_SUP_RE);
    if (um) return { html: escHtml(decodeUniSup(um[0])), next: idx + um[0].length };
    return null;
  }

  function fracHtml(numHtml, denHtml, small) {
    const cls = small ? 'm-frac m-frac-sm' : 'm-frac';
    return `<span class="${cls}"><span class="m-num">${numHtml}</span><span class="m-den">${denHtml}</span></span>`;
  }

  function renderSegment(str, inSup) {
    let out = '';
    let i = 0;
    while (i < str.length) {
      // Jangan sentuh URL http:// atau https://
      if (str[i] === 'h' && /^https?:\/\//i.test(str.slice(i))) {
        const um = str.slice(i).match(/^https?:\/\/\S+/i);
        out += escHtml(um[0]);
        i += um[0].length;
        continue;
      }

      // 1. Grup dalam kurung: (num)/(den), (num)/atom, atau ((...)/(...))²
      if (str[i] === '(') {
        const end = findMatchingParen(str, i);
        if (end !== -1) {
          const inner = str.slice(i + 1, end);
          // Cek apakah diikuti '/' (pecahan dengan pembilang dalam kurung)
          if (str[end + 1] === '/' && str[end + 2] !== '/' && looksMath(inner)) {
            const afterSlash = end + 2;
            if (str[afterSlash] === '(') {
              const denEnd = findMatchingParen(str, afterSlash);
              if (denEnd !== -1) {
                const den = str.slice(afterSlash + 1, denEnd);
                if (looksMath(den)) {
                  out += fracHtml(renderSegment(inner, inSup), renderSegment(den, inSup), inSup);
                  i = denEnd + 1;
                  continue;
                }
              }
            } else {
              const dm = str.slice(afterSlash).match(/^(\d{1,4}|[a-zA-Z](?:[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+|\^\([^)]+\)|\^[a-zA-Z0-9])?)(?![a-zA-Z0-9/])/);
              if (dm) {
                out += fracHtml(renderSegment(inner, inSup), renderSegment(dm[1], inSup), inSup);
                i = afterSlash + dm[1].length;
                continue;
              }
            }
          }

          // Kurung biasa atau kurung tinggi yang membungkus pecahan bertingkat
          const innerHtml = renderSegment(inner, inSup);
          const hasTallFrac = !inSup && innerHtml.includes('class="m-frac"');
          if (hasTallFrac) {
            const sup = readTrailingSup(str, end + 1);
            const supHtml = sup ? `<sup class="m-sup m-sup-tall">${sup.html}</sup>` : '';
            out += `<span class="m-group"><span class="m-paren">(</span>${innerHtml}<span class="m-paren">)</span>${supHtml}</span>`;
            i = sup ? sup.next : end + 1;
            continue;
          }
          out += `(${innerHtml})`;
          i = end + 1;
          continue;
        }
      }

      // 2. Pecahan atom/(den), mis. 1/(2^(13/6)) atau 3/(x + 1)
      const prevCh = i > 0 ? str[i - 1] : '';
      if (!/[a-zA-Z0-9/]/.test(prevCh)) {
        const atomFrac = str.slice(i).match(/^(\d{1,4}|[a-zA-Z])\/\(/);
        if (atomFrac) {
          const parenStart = i + atomFrac[1].length + 1;
          const denEnd = findMatchingParen(str, parenStart);
          if (denEnd !== -1) {
            const den = str.slice(parenStart + 1, denEnd);
            if (looksMath(den)) {
              out += fracHtml(escHtml(atomFrac[1]), renderSegment(den, inSup), inSup);
              i = denEnd + 1;
              continue;
            }
          }
        }

        // 3. Pecahan sederhana angka/angka (1/25, 2/3, 7/2) atau variabel/angka (a/3)
        // Abaikan tanggal (17/08/1945) dan tahun ajaran (2025/2026).
        const simpleNum = str.slice(i).match(/^(\d{1,4})\/(\d{1,4})(?![a-zA-Z0-9/])/);
        if (simpleNum) {
          const isAcademicYear = simpleNum[1].length === 4 && simpleNum[2].length === 4
            && /^(19|20)\d\d$/.test(simpleNum[1]) && /^(19|20)\d\d$/.test(simpleNum[2]);
          if (!isAcademicYear) {
            out += fracHtml(escHtml(simpleNum[1]), escHtml(simpleNum[2]), inSup);
            i += simpleNum[0].length;
            continue;
          }
        }
        const varNum = str.slice(i).match(/^([a-zA-Z])\/(\d{1,3})(?![a-zA-Z0-9/])/);
        if (varNum && (i === 0 || /[\s(=+\-·×:,\[]/.test(prevCh))) {
          out += fracHtml(escHtml(varNum[1]), escHtml(varNum[2]), inSup);
          i += varNum[0].length;
          continue;
        }
      }

      // 4. Pangkat ^(expr) atau ^x
      if (str[i] === '^' && i > 0 && !/\s/.test(prevCh)) {
        const sup = readTrailingSup(str, i);
        if (sup) {
          out += `<sup class="m-sup">${sup.html}</sup>`;
          i = sup.next;
          continue;
        }
      }

      // 5. Indeks bawah _(expr)
      if (str[i] === '_' && str[i + 1] === '(' && i > 0 && !/\s/.test(prevCh)) {
        const end = findMatchingParen(str, i + 1);
        if (end !== -1) {
          out += `<sub class="m-sub">${renderSegment(str.slice(i + 2, end), true)}</sub>`;
          i = end + 1;
          continue;
        }
      }

      // 6. Pangkat Unicode (², ⁻³, dll.) diubah jadi <sup> agar sejajar & konsisten di semua HP
      if (i > 0 && !/\s/.test(prevCh)) {
        const um = str.slice(i).match(UNI_SUP_RE);
        if (um) {
          out += `<sup class="m-sup">${escHtml(decodeUniSup(um[0]))}</sup>`;
          i += um[0].length;
          continue;
        }
      }

      out += escHtml(str[i]);
      i++;
    }
    return out;
  }

  function renderMathHtml(text) {
    if (text == null || text === '') return '';
    return renderSegment(String(text), false);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderMathHtml };
  } else {
    root.renderMathHtml = renderMathHtml;
  }
})(typeof window !== 'undefined' ? window : globalThis);
