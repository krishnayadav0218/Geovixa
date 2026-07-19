const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Attachments live on the same persistent disk as the DB in production.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'uploads', 'attachments');

if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// Matches "data:<mime>;base64,<data>" for the file types the leave-attachment
// input accepts (image/*, .pdf, .doc, .docx — see public/index.html).
const DATA_URI_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/;

const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB, matches the frontend's own check

/**
 * Saves a base64 data-URI leave attachment (image, PDF, or Word doc) to disk
 * and returns a relative URL (e.g. "/uploads/attachments/EMP001_...pdf") to
 * store in the DB instead of the raw base64 string.
 *
 * If no attachment was provided, returns null. If the data URI's MIME type
 * isn't one we recognize, throws so the route can return a clear 400 error.
 */
function saveAttachmentAndGetUrl(employeeId, dataUri) {
  if (!dataUri) return null;
  if (typeof dataUri !== 'string') {
    throw new Error('Attachment must be a base64 data URI');
  }

  const match = dataUri.match(DATA_URI_RE);
  if (!match) {
    throw new Error('Attachment must be a valid file (image, PDF, or Word document)');
  }

  const mime = match[1].toLowerCase();
  const ext = MIME_TO_EXT[mime];
  if (!ext) {
    throw new Error('Unsupported attachment type. Allowed: images, PDF, DOC, DOCX');
  }

  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');

  if (buffer.length > MAX_SIZE_BYTES) {
    throw new Error('Attachment is too large (max 5MB)');
  }

  const safeEmployeeId = String(employeeId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const filename = `${safeEmployeeId}_${uniqueSuffix}.${ext}`;
  const filePath = path.join(ATTACHMENTS_DIR, filename);

  fs.writeFileSync(filePath, buffer);

  return `/uploads/attachments/${filename}`;
}

module.exports = { saveAttachmentAndGetUrl, ATTACHMENTS_DIR };
