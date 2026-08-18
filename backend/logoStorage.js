const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Company logos live on the same persistent disk as the DB in production, same as photos
// (photoStorage.js) and leave/grievance attachments (fileStorage.js).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOGOS_DIR = path.join(DATA_DIR, 'uploads', 'logos');

if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

// PNG/JPEG only (not WEBP/SVG) — the whole point of a company logo here is to get embedded
// into the salary-slip PDF (routes/salary.js, via pdfkit's doc.image()), and pdfkit can only
// embed PNG and JPEG. Accepting a format it can't render would silently break the PDF later,
// so it's rejected up front instead, with a clear error, at upload time.
const DATA_URI_RE = /^data:image\/(png|jpeg|jpg);base64,(.+)$/;
const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB — logos should always be small

/**
 * Saves a base64 data-URI company logo to disk and returns a relative URL
 * (e.g. "/uploads/logos/company_3_1737012345678.png") to store on companies.logo_url.
 * If `previousUrl` is given and points at an earlier logo file for this company, that old
 * file is deleted (best-effort) so replacing a logo doesn't leave orphaned files behind.
 */
function saveLogoAndGetUrl(companyId, dataUri, previousUrl) {
  if (!dataUri || typeof dataUri !== 'string') {
    throw new Error('Logo must be an image file (PNG or JPEG)');
  }
  const match = dataUri.match(DATA_URI_RE);
  if (!match) {
    throw new Error('Logo must be a valid PNG or JPEG image');
  }

  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');

  if (buffer.length > MAX_SIZE_BYTES) {
    throw new Error('Logo is too large (max 2MB) — please use a smaller image');
  }

  const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const filename = `company_${companyId}_${uniqueSuffix}.${ext}`;
  const filePath = path.join(LOGOS_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  deleteLogoFile(previousUrl); // best-effort cleanup of the logo being replaced

  return `/uploads/logos/${filename}`;
}

// Best-effort delete of a previously-saved logo file, given its stored /uploads/logos/...
// URL. Silently does nothing if the URL is missing, external, or the file is already gone.
function deleteLogoFile(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string' || !logoUrl.startsWith('/uploads/logos/')) return;
  const filePath = path.join(LOGOS_DIR, path.basename(logoUrl));
  fs.unlink(filePath, () => {}); // ignore errors — not worth failing the request over
}

// Resolves a stored logo_url back to an actual filesystem path, for embedding into the
// salary-slip PDF via pdfkit's doc.image(absolutePath). Returns null if there's no logo, the
// URL isn't one of ours, or the file no longer exists on disk (so callers can fall back to a
// text-only header instead of crashing pdfkit).
function resolveLogoPath(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string' || !logoUrl.startsWith('/uploads/logos/')) return null;
  const filePath = path.join(LOGOS_DIR, path.basename(logoUrl));
  return fs.existsSync(filePath) ? filePath : null;
}

module.exports = { saveLogoAndGetUrl, deleteLogoFile, resolveLogoPath, LOGOS_DIR };
