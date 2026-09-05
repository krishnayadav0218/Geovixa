#!/usr/bin/env node
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------------------
// Automated database backup — pg_dump the Supabase Postgres DB, gzip it, keep a rotating
// local copy, and (optionally) push it to S3-compatible cloud storage.
//
// USAGE
//   node scripts/backup-db.js              (or: npm run backup)
//
// SCHEDULING — Render's web service plan doesn't run cron; use a separate Render "Cron Job"
// resource (see render.yaml's `geovixa-db-backup` service) pointed at this same repo/branch,
// scheduled e.g. daily at 02:00 IST. Any other host that can run `node` + `pg_dump` on a
// schedule (a real cron job, GitHub Actions, etc.) works too — this script has no Render-
// specific dependency.
//
// REQUIRES: the `pg_dump` binary on PATH (same major version as the Postgres server, or
// newer — Supabase's Postgres version is shown in Project Settings > Database). On Render's
// cron job image this is already present; locally, install the `postgresql-client` package.
//
// CLOUD UPLOAD (optional): set these env vars to also push each backup to any S3-compatible
// bucket (AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO, Supabase Storage's
// S3-compatible endpoint, etc.) — leave them unset to keep backups local-only (still useful
// on a host with a persistent disk, but on Render's free tier the disk itself is wiped on
// every restart, so cloud upload is what actually protects against that).
//   BACKUP_S3_ENDPOINT=https://s3.amazonaws.com   (or your provider's endpoint)
//   BACKUP_S3_BUCKET=my-geovixa-backups
//   BACKUP_S3_REGION=ap-south-1
//   BACKUP_S3_ACCESS_KEY_ID=...
//   BACKUP_S3_SECRET_ACCESS_KEY=...
// ---------------------------------------------------------------------------------------

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.env.DATA_DIR || __dirname, '..', 'backups');
const KEEP_LOCAL_BACKUPS = Number(process.env.BACKUP_KEEP_COUNT) || 14; // ~2 weeks of daily backups

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // e.g. 2026-09-03T02-00-00
}

function run() {
  return new Promise((resolve, reject) => {
    if (!process.env.DATABASE_URL) {
      return reject(new Error('DATABASE_URL is not set — nothing to back up.'));
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const filename = `geovixa-backup-${timestamp()}.sql.gz`;
    const filepath = path.join(BACKUP_DIR, filename);

    console.log(`[backup] Starting pg_dump -> ${filepath}`);
    // --no-owner/--no-privileges: keeps the dump restorable into a DB with a different
    // owner role (e.g. restoring into a fresh Supabase project during a disaster-recovery
    // drill) without ownership/GRANT statements failing on restore.
    const dump = spawn('pg_dump', [process.env.DATABASE_URL, '--no-owner', '--no-privileges', '--format=plain']);
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(filepath);

    let stderr = '';
    dump.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    dump.on('error', (err) => reject(new Error(`Failed to launch pg_dump — is it installed and on PATH? (${err.message})`)));

    dump.stdout.pipe(gzip).pipe(out);

    out.on('finish', () => {
      if (dump.exitCode && dump.exitCode !== 0) {
        fs.unlink(filepath, () => {});
        return reject(new Error(`pg_dump exited with code ${dump.exitCode}: ${stderr.trim()}`));
      }
      const sizeKb = Math.round(fs.statSync(filepath).size / 1024);
      console.log(`[backup] Done — ${filename} (${sizeKb} KB)`);
      resolve(filepath);
    });
    out.on('error', reject);

    dump.on('close', (code) => {
      if (code !== 0 && stderr) console.error(`[backup] pg_dump stderr: ${stderr.trim()}`);
    });
  });
}

// Deletes the oldest local backups beyond BACKUP_KEEP_COUNT, so a forgotten cron job doesn't
// slowly fill up disk over months.
function rotateLocalBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('geovixa-backup-') && f.endsWith('.sql.gz'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = files.slice(KEEP_LOCAL_BACKUPS);
  toDelete.forEach(({ f }) => {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[backup] Rotated out old local backup: ${f}`);
  });
}

// Optional upload to any S3-compatible bucket. Uses the AWS SDK v3 client ONLY if it's
// actually installed (`npm install @aws-sdk/client-s3` — deliberately NOT added to
// package.json's dependencies, since most self-hosted installs of this app won't use cloud
// backup at all and shouldn't have to carry that dependency weight). If the env vars are
// set but the package isn't installed, this fails loudly with the exact install command
// rather than silently skipping — a misconfigured backup should never look like a working one.
async function uploadToS3(filepath) {
  const { BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY } = process.env;
  if (!BACKUP_S3_BUCKET) return; // cloud upload not configured — local-only backup is fine

  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch (err) {
    throw new Error(
      'BACKUP_S3_BUCKET is set but @aws-sdk/client-s3 is not installed. Run:\n' +
      '  npm install @aws-sdk/client-s3\n' +
      'then re-run the backup — refusing to silently skip the cloud upload of a real backup.'
    );
  }

  const client = new S3Client({
    endpoint: BACKUP_S3_ENDPOINT || undefined,
    region: BACKUP_S3_REGION || 'auto',
    credentials: { accessKeyId: BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: BACKUP_S3_SECRET_ACCESS_KEY },
    forcePathStyle: Boolean(BACKUP_S3_ENDPOINT), // needed for most non-AWS S3-compatible providers
  });

  const key = `geovixa-db-backups/${path.basename(filepath)}`;
  console.log(`[backup] Uploading to s3://${BACKUP_S3_BUCKET}/${key}`);
  await client.send(new PutObjectCommand({
    Bucket: BACKUP_S3_BUCKET, Key: key, Body: fs.createReadStream(filepath), ContentType: 'application/gzip',
  }));
  console.log('[backup] Cloud upload complete.');
}

async function main() {
  try {
    const filepath = await run();
    rotateLocalBackups();
    await uploadToS3(filepath);
    if (!process.env.BACKUP_S3_BUCKET) {
      // Deliberately loud and repeated on every single run (not a one-time warning) — this
      // is exactly the kind of thing that's easy to miss once in a deploy log and then
      // forget about for months, right up until a restart wipes the only copy. A cron job
      // running silently "successfully" every night while actually protecting nothing is
      // worse than one that's visibly incomplete.
      console.warn('\n' + '='.repeat(78));
      console.warn('[backup] WARNING: BACKUP_S3_BUCKET is not set — this backup was saved');
      console.warn('[backup]          LOCAL-ONLY. On Render (web service or Cron Job), the');
      console.warn('[backup]          filesystem does NOT persist across restarts — this copy');
      console.warn('[backup]          will be lost. Set BACKUP_S3_* env vars (see .env.example)');
      console.warn('[backup]          to actually protect this data.');
      console.warn('='.repeat(78) + '\n');
    }
    console.log('[backup] All done.');
    process.exit(0);
  } catch (err) {
    console.error('[backup] FAILED:', err.message);
    // Non-zero exit so a cron/CI runner surfaces this as a failed job (email/Slack alert),
    // instead of a silently-broken backup nobody notices until they actually need one.
    process.exit(1);
  }
}

main();
