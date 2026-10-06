// Scanner for FlickerTalk (Plan §53–§55): a photo of a paper becomes a straight, clean document.
// The user marks the four corners, the plugin straightens the perspective (a homography computed
// here, no library), cleans the page if asked, and sends the pages as one PDF, or one page as a
// picture. Everything happens on this phone: no network, nothing of the chat, and only the file
// the user picks through the app or hands over with "open with".

// ---- Geometry -----------------------------------------------------------------------------------

/**
 * The homography that takes the four `from` points to the four `to` points, in order, as a 3 × 3
 * matrix in row order (eight unknowns, h33 = 1), solved by Gaussian elimination.
 */
export function homography(from, to) {
  const rows = [];
  const rhs = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }
  const h = solve(rows, rhs);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Solves A·x = b for a square system, or null when it has no single answer. */
function solve(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let best = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(m[row][col]) > Math.abs(m[best][col])) best = row;
    if (Math.abs(m[best][col]) < 1e-12) return null;
    [m[col], m[best]] = [m[best], m[col]];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Where `h` takes the point. */
export function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * How big the straightened page is for a quad of corners (top left, top right, bottom right,
 * bottom left): the mean of its opposite sides, scaled so the longest side is at most `max`, and
 * never under 8 pixels.
 */
export function quadSize(quad, max = 1600) {
  const [tl, tr, br, bl] = quad;
  let width = (distance(tl, tr) + distance(bl, br)) / 2;
  let height = (distance(tl, bl) + distance(tr, br)) / 2;
  const longest = Math.max(width, height);
  if (longest > max) {
    width *= max / longest;
    height *= max / longest;
  }
  return { width: Math.max(8, Math.round(width)), height: Math.max(8, Math.round(height)) };
}

/** The corners a fresh picture starts with: a frame a little inside its edges. */
export function startingQuad({ width, height }, inset = 0.06) {
  const dx = width * inset;
  const dy = height * inset;
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ];
}

/** A corner kept inside the picture. */
export function clamped({ x, y }, { width, height }) {
  return { x: Math.min(Math.max(0, x), width), y: Math.min(Math.max(0, y), height) };
}

/**
 * The straightened page: for every pixel of the `size` page, the source pixel the inverse
 * homography points at, read with bilinear interpolation; a pixel pointing outside the picture is
 * white. `source` is an ImageData (or anything with `width`, `height` and RGBA `data`).
 */
export function warp(source, quad, size) {
  const { width, height } = size;
  const target = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const back = homography(target, quad);
  const out = new Uint8ClampedArray(width * height * 4);
  if (!back) return { width, height, data: out.fill(255) };
  const { data: src, width: sw, height: sh } = source;
  let at = 0;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const { x, y } = project(back, col + 0.5, row + 0.5);
      const x0 = Math.floor(x - 0.5);
      const y0 = Math.floor(y - 0.5);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        out[at] = out[at + 1] = out[at + 2] = out[at + 3] = 255;
        at += 4;
        continue;
      }
      const fx = x - 0.5 - x0;
      const fy = y - 0.5 - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c += 1) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bottom = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out[at + c] = top * (1 - fy) + bottom * fy;
      }
      out[at + 3] = 255;
      at += 4;
    }
  }
  return { width, height, data: out };
}

/**
 * The page as a document: grey, the paper pushed to white and the ink to black. The brightness of
 * the paper is read from the page itself (most of a page is paper, so a high percentile of its
 * greys), and the threshold follows it: a dim photo still comes out as paper, not as a stain.
 */
export function cleaned(page) {
  const { width, height, data } = page;
  const out = new Uint8ClampedArray(data.length);
  const greys = new Uint8ClampedArray(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const grey = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    greys[p] = grey;
    histogram[grey] += 1;
  }
  // The grey that 85 % of the pixels are at or under: the paper, on a page that is mostly paper.
  let paper = 255;
  for (let level = 0, seen = 0; level < 256; level += 1) {
    seen += histogram[level];
    if (seen >= greys.length * 0.85) {
      paper = level;
      break;
    }
  }
  paper = Math.max(40, paper);
  const white = paper * 0.8;
  const black = paper * 0.35;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const grey = greys[p];
    const value = grey >= white ? 255 : Math.max(0, Math.round(((grey - black) / (white - black)) * 255));
    out[i] = out[i + 1] = out[i + 2] = value;
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}

/** What the file is called once it has been worked on; never a path, never empty. */
export function outName(name, extension) {
  const base = String(name).split(/[\\/]/).pop()?.replace(/\.[^.]*$/, "") ?? "";
  return `${base.trim() || "scan"}.${extension}`;
}

// ---- PDF (as plugin-pdf writes it: one JPEG per A4 page, no library) ---------------------------

const A4 = { width: 595, height: 842 };
const MARGIN = 24;

/** Where a page goes on an A4 sheet: as big as it fits inside the margin, centred. */
export function a4Box({ width, height }) {
  const room = { width: A4.width - MARGIN * 2, height: A4.height - MARGIN * 2 };
  const scale = Math.min(room.width / width, room.height / height);
  const drawn = { width: width * scale, height: height * scale };
  return { page: A4, x: (A4.width - drawn.width) / 2, y: (A4.height - drawn.height) / 2, width: drawn.width, height: drawn.height };
}

const ascii = (text) => new TextEncoder().encode(text);

/** The PDF of those pages (`{ jpeg, width, height }` each), or nothing when there are none. */
export function pdfOf(pages) {
  if (!pages.length) return null;
  const parts = [];
  const offsets = [0];
  let at = 0;
  const put = (bytes) => {
    parts.push(bytes);
    at += bytes.length;
  };
  const object = (number, body, stream) => {
    offsets[number] = at;
    put(ascii(`${number} 0 obj\n${body}\n`));
    if (stream) {
      put(ascii("stream\n"));
      put(stream);
      put(ascii("\nendstream\n"));
    }
    put(ascii("endobj\n"));
  };
  const first = 3;
  const kids = pages.map((_, index) => `${first + index * 3} 0 R`).join(" ");
  put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => {
    const number = first + index * 3;
    const box = a4Box(page);
    const drawn = ascii(`q\n${box.width.toFixed(2)} 0 0 ${box.height.toFixed(2)} ${box.x.toFixed(2)} ${box.y.toFixed(2)} cm\n/Im0 Do\nQ\n`);
    object(
      number,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box.page.width} ${box.page.height}] ` +
        `/Resources << /XObject << /Im0 ${number + 2} 0 R >> >> /Contents ${number + 1} 0 R >>`,
    );
    object(number + 1, `<< /Length ${drawn.length} >>`, drawn);
    object(
      number + 2,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`,
      page.jpeg,
    );
  });
  const count = offsets.length;
  const table = [`xref\n0 ${count}\n`, "0000000000 65535 f \n"];
  for (let number = 1; number < count; number += 1) table.push(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  const startxref = at;
  put(ascii(table.join("")));
  put(ascii(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`));
  const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let written = 0;
  for (const part of parts) {
    all.set(part, written);
    written += part.length;
  }
  return all;
}

/** Bytes as base64, in bites the browser can take. */
export function base64Of(bytes) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}

function bytesOf(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** What the file is called: the day and the time, so two never collide. */
function stamp() {
  const now = new Date();
  const two = (value) => String(value).padStart(2, "0");
  return `scan-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

// ---- Texts, in the app's languages --------------------------------------------------------------

export const TEXTS = {
  en: { pick: "Pick a photo", corners: "Drag the corners to the edges of the paper", scan: "Straighten", clean: "Document: black on white", keep: "Add this page", image: "Send as a picture", pdf: "Send the PDF", pages: "{n} pages", page: "1 page", cannot: "That picture cannot be read", drop: "Take out", again: "New photo" },
  es: { pick: "Elegir una foto", corners: "Arrastra las esquinas a los bordes del papel", scan: "Enderezar", clean: "Documento: negro sobre blanco", keep: "Añadir esta página", image: "Enviar como imagen", pdf: "Enviar el PDF", pages: "{n} páginas", page: "1 página", cannot: "Esa imagen no se puede leer", drop: "Quitar", again: "Otra foto" },
  pt: { pick: "Escolher uma foto", corners: "Arraste os cantos até às bordas do papel", scan: "Endireitar", clean: "Documento: preto sobre branco", keep: "Adicionar esta página", image: "Enviar como imagem", pdf: "Enviar o PDF", pages: "{n} páginas", page: "1 página", cannot: "Essa imagem não pode ser lida", drop: "Retirar", again: "Outra foto" },
  fr: { pick: "Choisir une photo", corners: "Faites glisser les coins jusqu’aux bords du papier", scan: "Redresser", clean: "Document : noir sur blanc", keep: "Ajouter cette page", image: "Envoyer en image", pdf: "Envoyer le PDF", pages: "{n} pages", page: "1 page", cannot: "Cette image ne peut pas être lue", drop: "Retirer", again: "Autre photo" },
  de: { pick: "Foto wählen", corners: "Zieh die Ecken an die Ränder des Blatts", scan: "Begradigen", clean: "Dokument: Schwarz auf Weiß", keep: "Diese Seite hinzufügen", image: "Als Bild senden", pdf: "PDF senden", pages: "{n} Seiten", page: "1 Seite", cannot: "Dieses Bild kann nicht gelesen werden", drop: "Entfernen", again: "Neues Foto" },
  it: { pick: "Scegli una foto", corners: "Trascina gli angoli ai bordi del foglio", scan: "Raddrizza", clean: "Documento: nero su bianco", keep: "Aggiungi questa pagina", image: "Invia come immagine", pdf: "Invia il PDF", pages: "{n} pagine", page: "1 pagina", cannot: "Questa immagine non si può leggere", drop: "Togli", again: "Nuova foto" },
  ro: { pick: "Alege o fotografie", corners: "Trage colțurile la marginile hârtiei", scan: "Îndreaptă", clean: "Document: negru pe alb", keep: "Adaugă această pagină", image: "Trimite ca imagine", pdf: "Trimite PDF-ul", pages: "{n} pagini", page: "1 pagină", cannot: "Imaginea nu poate fi citită", drop: "Scoate", again: "Altă fotografie" },
  ru: { pick: "Выбрать фото", corners: "Перетащите углы к краям листа", scan: "Выровнять", clean: "Документ: чёрное на белом", keep: "Добавить эту страницу", image: "Отправить как изображение", pdf: "Отправить PDF", pages: "Страниц: {n}", page: "1 страница", cannot: "Это изображение не читается", drop: "Убрать", again: "Новое фото" },
  uk: { pick: "Вибрати фото", corners: "Перетягніть кути до країв аркуша", scan: "Вирівняти", clean: "Документ: чорне на білому", keep: "Додати цю сторінку", image: "Надіслати як зображення", pdf: "Надіслати PDF", pages: "Сторінок: {n}", page: "1 сторінка", cannot: "Це зображення не читається", drop: "Прибрати", again: "Нове фото" },
  pl: { pick: "Wybierz zdjęcie", corners: "Przeciągnij rogi do krawędzi kartki", scan: "Wyprostuj", clean: "Dokument: czarne na białym", keep: "Dodaj tę stronę", image: "Wyślij jako obraz", pdf: "Wyślij PDF", pages: "Stron: {n}", page: "1 strona", cannot: "Tego obrazu nie da się odczytać", drop: "Usuń", again: "Nowe zdjęcie" },
  tr: { pick: "Fotoğraf seç", corners: "Köşeleri kâğıdın kenarlarına sürükle", scan: "Düzelt", clean: "Belge: beyaz üzerine siyah", keep: "Bu sayfayı ekle", image: "Görsel olarak gönder", pdf: "PDF’yi gönder", pages: "{n} sayfa", page: "1 sayfa", cannot: "Bu görsel okunamıyor", drop: "Çıkar", again: "Yeni fotoğraf" },
  ar: { pick: "اختيار صورة", corners: "اسحب الزوايا إلى حواف الورقة", scan: "تقويم", clean: "مستند: أسود على أبيض", keep: "إضافة هذه الصفحة", image: "إرسال كصورة", pdf: "إرسال ملف PDF", pages: "{n} صفحات", page: "صفحة واحدة", cannot: "تعذّر قراءة هذه الصورة", drop: "إزالة", again: "صورة جديدة" },
  hi: { pick: "फ़ोटो चुनें", corners: "कोनों को कागज़ के किनारों तक खींचें", scan: "सीधा करें", clean: "दस्तावेज़: सफ़ेद पर काला", keep: "यह पृष्ठ जोड़ें", image: "तस्वीर के रूप में भेजें", pdf: "PDF भेजें", pages: "{n} पृष्ठ", page: "1 पृष्ठ", cannot: "यह तस्वीर पढ़ी नहीं जा सकती", drop: "हटाएँ", again: "नई फ़ोटो" },
  bn: { pick: "ছবি বাছুন", corners: "কোণগুলো কাগজের কিনারায় টেনে আনুন", scan: "সোজা করুন", clean: "নথি: সাদার উপর কালো", keep: "এই পৃষ্ঠা যোগ করুন", image: "ছবি হিসেবে পাঠান", pdf: "PDF পাঠান", pages: "{n} পৃষ্ঠা", page: "১ পৃষ্ঠা", cannot: "এই ছবি পড়া যাচ্ছে না", drop: "সরান", again: "নতুন ছবি" },
  id: { pick: "Pilih foto", corners: "Seret sudut-sudut ke tepi kertas", scan: "Luruskan", clean: "Dokumen: hitam di atas putih", keep: "Tambahkan halaman ini", image: "Kirim sebagai gambar", pdf: "Kirim PDF", pages: "{n} halaman", page: "1 halaman", cannot: "Gambar itu tidak bisa dibaca", drop: "Keluarkan", again: "Foto baru" },
  vi: { pick: "Chọn ảnh", corners: "Kéo các góc đến mép tờ giấy", scan: "Làm thẳng", clean: "Tài liệu: đen trên trắng", keep: "Thêm trang này", image: "Gửi dưới dạng ảnh", pdf: "Gửi PDF", pages: "{n} trang", page: "1 trang", cannot: "Không đọc được ảnh đó", drop: "Bỏ ra", again: "Ảnh mới" },
  th: { pick: "เลือกรูปถ่าย", corners: "ลากมุมไปที่ขอบกระดาษ", scan: "ปรับให้ตรง", clean: "เอกสาร: ดำบนขาว", keep: "เพิ่มหน้านี้", image: "ส่งเป็นรูปภาพ", pdf: "ส่ง PDF", pages: "{n} หน้า", page: "1 หน้า", cannot: "อ่านรูปนี้ไม่ได้", drop: "นำออก", again: "รูปใหม่" },
  ja: { pick: "写真を選ぶ", corners: "角を紙の端までドラッグ", scan: "まっすぐにする", clean: "書類：白地に黒", keep: "このページを追加", image: "画像として送信", pdf: "PDF を送信", pages: "{n} ページ", page: "1 ページ", cannot: "この画像は読み込めません", drop: "取り除く", again: "新しい写真" },
  ko: { pick: "사진 선택", corners: "모서리를 종이 가장자리로 끌어다 놓으세요", scan: "반듯하게", clean: "문서: 흰 바탕에 검정", keep: "이 페이지 추가", image: "이미지로 보내기", pdf: "PDF 보내기", pages: "{n}페이지", page: "1페이지", cannot: "이 이미지를 읽을 수 없습니다", drop: "빼기", again: "새 사진" },
  "zh-CN": { pick: "选择照片", corners: "把四角拖到纸张边缘", scan: "校正", clean: "文档：白底黑字", keep: "添加此页", image: "作为图片发送", pdf: "发送 PDF", pages: "{n} 页", page: "1 页", cannot: "无法读取该图片", drop: "移除", again: "新照片" },
  "zh-TW": { pick: "選擇照片", corners: "把四角拖到紙張邊緣", scan: "校正", clean: "文件：白底黑字", keep: "加入此頁", image: "以圖片傳送", pdf: "傳送 PDF", pages: "{n} 頁", page: "1 頁", cannot: "無法讀取該圖片", drop: "移除", again: "新照片" },
};

/** A text in the language, or in English; `{n}` filled in. */
export function t(lang, key, vars = {}) {
  const table = TEXTS[lang] ?? TEXTS[String(lang).split("-")[0]] ?? TEXTS.en;
  const text = table[key] ?? TEXTS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

// ---- The component ------------------------------------------------------------------------------

const STYLE = `
:host { display: block; font: 14px system-ui, sans-serif; color: var(--ion-text-color, #111); --paper: var(--ion-background-color, #fff); --accent: var(--ion-color-primary, #0a7); }
.bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0 10px; }
button {
  appearance: none; border: 1px solid currentColor; background: transparent; color: inherit;
  border-radius: 10px; min-width: 44px; height: 40px; font-size: 18px; cursor: pointer; opacity: .75; padding: 0 10px;
}
button:disabled { opacity: .25; }
button.on { opacity: 1; background: currentColor; }
button.on .i { background: var(--paper); }
.i { display: block; width: 22px; height: 22px; margin: auto; background: currentColor; -webkit-mask: var(--i) center/contain no-repeat; mask: var(--i) center/contain no-repeat; }
.grow { flex: 1; }
.note { font-size: 12px; opacity: .6; margin: 0 0 8px; }
.stage { position: relative; display: inline-block; max-width: 100%; touch-action: none; }
.stage canvas { display: block; max-width: 100%; border-radius: 8px; }
.stage svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.stage polygon { fill: rgba(0, 170, 120, .15); stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
.handle { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 0; background: transparent; padding: 0; min-width: 0; opacity: 1; }
.handle::after { content: ""; position: absolute; inset: 11px; border-radius: 50%; background: var(--accent); border: 3px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
ol { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
li { display: flex; align-items: center; gap: 8px; }
li img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; background: #fff; }
li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

/** The longest side the picture is worked on: more only makes it slow and heavy. */
const WORK_PIXELS = 1600;
/** The longest side shown on the screen. */
const VIEW_PIXELS = 1024;

class Scanner extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.lang = "en";
    this.source = null;
    this.quad = null;
    this.result = null;
    this.clean = true;
    this.pages = [];
    this.name = "scan.jpg";
    this.dragging = -1;
  }

  connectedCallback() {
    this.paint();
    globalThis.ft?.onOpen?.((opening) => {
      this.lang = opening?.lang || "en";
      this.paint();
      if (opening?.file?.data) this.load(opening.file);
      else if (!this.source && !this.pages.length) this.ask();
    });
  }

  T(key, vars) {
    return t(this.lang, key, vars);
  }

  async ask() {
    const picked = await globalThis.ft?.pickFile?.("image/*");
    if (picked) await this.load(picked);
  }

  /** A picture in: shown at working size, with the corners a little inside its edges. */
  async load(picked) {
    const image = new Image();
    image.src = `data:${picked.mime || "image/jpeg"};base64,${picked.data}`;
    await image.decode().catch(() => {});
    if (!image.naturalWidth) {
      this.note = this.T("cannot");
      this.paint();
      return;
    }
    this.name = picked.name || "scan.jpg";
    const size = fit(image.naturalWidth, image.naturalHeight, WORK_PIXELS);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, size.width, size.height);
    this.source = canvas;
    this.quad = startingQuad(size);
    this.result = null;
    this.note = this.T("corners");
    this.paint();
  }

  /** The page straightened from the corners, cleaned if asked. */
  straighten() {
    if (!this.source || !this.quad) return;
    const context = this.source.getContext("2d");
    if (!context) return;
    const data = context.getImageData(0, 0, this.source.width, this.source.height);
    const size = quadSize(this.quad, WORK_PIXELS);
    let page = warp(data, this.quad, size);
    if (this.clean) page = cleaned(page);
    const canvas = document.createElement("canvas");
    canvas.width = page.width;
    canvas.height = page.height;
    canvas.getContext("2d")?.putImageData(new ImageData(page.data, page.width, page.height), 0, 0);
    this.result = canvas;
    this.note = "";
    this.paint();
  }

  toggleClean() {
    this.clean = !this.clean;
    if (this.result) this.straighten();
    else this.paint();
  }

  keep() {
    if (!this.result) return;
    this.pages.push({ canvas: this.result, name: this.name });
    this.source = null;
    this.result = null;
    this.quad = null;
    this.paint();
  }

  drop(at) {
    this.pages.splice(at, 1);
    this.paint();
  }

  again() {
    this.source = null;
    this.result = null;
    this.quad = null;
    this.ask();
  }

  /** A canvas as a JPEG page for the PDF. */
  jpegOf(canvas) {
    const url = canvas.toDataURL("image/jpeg", 0.85);
    return { jpeg: bytesOf(url.slice(url.indexOf(",") + 1)), width: canvas.width, height: canvas.height };
  }

  sendPdf() {
    const all = [...this.pages.map((page) => page.canvas), ...(this.result ? [this.result] : [])];
    const made = pdfOf(all.map((canvas) => this.jpegOf(canvas)));
    if (!made) return;
    globalThis.ft.send(`${stamp()}.pdf`, "application/pdf", base64Of(made));
  }

  sendImage() {
    const canvas = this.result ?? this.pages.at(-1)?.canvas;
    if (!canvas) return;
    const url = canvas.toDataURL("image/jpeg", 0.85);
    globalThis.ft.send(outName(this.name, "jpg"), "image/jpeg", url.slice(url.indexOf(",") + 1));
  }

  // ---- Corners by finger --------------------------------------------------------------------

  /** Where a pointer is, in the working picture's own pixels. */
  at(event) {
    const box = this.stage.querySelector("canvas").getBoundingClientRect();
    const scale = this.source.width / (box.width || 1);
    return clamped({ x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale }, this.source);
  }

  onDown(event) {
    const handle = event.target.closest?.("[data-corner]");
    if (!handle || !this.source || this.result) return;
    this.dragging = Number(handle.dataset.corner);
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  onMove(event) {
    if (this.dragging < 0) return;
    this.quad[this.dragging] = this.at(event);
    this.placeCorners();
  }

  onUp() {
    this.dragging = -1;
  }

  /** The handles and the outline, over the picture as it is shown. */
  placeCorners() {
    if (!this.stage || !this.source || !this.quad) return;
    const canvas = this.stage.querySelector("canvas");
    const scale = (canvas.clientWidth || canvas.width) / this.source.width;
    this.quad.forEach((corner, index) => {
      const handle = this.stage.querySelector(`[data-corner="${index}"]`);
      if (handle) {
        handle.style.left = `${corner.x * scale}px`;
        handle.style.top = `${corner.y * scale}px`;
      }
    });
    const polygon = this.stage.querySelector("polygon");
    if (polygon) polygon.setAttribute("points", this.quad.map((corner) => `${corner.x * scale},${corner.y * scale}`).join(" "));
  }

  // ---- What is on the screen ----------------------------------------------------------------

  paint() {
    const T = (key, vars) => this.T(key, vars);
    const shown = this.result ?? this.source;
    const count = this.pages.length + (this.result ? 1 : 0);
    this.root.innerHTML = `
      <style>${STYLE}</style>
      <div class="bar">
        <button data-act="pick" aria-label="${escape(T(shown ? "again" : "pick"))}"><i class="i" style="--i:url(./icon/image-outline.svg)"></i></button>
        <button data-act="scan" aria-label="${escape(T("scan"))}" ${this.source && !this.result ? "" : "disabled"}><i class="i" style="--i:url(./icon/crop-outline.svg)"></i></button>
        <button data-act="clean" class="${this.clean ? "on" : ""}" aria-label="${escape(T("clean"))}" aria-pressed="${this.clean}"><i class="i" style="--i:url(./icon/document-text-outline.svg)"></i></button>
        <button data-act="keep" aria-label="${escape(T("keep"))}" ${this.result ? "" : "disabled"}><i class="i" style="--i:url(./icon/add-outline.svg)"></i></button>
        <span class="grow"></span>
        <button data-act="image" aria-label="${escape(T("image"))}" ${this.result || this.pages.length ? "" : "disabled"}><i class="i" style="--i:url(./icon/image-outline.svg)"></i></button>
        <button data-act="pdf" aria-label="${escape(T("pdf"))}" ${count ? "" : "disabled"}><i class="i" style="--i:url(./icon/send-outline.svg)"></i></button>
      </div>
      <p class="note" ${this.note ? "" : "hidden"}>${escape(this.note ?? "")}</p>
      ${shown ? '<div class="stage"><canvas></canvas><svg><polygon points=""></polygon></svg>' + (this.result ? "" : [0, 1, 2, 3].map((i) => `<button class="handle" data-corner="${i}" aria-label="${escape(T("corners"))}"></button>`).join("")) + "</div>" : ""}
      <ol>${this.pages.map((page, at) => `<li><img alt="" src="${page.canvas.toDataURL("image/jpeg", 0.6)}"><span class="name">${at + 1}. ${escape(page.name)}</span><button data-act="drop" data-at="${at}" aria-label="${escape(T("drop"))}"><i class="i" style="--i:url(./icon/trash-outline.svg)"></i></button></li>`).join("")}</ol>
      <p class="note" ${count ? "" : "hidden"}>${count === 1 ? escape(T("page")) : escape(T("pages", { n: count }))}</p>
    `;
    this.stage = this.root.querySelector(".stage");
    if (shown && this.stage) {
      const canvas = this.stage.querySelector("canvas");
      const view = fit(shown.width, shown.height, VIEW_PIXELS);
      canvas.width = view.width;
      canvas.height = view.height;
      canvas.getContext("2d")?.drawImage(shown, 0, 0, view.width, view.height);
      if (!this.result) {
        this.stage.addEventListener("pointerdown", (event) => this.onDown(event));
        this.stage.addEventListener("pointermove", (event) => this.onMove(event));
        this.stage.addEventListener("pointerup", () => this.onUp());
        this.stage.addEventListener("pointercancel", () => this.onUp());
        this.stage.querySelector("svg").style.display = "";
        this.placeCorners();
      } else {
        this.stage.querySelector("svg").style.display = "none";
      }
    }
    this.root.querySelector(".bar").onclick = (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const { act } = button.dataset;
      if (act === "pick") this.again();
      else if (act === "scan") this.straighten();
      else if (act === "clean") this.toggleClean();
      else if (act === "keep") this.keep();
      else if (act === "image") this.sendImage();
      else if (act === "pdf") this.sendPdf();
    };
    this.root.querySelector("ol").onclick = (event) => {
      const button = event.target.closest("button[data-act='drop']");
      if (button) this.drop(Number(button.dataset.at));
    };
  }
}

function fit(width, height, max) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

if (!customElements.get("ft-scanner")) customElements.define("ft-scanner", Scanner);
