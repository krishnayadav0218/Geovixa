const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Photos live on the same persistent disk as the DB in production.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PHOTOS_DIR = path.join(DATA_DIR, 'uploads', 'photos');

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// Matches things like "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
const DATA_URI_RE = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/;

/**
 * Saves a base64 data-URI selfie photo to disk and returns a relative URL
 * (e.g. "/uploads/photos/EMP001_1737012345678.jpg") to store in the DB instead
 * of the raw base64 string. Keeps the DB small and writes fast.
 *
 * If the input isn't a recognizable base64 data URI (e.g. it's already a
 * "/uploads/..." path from an older record, or something unexpected), it's
 * returned unchanged so nothing breaks.
 */
function savePhotoAndGetUrl(employeeId, dataUri) {
  if (!dataUri || typeof dataUri !== 'string') return dataUri;

  const match = dataUri.match(DATA_URI_RE);
  if (!match) return dataUri; // not a data URI we recognize — leave as-is (backward compatible)

  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');

  const safeEmployeeId = String(employeeId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const filename = `${safeEmployeeId}_${uniqueSuffix}.${ext}`;
  const filePath = path.join(PHOTOS_DIR, filename);

  fs.writeFileSync(filePath, buffer);

  return `/uploads/photos/${filename}`;
}

module.exports = { savePhotoAndGetUrl, PHOTOS_DIR };
