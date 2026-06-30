// routes/courses.js
const express = require('express');
const multer  = require('multer');
const jwt     = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../config/db');
const { initializeCourseStructure } = require('../services/course-structure');
const {
  logCourseTransaction,
  logStudentTransaction,
  logCertificateTransaction
} = require('../services/audit-log');
require('dotenv').config();

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
const contentDir = path.join(uploadDir, 'content');
const resourceDir = path.join(uploadDir, 'resources');
const certificateDir = path.join(uploadDir, 'certificates');
const websiteDir = path.join(__dirname, '..', '..', '..');
const certificateLogoCandidates = [
  path.join(websiteDir, 'NhpcLogo-certificate.jpg'),
  path.join(websiteDir, 'NhpcLogo.jpg'),
  path.join(websiteDir, 'NhpcLogo.png'),
  path.join(websiteDir, 'nhpc-logo.png')
];
// Certificate logo configuration (env-driven)
const rawLogoPosition = (process.env.CERTIFICATE_LOGO_POSITION || 'center').toLowerCase();
const CERTIFICATE_LOGO_POSITION = ['center', 'left'].includes(rawLogoPosition) ? rawLogoPosition : 'center';
const CERTIFICATE_LOGO_MAX_WIDTH = Number(process.env.CERTIFICATE_LOGO_MAX_WIDTH) || 220;
const CERTIFICATE_LOGO_MAX_HEIGHT = Number(process.env.CERTIFICATE_LOGO_MAX_HEIGHT) || 90;
const CERTIFICATE_LOGO_LEFT_MARGIN = Number(process.env.CERTIFICATE_LOGO_LEFT_MARGIN) || 60;
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });
if (!fs.existsSync(resourceDir)) fs.mkdirSync(resourceDir, { recursive: true });
if (!fs.existsSync(certificateDir)) fs.mkdirSync(certificateDir, { recursive: true });

const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeCourseDescription(value) {
  const allowedTags = new Set([
    'b', 'strong', 'i', 'em', 'u', 's', 'p', 'div', 'br', 'span',
    'h1', 'h2', 'h3', 'blockquote', 'ol', 'ul', 'li', 'a'
  ]);
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, (tag) => {
      const match = tag.match(/^<\s*(\/?)\s*([a-z0-9]+)([^>]*)>$/i);
      if (!match) return '';
      const closing = Boolean(match[1]);
      const name = match[2].toLowerCase();
      if (!allowedTags.has(name)) return '';
      if (name === 'br') return '<br>';
      if (closing) return `</${name}>`;

      const attributes = match[3] || '';
      const safeAttributes = [];
      if (name === 'a') {
        const href = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
        if (/^(https?:|mailto:)/i.test(href)) {
          safeAttributes.push(`href="${href.replace(/"/g, '&quot;')}"`, 'target="_blank"', 'rel="noopener noreferrer"');
        }
      }

      const className = attributes.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const safeClasses = className.split(/\s+/).filter(item =>
        /^(ql-align-(center|right|justify)|ql-font-(serif|monospace)|ql-indent-[1-8])$/.test(item)
      );
      if (safeClasses.length) safeAttributes.push(`class="${safeClasses.join(' ')}"`);

      const style = attributes.match(/\bstyle\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const safeStyles = style.split(';').map(item => item.trim()).filter(item =>
        /^(color|background-color):\s*(#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|[a-z]+)$/i.test(item)
      );
      if (safeStyles.length) safeAttributes.push(`style="${safeStyles.join(';')}"`);

      return `<${name}${safeAttributes.length ? ` ${safeAttributes.join(' ')}` : ''}>`;
    })
    .trim();
}

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension) ? extension : '.png';
      cb(null, `course-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    if (allowed.includes(file.mimetype) && allowedExts.has(ext)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WebP, or GIF images are allowed.'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Not logged in.' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ message: 'Invalid token.' }); }
}

function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next();
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

// Role middleware
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ message: 'Access denied.' });
    next();
  };
}

function authorizeCourseAccess(req, res, next) {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  db.query(
    `SELECT c.id, c.tutor_id, c.status,
            EXISTS(
              SELECT 1 FROM enrollments e
              WHERE e.course_id = c.id AND e.user_id = ?
            ) AS is_enrolled
     FROM courses c
     WHERE c.id = ?
     LIMIT 1`,
    [req.user.userId, courseId],
    (err, courses) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!courses.length) return res.status(404).json({ message: 'Course not found.' });

      const course = courses[0];
      const allowed =
        req.user.role === 'admin' ||
        (req.user.role === 'tutor' && Number(course.tutor_id) === Number(req.user.userId)) ||
        (req.user.role === 'student' && course.status === 'published' && Number(course.is_enrolled) === 1);

      if (!allowed) {
        return res.status(403).json({
          message: req.user.role === 'student'
            ? 'Enroll in this published course to view its content.'
            : 'Course access denied.'
        });
      }

      req.courseAccess = course;
      next();
    }
  );
}

const publishedCourseSelect = `
  SELECT c.*, u.name AS tutor_name,
         COUNT(ch.id) AS chapter_count
  FROM courses c
  LEFT JOIN users u ON u.id = c.tutor_id
  LEFT JOIN chapters ch ON ch.course_id = c.id
  WHERE c.status = 'published'
`;

function loadSections(courseId, includeResources, callback) {
  const resourceColumns = includeResources
    ? `, ch.main_content_type, ch.summary,
          CASE WHEN ch.main_content_type = 'video' THEN ch.video_url ELSE NULL END AS video_url,
          CASE WHEN ch.main_content_type = 'pdf' THEN ch.pdf_path ELSE NULL END AS pdf_path`
    : '';
  db.query(
    `SELECT s.id AS section_id, s.title AS section_title, s.section_order,
            ch.id, ch.title, ch.chapter_order${resourceColumns}
     FROM sections s
     LEFT JOIN chapters ch ON ch.section_id = s.id
     WHERE s.course_id = ?
     ORDER BY s.section_order, s.id, ch.chapter_order, ch.id`,
    [courseId],
    (err, rows) => {
      if (err) return callback(err);
      const sections = [];
      const byId = new Map();
      rows.forEach((row) => {
        if (!byId.has(row.section_id)) {
          const section = {
            id: row.section_id,
            title: row.section_title,
            section_order: row.section_order,
            lectures: []
          };
          byId.set(row.section_id, section);
          sections.push(section);
        }
        if (row.id) {
          const lecture = {
            id: row.id,
            section_id: row.section_id,
            title: row.title,
            chapter_order: row.chapter_order
          };
          if (includeResources) {
            lecture.main_content_type = row.main_content_type;
            lecture.summary = row.summary;
            lecture.video_url = row.video_url;
            lecture.pdf_path = row.pdf_path;
            lecture.resources = [];
          }
          byId.get(row.section_id).lectures.push(lecture);
        }
      });
      if (!includeResources) return callback(null, sections);
      const chapterIds = sections.flatMap(section => section.lectures.map(lecture => lecture.id));
      if (!chapterIds.length) return callback(null, sections);
      db.query(
        `SELECT id, chapter_id, resource_type, title, file_path, external_url
         FROM chapter_resources
         WHERE chapter_id IN (?)
         ORDER BY id`,
        [chapterIds],
        (resourceErr, resources) => {
          if (resourceErr) return callback(resourceErr);
          const chaptersById = new Map();
          sections.forEach(section => section.lectures.forEach(lecture => chaptersById.set(lecture.id, lecture)));
          resources.forEach(resource => chaptersById.get(resource.chapter_id)?.resources.push(resource));
          callback(null, sections);
        }
      );
    }
  );
}

function queryAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

function collectCourseFiles(rows) {
  return {
    imageFiles: new Set(rows.map(row => row.image_path).filter(Boolean)),
    pdfFiles: new Set(rows.map(row => row.pdf_path).filter(Boolean)),
    videoFiles: new Set(rows.map(row => row.video_url).filter(Boolean)),
    resourceFiles: new Set(rows.map(row => row.resource_file).filter(Boolean))
  };
}

function resolveStoredFilePath(fileName, baseDir) {
  const safeFileName = path.basename(String(fileName || ''));
  if (!safeFileName) return null;
  const resolvedPath = path.resolve(baseDir, safeFileName);
  const resolvedBase = path.resolve(baseDir);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(`${resolvedBase}${path.sep}`)) return null;
  return resolvedPath;
}

function safeDeleteFile(fileName, baseDir) {
  const resolvedPath = resolveStoredFilePath(fileName, baseDir);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) return;
  fs.unlink(resolvedPath, () => {});
}

function unlinkCourseFiles(files) {
  files.imageFiles.forEach(file => safeDeleteFile(file, uploadDir));
  files.pdfFiles.forEach(file => safeDeleteFile(file, uploadDir));
  files.videoFiles.forEach(file => safeDeleteFile(file, contentDir));
  files.resourceFiles.forEach(file => safeDeleteFile(file, resourceDir));
}

function permanentlyDeleteCourse(courseId, tutorId, callback) {
  const params = [courseId];
  const tutorClause = tutorId ? ' AND c.tutor_id = ?' : '';
  if (tutorId) params.push(tutorId);

  db.query(
    `SELECT c.image_path, ch.pdf_path, ch.video_url, cr.file_path AS resource_file
     FROM courses c
     LEFT JOIN chapters ch ON ch.course_id = c.id
     LEFT JOIN chapter_resources cr ON cr.chapter_id = ch.id
     WHERE c.id = ?${tutorClause}`,
    params,
    (findErr, rows) => {
      if (findErr) return callback(findErr);
      if (!rows.length) return callback(null, { notFound: true });

      const files = collectCourseFiles(rows);
      const deleteParams = [courseId];
      const deleteTutorClause = tutorId ? ' AND tutor_id = ?' : '';
      if (tutorId) deleteParams.push(tutorId);

      db.query(
        `DELETE FROM courses WHERE id = ?${deleteTutorClause}`,
        deleteParams,
        (deleteErr, result) => {
          if (deleteErr) return callback(deleteErr);
          if (!result.affectedRows) return callback(null, { notFound: true });
          unlinkCourseFiles(files);
          callback(null, { deleted: true });
        }
      );
    }
  );
}

function notifyAdminsOfDeleteRequest(course, done) {
  db.query("SELECT email FROM users WHERE role='admin' AND email IS NOT NULL", (adminErr, admins) => {
    if (adminErr) return done(false);
    const recipients = [...new Set(admins.map(admin => admin.email).filter(Boolean))];
    if (!recipients.length) return done(false);

    mailTransporter.sendMail({
      from: `"E-Learning" <${process.env.GMAIL_USER}>`,
      to: recipients.join(','),
      subject: `Course deletion requested: ${course.title}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:12px;">
          <h2 style="color:#1a3a5c;">Published Course Deletion Request</h2>
          <p>A tutor has requested deletion of a published course. Review it in the Admin Courses page.</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Course</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(course.title)}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Tutor</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(course.tutor_name)} (${escapeEmailHtml(course.tutor_email)})</td></tr>
            <tr><td style="padding:8px;"><strong>Requested</strong></td><td style="padding:8px;">${new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata' })}</td></tr>
          </table>
        </div>
      `
    }, (mailErr) => {
      if (mailErr) console.error('Course delete request email error:', mailErr.message);
      done(!mailErr);
    });
  });
}

function notifyAdminsOfCourseSubmission(course) {
  db.query("SELECT email FROM users WHERE role='admin' AND email IS NOT NULL", (adminErr, admins) => {
    if (adminErr) {
      console.error('Course submission admin lookup error:', adminErr.message);
      return;
    }

    const recipients = [...new Set(admins.map(admin => admin.email).filter(Boolean))];
    if (!recipients.length) return;

    const submittedAt = new Date();
    mailTransporter.sendMail({
      from: `"E-Learning" <${process.env.GMAIL_USER}>`,
      to: recipients.join(','),
      subject: `Course submitted for review: ${course.title}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:12px;">
          <h2 style="color:#1a3a5c;">New Course Submitted for Review</h2>
          <p>A tutor has submitted a course that is now visible in the Admin Dashboard under <strong>Submitted</strong>.</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Course</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(course.title)}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Tutor</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(course.tutor_name)} (${escapeEmailHtml(course.tutor_email)})</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Sections</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${Number(course.section_count)}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Chapters</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${Number(course.chapter_count)}</td></tr>
            <tr><td style="padding:8px;"><strong>Submitted</strong></td><td style="padding:8px;">${submittedAt.toLocaleString('en-IN', { timeZone:'Asia/Kolkata' })}</td></tr>
          </table>
          <p>Please sign in to E-Learning Admin Dashboard to preview and review the course.</p>
        </div>
      `
    }, (mailErr) => {
      if (mailErr) console.error('Course submission email error:', mailErr.message);
    });
  });
}

async function recalculateCourseProgress(userId, courseId, lastChapterId = null) {
  const totals = await queryAsync(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END), 0) AS completed
     FROM chapters ch
     LEFT JOIN lecture_progress lp
       ON lp.chapter_id = ch.id AND lp.course_id = ch.course_id AND lp.user_id = ?
     WHERE ch.course_id = ?`,
    [userId, courseId]
  );
  const total = Number(totals[0]?.total || 0);
  const completed = Number(totals[0]?.completed || 0);
  const percent = total ? Math.round((completed / total) * 10000) / 100 : 0;
  await queryAsync(
    `INSERT INTO course_progress (user_id, course_id, progress_percent, last_chapter_id, completed_at)
     VALUES (?, ?, ?, ?, CASE WHEN ? = 100 THEN NOW() ELSE NULL END)
     ON DUPLICATE KEY UPDATE
       progress_percent = VALUES(progress_percent),
       last_chapter_id = COALESCE(VALUES(last_chapter_id), last_chapter_id),
       completed_at = CASE
         WHEN VALUES(progress_percent) = 100 THEN COALESCE(completed_at, NOW())
         ELSE NULL
       END`,
    [userId, courseId, percent, lastChapterId, percent]
  );
  return { totalLectures: total, completedLectures: completed, progressPercent: percent };
}

function pdfText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

function estimatePdfTextWidth(value, fontSize) {
  return String(value ?? '').split('').reduce((width, char) => {
    if (char === ' ') return width + fontSize * 0.28;
    if ('ilI.,:;!|'.includes(char)) return width + fontSize * 0.24;
    if ('mwMW@#'.includes(char)) return width + fontSize * 0.82;
    if (/[A-Z]/.test(char)) return width + fontSize * 0.67;
    if (/[0-9]/.test(char)) return width + fontSize * 0.56;
    return width + fontSize * 0.50;
  }, 0);
}

function centeredPdfText(value, y, font = 'F1', fontSize = 14, color = '0.08 0.20 0.32') {
  const text = pdfText(value);
  const x = Math.max(60, (842 - estimatePdfTextWidth(text, fontSize)) / 2);
  return `BT /${font} ${fontSize} Tf ${color} rg ${x.toFixed(1)} ${y} Td (${text}) Tj ET`;
}

function drawLogoPanel() {
  return [
    'q 0.02 0.23 0.36 rg 271 438 300 78 re f Q',
    'q 0.03 0.62 0.82 rg 271 484 300 32 re f Q',
    'q 0.00 0.36 0.58 rg 271 458 300 22 re f Q',
    'q 0.00 0.55 0.78 RG 7 w 284 496 m 350 508 430 490 558 505 c S Q',
    'q 0.00 0.45 0.68 RG 6 w 283 470 m 360 486 430 452 560 470 c S Q',
    'BT /F2 32 Tf 1 1 1 rg 351 468 Td (NHPC) Tj ET',
    'BT /F1 9 Tf 1 1 1 rg 375 449 Td (A Navratna Company) Tj ET'
  ].join('\n');
}

function fitCenteredPdfText(value, y, font = 'F2', maxFontSize = 28, maxWidth = 610, color = '0.08 0.20 0.32') {
  const cleanValue = String(value ?? '').trim() || 'Course';
  let fontSize = maxFontSize;
  while (fontSize > 14 && estimatePdfTextWidth(cleanValue, fontSize) > maxWidth) fontSize -= 1;
  return centeredPdfText(cleanValue, y, font, fontSize, color);
}

function getJpegDimensions(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return null;
}

function readCertificateLogo() {
  for (const logoPath of certificateLogoCandidates) {
    if (!fs.existsSync(logoPath)) continue;
    const data = fs.readFileSync(logoPath);
    const size = getJpegDimensions(data);
    if (!size) continue;
    return { data, ...size };
  }
  return null;
}

function fitLogoWithin(width, height, maxWidth, maxHeight) {
  if (!width || !height) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
}

function buildCertificatePdf({ studentName, courseName, startDate, completionDate }) {
  const logo = readCertificateLogo();
  const fittedLogo = logo
    ? fitLogoWithin(logo.width, logo.height, CERTIFICATE_LOGO_MAX_WIDTH, CERTIFICATE_LOGO_MAX_HEIGHT)
    : { width: Math.round(CERTIFICATE_LOGO_MAX_WIDTH * 0.73), height: Math.round(CERTIFICATE_LOGO_MAX_HEIGHT * 0.71) };
  const logoWidth = fittedLogo.width;
  const logoHeight = fittedLogo.height;
  let logoX;
  const logoTop = 470;
  if (CERTIFICATE_LOGO_POSITION === 'left') {
    logoX = CERTIFICATE_LOGO_LEFT_MARGIN;
  } else {
    logoX = Math.round((842 - logoWidth) / 2);
  }
  const logoY = Math.round(logoTop - logoHeight);
  const lines = [
    'q 0.93 0.96 0.98 rg 0 0 842 595 re f Q',
    'q 1 1 1 rg 32 32 778 531 re f Q',
    'q 0.03 0.18 0.31 RG 5 w 42 42 758 511 re S Q',
    'q 0.89 0.58 0.18 RG 2 w 58 58 726 479 re S Q',
    'q 0.03 0.18 0.31 RG 1 w 74 74 694 447 re S Q',
    'q 0.03 0.18 0.31 rg 74 505 694 10 re f Q',
    'q 0.89 0.58 0.18 rg 74 80 694 8 re f Q',
    'q 0.89 0.58 0.18 rg 42 518 56 5 re f Q',
    'q 0.89 0.58 0.18 rg 744 518 56 5 re f Q',
    'q 0.89 0.58 0.18 rg 42 72 56 5 re f Q',
    'q 0.89 0.58 0.18 rg 744 72 56 5 re f Q',
    logo ? `q ${logoWidth} 0 0 ${logoHeight} ${logoX} ${logoY} cm /Logo Do Q` : drawLogoPanel(),
    centeredPdfText('Certificate of Completion', 342, 'F2', 34, '0.03 0.18 0.31'),
    centeredPdfText('This certificate is proudly presented to', 300, 'F1', 15, '0.28 0.34 0.40'),
    fitCenteredPdfText(studentName || 'Student', 254, 'F2', 30, 560, '0.03 0.18 0.31'),
    'q 0.89 0.58 0.18 RG 1.5 w 241 238 m 601 238 l S Q',
    centeredPdfText('for successfully completing', 208, 'F1', 15, '0.28 0.34 0.40'),
    fitCenteredPdfText(courseName || 'Course', 168, 'F2', 24, 620, '0.03 0.18 0.31'),
    centeredPdfText(`Start Date: ${startDate}`, 130, 'F1', 12, '0.28 0.34 0.40'),
    centeredPdfText(`Completion Date: ${completionDate}`, 110, 'F1', 12, '0.28 0.34 0.40'),
    centeredPdfText('NHPC E-Learning', 92, 'F2', 12, '0.03 0.18 0.31')
  ].join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> ${logo ? '/XObject << /Logo 7 0 R >>' : ''} >> /Contents 6 0 R >> endobj`,
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj',
    `6 0 obj << /Length ${Buffer.byteLength(lines, 'utf8')} >> stream\n${lines}\nendstream endobj`
  ];
  if (logo) {
    objects.push(`7 0 obj << /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.data.length} >> stream\n${logo.data.toString('latin1')}\nendstream endobj`);
  }
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${object}\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

function formatCertificateDate(value) {
  const date = new Date(value);
  return date.toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Kolkata'
  });
}

async function createCertificateFile(userId, courseId) {
  const rows = await queryAsync(
    `SELECT c.title AS course_title, u.name AS student_name,
            COALESCE(e.enrolled_at, c.created_at, NOW()) AS started_at,
            COALESCE(cp.completed_at, NOW()) AS completed_at
     FROM courses c
     INNER JOIN users u ON u.id = ?
     LEFT JOIN enrollments e ON e.course_id = c.id AND e.user_id = u.id
     LEFT JOIN course_progress cp ON cp.course_id = c.id AND cp.user_id = u.id
     WHERE c.id = ?
     LIMIT 1`,
    [userId, courseId]
  );
  if (!rows.length) return null;

  const fileName = `certificate-${userId}-${courseId}-${Date.now()}.pdf`;
  const certificatePath = path.join(certificateDir, fileName);
  fs.writeFileSync(certificatePath, buildCertificatePdf({
    studentName: rows[0].student_name || 'Student',
    courseName: rows[0].course_title || 'Course',
    startDate: formatCertificateDate(rows[0].started_at),
    completionDate: formatCertificateDate(rows[0].completed_at)
  }));
  return {
    fileName,
    certificatePath,
    certificateUrl: `certificates/${fileName}`
  };
}

// GET /api/courses — all published courses (public)
router.get('/', (req, res) => {
  db.query(
    `${publishedCourseSelect}
     GROUP BY c.id, u.name
     ORDER BY c.created_at DESC, c.id DESC`,
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      res.json(results);
    }
  );
});

// GET /api/courses/student — published courses with this student's enrollment state
router.get('/student', auth, requireRole('student'), (req, res) => {
  db.query(
    `SELECT c.*, u.name AS tutor_name,
            COUNT(DISTINCT ch.id) AS chapter_count,
            MAX(CASE WHEN e.id IS NULL THEN 0 ELSE 1 END) AS is_enrolled,
            MAX(e.enrolled_at) AS enrolled_at,
            (SELECT COUNT(*) FROM enrollments all_e WHERE all_e.course_id = c.id) AS enrollment_count,
            COALESCE(MAX(cp.progress_percent), 0) AS progress_percent,
            MAX(cp.last_chapter_id) AS last_chapter_id,
            MAX(CASE WHEN cp.completed_at IS NULL THEN 0 ELSE 1 END) AS is_completed
     FROM courses c
     LEFT JOIN users u ON u.id = c.tutor_id
     LEFT JOIN chapters ch ON ch.course_id = c.id
     LEFT JOIN enrollments e
       ON e.course_id = c.id AND e.user_id = ?
     LEFT JOIN course_progress cp
       ON cp.course_id = c.id AND cp.user_id = ?
     WHERE c.status = 'published'
     GROUP BY c.id, u.name
     ORDER BY c.created_at DESC, c.id DESC`,
    [req.user.userId, req.user.userId],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      res.json(results);
    }
  );
});

// GET /api/courses/admin/published - admin home: published courses with counts
router.get('/admin/published', auth, requireRole('admin'), (req, res) => {
  db.query(
    `SELECT c.id, c.title, c.description, c.status, c.image_path, c.approved_at,
            u.name AS tutor_name,
            COUNT(DISTINCT e.user_id) AS enrollment_count,
            COUNT(DISTINCT s.id) AS section_count,
            COUNT(DISTINCT ch.id) AS lecture_count
     FROM courses c
     LEFT JOIN users u ON u.id = c.tutor_id
     LEFT JOIN enrollments e ON e.course_id = c.id
     LEFT JOIN sections s ON s.course_id = c.id
     LEFT JOIN chapters ch ON ch.course_id = c.id
     WHERE c.status = 'published'
     GROUP BY c.id, u.name
     ORDER BY c.approved_at DESC, c.created_at DESC, c.id DESC`,
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      res.json(results);
    }
  );
});

// GET /api/courses/admin/summary - admin overview counts
router.get('/admin/summary', auth, requireRole('admin'), (req, res) => {
  db.query(
    `SELECT
       (SELECT COUNT(*) FROM users) AS total_users,
       (SELECT COUNT(*) FROM courses) AS total_courses,
       (SELECT COUNT(*) FROM courses WHERE status IN ('submitted', 'under_review', 'delete_requested')) AS pending_courses,
       (SELECT COUNT(*) FROM courses WHERE status = 'approved') AS approved_courses,
       (SELECT COUNT(*) FROM courses WHERE status = 'published') AS published_courses,
       (SELECT COUNT(*) FROM courses WHERE status = 'rejected') AS rejected_courses,
       (SELECT COUNT(*) FROM enrollments) AS total_enrollments`,
    (err, rows) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      res.json(rows[0] || {});
    }
  );
});

// GET /api/courses/admin/reports - audit report summary and recent activity
router.get('/admin/reports', auth, requireRole('admin'), async (req, res) => {
  try {
    await initializeCourseStructure();
    const [summaryRows, activityRows] = await Promise.all([
      queryAsync(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE role = 'student') AS total_students,
           (SELECT COUNT(*) FROM users WHERE role = 'tutor') AS total_tutors,
           (SELECT COUNT(*) FROM courses) AS total_courses,
           (SELECT COUNT(*) FROM courses WHERE status = 'published') AS total_published_courses,
           (SELECT COUNT(*) FROM enrollments) AS total_enrollments,
           (SELECT COUNT(*) FROM certificate_transaction_log) AS total_certificates_generated`
      ),
      queryAsync(
        `(SELECT 'course' AS log_type, ctl.transaction_id, ctl.course_id, NULL AS chapter_id,
                 ctl.user_id AS actor_id, ctl.user_role AS actor_role, ctl.action,
                 ctl.old_status, ctl.new_status, ctl.remarks, ctl.created_at,
                 c.title AS course_title, u.name AS actor_name
          FROM course_transaction_log ctl
          LEFT JOIN courses c ON c.id = ctl.course_id
          LEFT JOIN users u ON u.id = ctl.user_id)
         UNION ALL
         (SELECT 'student' AS log_type, stl.transaction_id, stl.course_id, stl.chapter_id,
                 stl.student_id AS actor_id, 'student' AS actor_role, stl.action,
                 NULL AS old_status, NULL AS new_status, stl.remarks, stl.created_at,
                 c.title AS course_title, u.name AS actor_name
          FROM student_transaction_log stl
          LEFT JOIN courses c ON c.id = stl.course_id
          LEFT JOIN users u ON u.id = stl.student_id)
         UNION ALL
         (SELECT 'discussion' AS log_type, dtl.transaction_id, dtl.course_id, NULL AS chapter_id,
                 dtl.student_id AS actor_id, 'student' AS actor_role, dtl.action,
                 NULL AS old_status, NULL AS new_status, NULL AS remarks, dtl.created_at,
                 c.title AS course_title, u.name AS actor_name
          FROM discussion_transaction_log dtl
          LEFT JOIN courses c ON c.id = dtl.course_id
          LEFT JOIN users u ON u.id = dtl.student_id)
         ORDER BY created_at DESC
         LIMIT 60`
      )
    ]);
    res.json({ summary: summaryRows[0] || {}, recentActivity: activityRows });
  } catch (err) {
    res.status(500).json({ message: 'Could not load reports.' });
  }
});

// GET /api/courses/enrolled — student's enrolled, published courses
router.get('/enrolled', auth, requireRole('student'), (req, res) => {
  db.query(
    `SELECT c.*, u.name AS tutor_name,
            COUNT(DISTINCT ch.id) AS chapter_count,
            MAX(e.enrolled_at) AS enrolled_at, 1 AS is_enrolled,
            COALESCE(MAX(cp.progress_percent), 0) AS progress_percent,
            MAX(cp.last_chapter_id) AS last_chapter_id,
            MAX(CASE WHEN cp.completed_at IS NULL THEN 0 ELSE 1 END) AS is_completed
     FROM courses c
     INNER JOIN enrollments e ON c.id = e.course_id
     LEFT JOIN users u ON u.id = c.tutor_id
     LEFT JOIN chapters ch ON ch.course_id = c.id
     LEFT JOIN course_progress cp
       ON cp.course_id = c.id AND cp.user_id = ?
     WHERE e.user_id = ? AND c.status = 'published'
     GROUP BY c.id, u.name
     ORDER BY enrolled_at DESC, c.created_at DESC`,
    [req.user.userId, req.user.userId],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      res.json(results);
    }
  );
});

// GET /api/courses/:courseId/image - public course thumbnail
router.get('/:courseId/image', (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  db.query('SELECT image_path FROM courses WHERE id = ? LIMIT 1', [courseId], (err, courses) => {
    if (err) return res.status(500).json({ message: 'Database error.' });
    if (!courses.length || !courses[0].image_path) {
      return res.status(404).json({ message: 'Course image not found.' });
    }

    const imageFile = path.join(uploadDir, path.basename(courses[0].image_path));
    if (!fs.existsSync(imageFile)) return res.status(404).json({ message: 'Course image file not found.' });
    res.sendFile(imageFile);
  });
});

// GET /api/courses/:courseId/details - public approved metadata and lecture list
router.get('/:courseId/details', optionalAuth, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  try {
    await initializeCourseStructure();
  } catch {
    return res.status(500).json({ message: 'Could not initialize course sections.' });
  }

  const studentId = req.user?.role === 'student' ? req.user.userId : 0;
  db.query(
    `SELECT c.id, c.title, c.description, c.status, c.emoji, c.image_path,
            u.name AS tutor_name,
            CASE WHEN e.id IS NULL THEN 0 ELSE 1 END AS is_enrolled,
            e.enrolled_at
     FROM courses c
     LEFT JOIN users u ON u.id = c.tutor_id
     LEFT JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
     WHERE c.id = ? AND c.status = 'published'
     LIMIT 1`,
    [studentId, courseId],
    (courseErr, courses) => {
      if (courseErr) return res.status(500).json({ message: 'Database error.' });
      if (!courses.length) return res.status(404).json({ message: 'Published course not found.' });

      loadSections(courseId, false, (sectionErr, sections) => {
        if (sectionErr) return res.status(500).json({ message: 'Database error.' });
        const totalLectures = sections.reduce((sum, section) => sum + section.lectures.length, 0);
        res.json({ course: courses[0], sections, totalLectures });
      });
    }
  );
});

// GET /api/courses/:courseId/content — enrolled student course and chapters
router.get('/:courseId/content', auth, authorizeCourseAccess, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }
  res.set('Cache-Control', 'no-store');

  try {
    await initializeCourseStructure();
  } catch {
    return res.status(500).json({ message: 'Could not initialize course sections.' });
  }

  db.query(
    `SELECT c.id, c.title, c.description, c.status, c.emoji, c.image_path,
            u.name AS tutor_name, u.email AS tutor_email
     FROM courses c
     LEFT JOIN users u ON u.id = c.tutor_id
     WHERE c.id = ?
     LIMIT 1`,
    [courseId],
    (courseErr, courses) => {
      if (courseErr) return res.status(500).json({ message: 'Database error.' });
      if (!courses.length) return res.status(404).json({ message: 'Course not found.' });

      const exposeContent = () => loadSections(courseId, true, (sectionErr, sections) => {
        if (sectionErr) return res.status(500).json({ message: 'Database error.' });
        const chapters = sections.flatMap(section => section.lectures);
        if (req.user.role !== 'student') {
          if (req.user.role === 'admin' && courses[0].status === 'submitted') {
            logCourseTransaction({
              courseId,
              userId: req.user.userId,
              userRole: req.user.role,
              action: 'FIRST_REVIEW_OPENED',
              oldStatus: 'submitted',
              newStatus: 'under_review',
              remarks: 'Admin opened course details for review.'
            });
          }
          return res.json({ course: courses[0], sections, chapters, viewerRole: req.user.role });
        }

        db.query(
          `SELECT cp.progress_percent, cp.last_chapter_id, cp.completed_at,
                  lp.chapter_id, lp.is_completed, lp.completed_at AS lecture_completed_at
           FROM course_progress cp
           LEFT JOIN lecture_progress lp
             ON lp.user_id = cp.user_id AND lp.course_id = cp.course_id
           WHERE cp.user_id = ? AND cp.course_id = ?`,
          [req.user.userId, courseId],
          (progressErr, progressRows) => {
            if (progressErr) return res.status(500).json({ message: 'Database error.' });
            const progress = {
              progress_percent: Number(progressRows[0]?.progress_percent || 0),
              last_chapter_id: progressRows[0]?.last_chapter_id || null,
              completed_at: progressRows[0]?.completed_at || null,
              completed_chapter_ids: progressRows
                .filter(row => Number(row.is_completed) === 1)
                .map(row => Number(row.chapter_id))
            };
            logStudentTransaction({
              studentId: req.user.userId,
              courseId,
              action: 'COURSE_VIEWED',
              remarks: 'Student opened course player.'
            });
            res.json({ course: courses[0], sections, chapters, viewerRole: req.user.role, progress });
          }
        );
      });

      if (req.user.role === 'admin' && ['draft', 'submitted'].includes(courses[0].status)) {
        return db.query(
          "UPDATE courses SET status='under_review' WHERE id = ? AND status IN ('draft', 'submitted')",
          [courseId],
          (reviewErr) => {
            if (reviewErr) return res.status(500).json({ message: 'Could not mark course under review.' });
            logCourseTransaction({
              courseId,
              userId: req.user.userId,
              userRole: req.user.role,
              action: 'UNDER_REVIEW',
              oldStatus: courses[0].status,
              newStatus: 'under_review',
              remarks: 'Course automatically marked under review when admin opened it.'
            });
            courses[0].status = 'under_review';
            exposeContent();
          }
        );
      }

      exposeContent();
    }
  );
});

// POST /api/courses/:courseId/progress/access - remember last opened lecture
router.post('/:courseId/progress/access', auth, requireRole('student'), authorizeCourseAccess, async (req, res) => {
  const courseId = Number(req.params.courseId);
  const chapterId = Number(req.body.chapterId);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    return res.status(400).json({ message: 'Invalid chapter ID.' });
  }

  try {
    const chapters = await queryAsync('SELECT id FROM chapters WHERE id = ? AND course_id = ? LIMIT 1', [chapterId, courseId]);
    if (!chapters.length) return res.status(404).json({ message: 'Chapter not found.' });
    const existingProgress = await queryAsync(
      'SELECT last_chapter_id, progress_percent FROM course_progress WHERE user_id = ? AND course_id = ? LIMIT 1',
      [req.user.userId, courseId]
    );
    await queryAsync(
      `INSERT INTO lecture_progress (user_id, course_id, chapter_id, last_accessed_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE last_accessed_at = NOW()`,
      [req.user.userId, courseId, chapterId]
    );
    const progress = await recalculateCourseProgress(req.user.userId, courseId, chapterId);
    logStudentTransaction({
      studentId: req.user.userId,
      courseId,
      chapterId,
      action: 'CHAPTER_OPENED',
      remarks: 'Student opened chapter.'
    });
    logStudentTransaction({
      studentId: req.user.userId,
      courseId,
      chapterId,
      action: existingProgress.length ? 'COURSE_RESUMED' : 'COURSE_STARTED',
      remarks: existingProgress.length ? 'Student resumed course.' : 'Student started course.'
    });
    res.json({ message: 'Last lecture saved.', ...progress, lastChapterId: chapterId });
  } catch (err) {
    res.status(500).json({ message: 'Could not save progress.' });
  }
});

// POST /api/courses/:courseId/progress/close - record when a student leaves a lecture
router.post('/:courseId/progress/close', auth, requireRole('student'), authorizeCourseAccess, async (req, res) => {
  const courseId = Number(req.params.courseId);
  const chapterId = Number(req.body.chapterId);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    return res.status(400).json({ message: 'Invalid chapter ID.' });
  }

  try {
    const chapters = await queryAsync('SELECT id FROM chapters WHERE id = ? AND course_id = ? LIMIT 1', [chapterId, courseId]);
    if (!chapters.length) return res.status(404).json({ message: 'Chapter not found.' });
    logStudentTransaction({
      studentId: req.user.userId,
      courseId,
      chapterId,
      action: 'CHAPTER_CLOSED',
      remarks: 'Student closed chapter.'
    });
    res.json({ message: 'Chapter close recorded.' });
  } catch (err) {
    res.status(500).json({ message: 'Could not record chapter close.' });
  }
});

// POST /api/courses/:courseId/progress/complete - mark lecture complete
router.post('/:courseId/progress/complete', auth, requireRole('student'), authorizeCourseAccess, async (req, res) => {
  const courseId = Number(req.params.courseId);
  const chapterId = Number(req.body.chapterId);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    return res.status(400).json({ message: 'Invalid chapter ID.' });
  }

  try {
    const chapters = await queryAsync('SELECT id FROM chapters WHERE id = ? AND course_id = ? LIMIT 1', [chapterId, courseId]);
    if (!chapters.length) return res.status(404).json({ message: 'Chapter not found.' });
    const beforeRows = await queryAsync(
      'SELECT progress_percent, completed_at FROM course_progress WHERE user_id = ? AND course_id = ? LIMIT 1',
      [req.user.userId, courseId]
    );
    await queryAsync(
      `INSERT INTO lecture_progress (user_id, course_id, chapter_id, is_completed, completed_at, last_accessed_at)
       VALUES (?, ?, ?, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         is_completed = 1,
         completed_at = COALESCE(completed_at, NOW()),
         last_accessed_at = NOW()`,
      [req.user.userId, courseId, chapterId]
    );
    const progress = await recalculateCourseProgress(req.user.userId, courseId, chapterId);
    logStudentTransaction({
      studentId: req.user.userId,
      courseId,
      chapterId,
      action: 'CHAPTER_COMPLETED',
      remarks: `Progress is ${progress.progressPercent}%.`
    });
    const wasComplete = Number(beforeRows[0]?.progress_percent || 0) >= 100 || Boolean(beforeRows[0]?.completed_at);
    if (progress.progressPercent >= 100 && !wasComplete) {
      logStudentTransaction({
        studentId: req.user.userId,
        courseId,
        action: 'COURSE_COMPLETED',
        remarks: 'Student completed all chapters.'
      });
    }
    res.json({
      message: progress.progressPercent === 100 ? 'Course completed.' : 'Lecture completed.',
      ...progress,
      lastChapterId: chapterId
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not update progress.' });
  }
});

// POST /api/courses/:courseId/certificate - generate certificate PDF after 100% progress
router.post('/:courseId/certificate', auth, requireRole('student'), authorizeCourseAccess, async (req, res) => {
  const courseId = Number(req.params.courseId);
  try {
    await initializeCourseStructure();
    const progress = await recalculateCourseProgress(req.user.userId, courseId);
    if (progress.progressPercent < 100) {
      return res.status(403).json({ message: 'Complete all lectures before generating a certificate.' });
    }

    const certificate = await createCertificateFile(req.user.userId, courseId);
    if (!certificate) return res.status(404).json({ message: 'Course not found.' });

    let certificateId = null;
    try {
      const certificateResult = await queryAsync(
        `INSERT INTO certificates (user_id, course_id, certificate_url, issued_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE certificate_url = VALUES(certificate_url), issued_at = NOW(), id = LAST_INSERT_ID(id)`,
        [req.user.userId, courseId, certificate.certificateUrl]
      );
      certificateId = certificateResult.insertId || null;
    } catch (dbErr) {
      console.error('Certificate record save error:', dbErr.message);
    }
    logStudentTransaction({
      studentId: req.user.userId,
      courseId,
      action: 'CERTIFICATE_GENERATED',
      remarks: 'Student generated certificate.'
    });
    logCertificateTransaction({ studentId: req.user.userId, courseId, certificateId });

    res.json({ message: 'Certificate generated.', certificateUrl: certificate.certificateUrl });
  } catch (err) {
    console.error('Certificate generation error:', err.message);
    res.status(500).json({ message: 'Could not generate certificate.' });
  }
});

// GET /api/courses/:courseId/certificate - download issued certificate
router.get('/:courseId/certificate', auth, requireRole('student'), authorizeCourseAccess, async (req, res) => {
  const courseId = Number(req.params.courseId);
  try {
    await initializeCourseStructure();
    const progress = await recalculateCourseProgress(req.user.userId, courseId);
    if (progress.progressPercent < 100) {
      return res.status(403).json({ message: 'Complete all lectures before downloading a certificate.' });
    }

    const certificate = await createCertificateFile(req.user.userId, courseId);
    if (!certificate) return res.status(404).json({ message: 'Course not found.' });

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.download(certificate.certificatePath, `E-Learning-certificate-${courseId}.pdf`);
  } catch (err) {
    console.error('Certificate download error:', err.message);
    res.status(500).json({ message: 'Could not download certificate.' });
  }
});

// GET /api/courses/:courseId/chapters/:chapterId/pdf — protected PDF download
router.get('/:courseId/chapters/:chapterId/pdf', auth, authorizeCourseAccess, (req, res) => {
  const courseId = Number(req.params.courseId);
  const chapterId = Number(req.params.chapterId);
  if (!Number.isInteger(courseId) || !Number.isInteger(chapterId)) {
    return res.status(400).json({ message: 'Invalid course or chapter ID.' });
  }

  db.query(
    `SELECT ch.pdf_path
     FROM chapters ch
     WHERE ch.id = ? AND ch.course_id = ? AND ch.main_content_type = 'pdf' AND ch.pdf_path IS NOT NULL
     LIMIT 1`,
    [chapterId, courseId],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!results.length) return res.status(404).json({ message: 'PDF not found or access denied.' });

      const pdfFile = path.join(__dirname, '..', '..', 'uploads', path.basename(results[0].pdf_path));
      if (!fs.existsSync(pdfFile)) return res.status(404).json({ message: 'PDF file not found.' });

      res.set('Cache-Control', 'no-store');
      res.sendFile(pdfFile);
    }
  );
});

router.get('/:courseId/chapters/:chapterId/video', auth, authorizeCourseAccess, (req, res) => {
  const courseId = Number(req.params.courseId);
  const chapterId = Number(req.params.chapterId);
  if (!Number.isInteger(courseId) || !Number.isInteger(chapterId)) {
    return res.status(400).json({ message: 'Invalid course or chapter ID.' });
  }

  db.query(
    `SELECT ch.video_url
     FROM chapters ch
     WHERE ch.id = ? AND ch.course_id = ? AND ch.main_content_type = 'video' AND ch.video_url IS NOT NULL
     LIMIT 1`,
    [chapterId, courseId],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!results.length) return res.status(404).json({ message: 'Video not found or access denied.' });

      const videoFile = path.join(contentDir, path.basename(results[0].video_url));
      if (!fs.existsSync(videoFile)) return res.status(404).json({ message: 'Video file not found.' });
      res.set('Cache-Control', 'no-store');
      res.sendFile(videoFile);
    }
  );
});

router.get('/:courseId/resources/:resourceId', auth, authorizeCourseAccess, (req, res) => {
  const courseId = Number(req.params.courseId);
  const resourceId = Number(req.params.resourceId);
  if (!Number.isInteger(courseId) || !Number.isInteger(resourceId)) {
    return res.status(400).json({ message: 'Invalid course or resource ID.' });
  }
  db.query(
    `SELECT cr.file_path
     FROM chapter_resources cr
     INNER JOIN chapters ch ON ch.id = cr.chapter_id
     WHERE cr.id = ? AND ch.course_id = ? AND cr.file_path IS NOT NULL
     LIMIT 1`,
    [resourceId, courseId],
    (err, resources) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!resources.length) return res.status(404).json({ message: 'Resource not found or access denied.' });
      const resourceFile = path.join(resourceDir, path.basename(resources[0].file_path));
      if (!fs.existsSync(resourceFile)) return res.status(404).json({ message: 'Resource file not found.' });
      if (req.user.role === 'student') {
        logStudentTransaction({
          studentId: req.user.userId,
          courseId,
          action: 'RESOURCE_DOWNLOADED',
          remarks: `Resource ${resourceId} downloaded.`
        });
      }
      res.sendFile(resourceFile);
    }
  );
});

// GET /api/courses/my — tutor's own courses
router.get('/my', auth, requireRole('tutor'), (req, res) => {
  db.query('SELECT * FROM courses WHERE tutor_id = ? ORDER BY created_at DESC, id DESC', [req.user.userId], (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error.' });
    res.json(results);
  });
});

// GET /api/courses/pending — admin sees all pending courses and delete requests
router.get('/pending', auth, requireRole('admin'), (req, res) => {
  db.query(
    `SELECT c.*, u.name AS tutor_name,
            COUNT(DISTINCT e.user_id) AS enrollment_count,
            COUNT(DISTINCT s.id) AS section_count,
            COUNT(DISTINCT ch.id) AS lecture_count
     FROM courses c
     JOIN users u ON c.tutor_id = u.id
     LEFT JOIN enrollments e ON e.course_id = c.id
     LEFT JOIN sections s ON s.course_id = c.id
     LEFT JOIN chapters ch ON ch.course_id = c.id
     WHERE c.status IN ('draft', 'submitted', 'under_review', 'approved', 'published', 'unpublished', 'rejected', 'changes_requested', 'delete_requested')
     GROUP BY c.id, u.name
     ORDER BY c.review_submitted_at DESC, c.created_at DESC, c.id DESC`,
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      res.json(results);
    }
  );
});

// GET /api/courses/all — admin sees all courses
router.get('/all', auth, requireRole('admin'), (req, res) => {
  db.query(
    `SELECT c.*, u.name as tutor_name,
            COUNT(DISTINCT e.user_id) AS enrollment_count,
            COUNT(DISTINCT s.id) AS section_count,
            COUNT(DISTINCT ch.id) AS lecture_count
     FROM courses c
     JOIN users u ON c.tutor_id = u.id
     LEFT JOIN enrollments e ON e.course_id = c.id
     LEFT JOIN sections s ON s.course_id = c.id
     LEFT JOIN chapters ch ON ch.course_id = c.id
     GROUP BY c.id, u.name
     ORDER BY c.created_at DESC, c.id DESC`,
    (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error.' });
    res.json(results);
  });
});

// POST /api/courses/create — tutor creates course
router.post('/create', auth, requireRole('tutor'), (req, res) => {
  imageUpload.single('image')(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ message: uploadErr.message || 'Could not upload image.' });

    const title = String(req.body.title || '').trim();
    const description = sanitizeCourseDescription(req.body.description);
    if (!title) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: 'Title is required.' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Course thumbnail is required.' });
    }

    const imagePath = req.file.filename;
    db.query(
      `INSERT INTO courses
        (title, description, emoji, image_path, tutor_id, status)
       VALUES (?, ?, ?, ?, ?, 'draft')`,
      [title, description, 'Course', imagePath, req.user.userId],
      (err, result) => {
        if (err) {
          if (req.file) fs.unlink(req.file.path, () => {});
          return res.status(500).json({ message: 'Could not create course.', error: err.message });
        }
        logCourseTransaction({
          courseId: result.insertId,
          userId: req.user.userId,
          userRole: req.user.role,
          action: 'COURSE_CREATED',
          oldStatus: null,
          newStatus: 'draft',
          remarks: 'Tutor created course draft.'
        });
        logCourseTransaction({
          courseId: result.insertId,
          userId: req.user.userId,
          userRole: req.user.role,
          action: 'THUMBNAIL_UPDATED',
          oldStatus: null,
          newStatus: 'draft',
          remarks: 'Tutor added course thumbnail.'
        });
        res.status(201).json({
          message: 'Course created as draft!',
          courseId: result.insertId,
          image_path: imagePath
        });
      }
    );
  });
});

// DELETE /api/courses/:courseId - tutors can delete unpublished courses; published courses need admin approval
router.delete('/:courseId', auth, requireRole('tutor'), (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  db.query(
    `SELECT c.id, c.title, c.status, u.name AS tutor_name, u.email AS tutor_email
     FROM courses c
     INNER JOIN users u ON u.id = c.tutor_id
     WHERE c.id = ? AND c.tutor_id = ?
     LIMIT 1`,
    [courseId, req.user.userId],
    (findErr, courses) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      if (!courses.length) return res.status(404).json({ message: 'Course not found.' });

      const course = courses[0];
      if (course.status === 'delete_requested') {
        return res.status(409).json({ message: 'Deletion is already waiting for admin approval.' });
      }

      if (course.status === 'published') {
        db.query(
          "UPDATE courses SET status='delete_requested', review_submitted_at=NOW() WHERE id=? AND tutor_id=?",
          [courseId, req.user.userId],
          (requestErr) => {
            if (requestErr) return res.status(500).json({ message: 'Could not request course deletion.' });
            logCourseTransaction({
              courseId,
              userId: req.user.userId,
              userRole: req.user.role,
              action: 'COURSE_UPDATED',
              oldStatus: course.status,
              newStatus: 'delete_requested',
              remarks: 'Tutor requested deletion for a published course.'
            });
            notifyAdminsOfDeleteRequest(course, (emailSent) => {
              res.json({
                message: 'Deletion request sent to admin. The course is unpublished while it waits for approval.',
                status: 'delete_requested',
                emailSent
              });
            });
          }
        );
        return;
      }

      permanentlyDeleteCourse(courseId, req.user.userId, (deleteErr, result) => {
        if (deleteErr) return res.status(500).json({ message: 'Could not delete course.' });
        if (result?.notFound) return res.status(404).json({ message: 'Course not found.' });
        res.json({ message: 'Course deleted permanently.' });
      });
    }
  );
});

// PUT /api/courses/:courseId - tutor edits an owned course
router.put('/:courseId', auth, requireRole('tutor'), (req, res) => {
  imageUpload.single('image')(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ message: uploadErr.message || 'Could not upload image.' });

    const courseId = Number(req.params.courseId);
    const title = String(req.body.title || '').trim();
    const description = sanitizeCourseDescription(req.body.description);
    if (!Number.isInteger(courseId) || courseId < 1 || !title) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: 'Valid course ID and title are required.' });
    }

    db.query(
      'SELECT image_path FROM courses WHERE id = ? AND tutor_id = ? LIMIT 1',
      [courseId, req.user.userId],
      (findErr, courses) => {
        if (findErr) {
          if (req.file) fs.unlink(req.file.path, () => {});
          return res.status(500).json({ message: 'Database error.' });
        }
        if (!courses.length) {
          if (req.file) fs.unlink(req.file.path, () => {});
          return res.status(404).json({ message: 'Course not found.' });
        }

        const oldImagePath = courses[0].image_path;
        if (!oldImagePath && !req.file) {
          return res.status(400).json({ message: 'Course thumbnail is required.' });
        }
        const imagePath = req.file ? req.file.filename : oldImagePath;
        db.query(
          `UPDATE courses
           SET title = ?, description = ?, image_path = ?,
               status = CASE WHEN status IN ('submitted', 'under_review', 'approved', 'published', 'unpublished', 'rejected', 'changes_requested', 'delete_requested') THEN 'draft' ELSE status END
           WHERE id = ? AND tutor_id = ?`,
          [title, description, imagePath, courseId, req.user.userId],
          (updateErr) => {
            if (updateErr) {
              if (req.file) fs.unlink(req.file.path, () => {});
              return res.status(500).json({ message: 'Could not update course.' });
            }
            if (req.file && oldImagePath && oldImagePath !== imagePath) {
              fs.unlink(path.join(uploadDir, path.basename(oldImagePath)), () => {});
            }
            db.query('SELECT status, image_path FROM courses WHERE id = ?', [courseId], (statusErr, updated) => {
              if (statusErr) return res.status(500).json({ message: 'Course updated, but status could not be loaded.' });
              logCourseTransaction({
                courseId,
                userId: req.user.userId,
                userRole: req.user.role,
                action: 'COURSE_UPDATED',
                oldStatus: null,
                newStatus: updated[0].status,
                remarks: 'Tutor updated course details.'
              });
              if (req.file) {
                logCourseTransaction({
                  courseId,
                  userId: req.user.userId,
                  userRole: req.user.role,
                  action: 'THUMBNAIL_UPDATED',
                  oldStatus: null,
                  newStatus: updated[0].status,
                  remarks: 'Tutor updated course thumbnail.'
                });
              }
              res.json({
                message: 'Course updated successfully.',
                status: updated[0].status,
                image_path: updated[0].image_path
              });
            });
          }
        );
      }
    );
  });
});

// POST /api/courses/enroll — student enrolls
router.post('/enroll', auth, requireRole('student'), (req, res) => {
  const courseId = Number(req.body.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  db.query(
    "SELECT id FROM courses WHERE id = ? AND status = 'published' LIMIT 1",
    [courseId],
    (courseErr, courses) => {
      if (courseErr) return res.status(500).json({ message: 'Enrollment failed.' });
      if (!courses.length) {
        return res.status(404).json({ message: 'Published course not found.' });
      }

      db.query(
        'SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? LIMIT 1',
        [req.user.userId, courseId],
        (enrollmentErr, enrollments) => {
          if (enrollmentErr) return res.status(500).json({ message: 'Enrollment failed.' });
          if (enrollments.length) {
            return res.json({ message: 'Already enrolled.', enrolled: true });
          }

          db.query(
            'INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)',
            [req.user.userId, courseId],
            (insertErr) => {
              if (insertErr) return res.status(500).json({ message: 'Enrollment failed.' });
              db.query(
                'SELECT enrolled_at FROM enrollments WHERE user_id = ? AND course_id = ? LIMIT 1',
                [req.user.userId, courseId],
                (dateErr, rows) => {
                  logStudentTransaction({
                    studentId: req.user.userId,
                    courseId,
                    action: 'COURSE_ENROLLED',
                    remarks: 'Student enrolled in course.'
                  });
                  if (dateErr) return res.status(201).json({ message: 'Enrolled successfully!', enrolled: true });
                  res.status(201).json({
                    message: 'Enrolled successfully!',
                    enrolled: true,
                    enrolled_at: rows[0]?.enrolled_at || null
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// POST /api/courses/review — admin approves or denies
router.post('/review', auth, requireRole('admin'), (req, res) => {
  const courseId = Number(req.body.courseId);
  const status = String(req.body.status || '');
  const feedback = String(req.body.feedback || '').trim();
  const allowedStatuses = ['approved', 'published', 'unpublished', 'rejected', 'changes_requested'];
  if (!Number.isInteger(courseId) || courseId < 1 || !allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid course or status.' });
  }
  if (['unpublished', 'rejected', 'changes_requested'].includes(status) && !feedback) {
    return res.status(400).json({ message: 'Feedback is required for this review action.' });
  }

  db.query(
    `SELECT c.id, c.title, c.status, u.name AS tutor_name, u.email AS tutor_email
     FROM courses c
     INNER JOIN users u ON u.id = c.tutor_id
     WHERE c.id = ?
     LIMIT 1`,
    [courseId],
    (findErr, courses) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      if (!courses.length) return res.status(404).json({ message: 'Course not found.' });

      const course = courses[0];
      if (course.status === 'delete_requested') {
        if (status === 'approved') {
          return permanentlyDeleteCourse(courseId, null, (deleteErr, result) => {
            if (deleteErr) return res.status(500).json({ message: 'Could not delete course.' });
            if (result?.notFound) return res.status(404).json({ message: 'Course not found.' });

            const finishDelete = (emailSent) => res.json({
              message: 'Course deletion approved and course removed.',
              status: 'deleted',
              emailSent
            });
            logCourseTransaction({
              courseId,
              userId: req.user.userId,
              userRole: req.user.role,
              action: 'APPROVED',
              oldStatus: course.status,
              newStatus: 'deleted',
              remarks: 'Admin approved course deletion.'
            });

            if (!course.tutor_email) return finishDelete(false);
            mailTransporter.sendMail({
              from: `"E-Learning" <${process.env.GMAIL_USER}>`,
              to: course.tutor_email,
              subject: 'Course Deletion Approved',
              html: `
                <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:12px;">
                  <h2 style="color:#1a3a5c;">Course Deletion Approved</h2>
                  <p>Hello ${escapeEmailHtml(course.tutor_name || 'Tutor')},</p>
                  <p>Your deletion request was approved and the course has been removed.</p>
                  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
                    <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Course</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(course.title)}</td></tr>
                  </table>
                </div>
              `
            }, (mailErr) => {
              if (mailErr) console.error('Course deletion approval email error:', mailErr.message);
              finishDelete(!mailErr);
            });
          });
        }

        if (!feedback) {
          return res.status(400).json({ message: 'Feedback is required when denying a deletion request.' });
        }

        return db.query(
          "UPDATE courses SET status='published' WHERE id = ?",
          [courseId],
          (restoreErr) => {
            if (restoreErr) return res.status(500).json({ message: 'Database error.' });
            const finishRestore = (emailSent) => res.json({
              message: 'Deletion request denied. Course restored as published.',
              status: 'published',
              emailSent
            });
            logCourseTransaction({
              courseId,
              userId: req.user.userId,
              userRole: req.user.role,
              action: 'REJECTED',
              oldStatus: course.status,
              newStatus: 'published',
              remarks: feedback || 'Admin denied course deletion request.'
            });

            if (!course.tutor_email) return finishRestore(false);
            mailTransporter.sendMail({
              from: `"E-Learning" <${process.env.GMAIL_USER}>`,
              to: course.tutor_email,
              subject: 'Course Deletion Request Rejected',
              html: `
                <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:12px;">
                  <h2 style="color:#1a3a5c;">Deletion Request Rejected</h2>
                  <p>Hello ${escapeEmailHtml(course.tutor_name || 'Tutor')},</p>
                  <p>Your course remains published.</p>
                  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
                    <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Course</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(course.title)}</td></tr>
                    <tr><td style="padding:8px;vertical-align:top;"><strong>Admin feedback</strong></td><td style="padding:8px;">${escapeEmailHtml(feedback)}</td></tr>
                  </table>
                </div>
              `
            }, (mailErr) => {
              if (mailErr) console.error('Course deletion denial email error:', mailErr.message);
              finishRestore(!mailErr);
            });
          }
        );
      }

      const validTransitions = {
        draft: ['approved', 'published', 'rejected', 'changes_requested'],
        submitted: ['approved', 'published', 'rejected', 'changes_requested'],
        under_review: ['approved', 'published', 'rejected', 'changes_requested'],
        approved: ['published', 'rejected', 'changes_requested'],
        published: ['unpublished'],
        unpublished: ['published']
      };
      if (!validTransitions[course.status]?.includes(status)) {
        return res.status(409).json({ message: 'This review action is not available for the current course status.' });
      }
      db.query(
        `UPDATE courses
         SET status = ?,
             approved_at = CASE WHEN ? IN ('approved', 'published') THEN NOW() ELSE approved_at END,
             denied_at = CASE WHEN ? = 'rejected' THEN NOW() ELSE denied_at END
         WHERE id = ?`,
        [status, status, status, courseId],
        (updateErr) => {
        if (updateErr) return res.status(500).json({ message: 'Database error.' });
        logCourseTransaction({
          courseId,
          userId: req.user.userId,
          userRole: req.user.role,
          action: status.toUpperCase(),
          oldStatus: course.status,
          newStatus: status,
          remarks: feedback || null
        });

        const actionDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const reviewCopy = {
          approved: {
            subject: 'Course Approved',
            heading: 'Your Course Has Been Approved',
            actionLabel: 'Approved',
            message: 'Your course has been approved. It will become visible to students after an admin publishes it.',
            response: 'Course approved.'
          },
          published: {
            subject: 'Course Published',
            heading: 'Your Course Has Been Published',
            actionLabel: 'Published',
            message: 'Your course is now published and visible to students.',
            response: 'Course published.'
          },
          unpublished: {
            subject: 'Course Unpublished',
            heading: 'Your Course Has Been Unpublished',
            actionLabel: 'Unpublished',
            message: 'Your course has been unpublished and is no longer visible to students.',
            response: 'Course unpublished.'
          },
          rejected: {
            subject: 'Course Rejected',
            heading: 'Your Course Was Rejected',
            actionLabel: 'Rejected',
            message: 'Your course was rejected after review.',
            response: 'Course rejected.'
          },
          changes_requested: {
            subject: 'Course Changes Requested',
            heading: 'Changes Were Requested',
            actionLabel: 'Changes Requested',
            message: 'An admin requested changes before this course can be approved.',
            response: 'Changes requested.'
          }
        }[status];
        const finish = (emailSent) => res.json({
          message: reviewCopy.response,
          status,
          emailSent
        });

        if (!course.tutor_email) return finish(false);
        mailTransporter.sendMail({
          from: `"E-Learning" <${process.env.GMAIL_USER}>`,
          to: course.tutor_email,
          subject: reviewCopy.subject,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:12px;">
              <h2 style="color:#1a3a5c;">${reviewCopy.heading}</h2>
              <p>Hello ${escapeEmailHtml(course.tutor_name || 'Tutor')},</p>
              <p>${reviewCopy.message}</p>
              <table style="width:100%;border-collapse:collapse;margin:20px 0;">
                <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Course</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(course.title)}</td></tr>
                <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${reviewCopy.actionLabel}</strong></td><td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(actionDate)}</td></tr>
                ${feedback ? `<tr><td style="padding:8px;vertical-align:top;"><strong>Admin feedback</strong></td><td style="padding:8px;">${escapeEmailHtml(feedback)}</td></tr>` : ''}
              </table>
            </div>
          `
        }, (mailErr) => {
          if (mailErr) {
            console.error('Course action email error:', mailErr.message);
            return finish(false);
          }
          finish(true);
        });
        }
      );
    }
  );
});

// POST /api/courses/submit — tutor submits course for review
router.post('/submit', auth, requireRole('tutor'), (req, res) => {
  const courseId = Number(req.body.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }
  db.query(
    `SELECT c.id, c.title, c.image_path, c.status,
            u.name AS tutor_name, u.email AS tutor_email,
            COUNT(DISTINCT ch.id) AS chapter_count,
            COUNT(DISTINCT s.id) AS section_count,
            COUNT(DISTINCT CASE
              WHEN ch.id IS NOT NULL AND (
                ch.main_content_type NOT IN ('video', 'pdf')
                OR (ch.main_content_type = 'video' AND ch.video_url IS NULL)
                OR (ch.main_content_type = 'pdf' AND ch.pdf_path IS NULL)
              ) THEN ch.id
            END) AS incomplete_chapter_count
     FROM courses c
     INNER JOIN users u ON u.id = c.tutor_id
     LEFT JOIN sections s ON s.course_id = c.id
     LEFT JOIN chapters ch ON ch.course_id = c.id
     WHERE c.id = ? AND c.tutor_id = ?
     GROUP BY c.id, c.title, c.image_path, c.status, u.name, u.email
     LIMIT 1`,
    [courseId, req.user.userId],
    (courseErr, courses) => {
      if (courseErr) return res.status(500).json({ message:'Database error.' });
      if (!courses.length) return res.status(404).json({ message:'Course not found.' });
      const course = courses[0];
      if (['submitted', 'under_review'].includes(course.status)) {
        return res.status(409).json({ message:'This course is already in admin review.' });
      }
      if (['approved', 'published'].includes(course.status)) {
        return res.status(409).json({ message:'This course is already published.' });
      }
      if (!course.image_path) {
        return res.status(400).json({ message:'Add a course thumbnail before submitting for review.' });
      }
      if (!Number(course.chapter_count)) {
        return res.status(400).json({ message:'Add at least one chapter before submitting for review.' });
      }
      if (Number(course.incomplete_chapter_count)) {
        return res.status(400).json({
          message:'Every chapter must have a valid main Video or PDF before submission.'
        });
      }

      db.query(
        "UPDATE courses SET status='submitted', review_submitted_at=NOW() WHERE id=? AND tutor_id=?",
        [courseId, req.user.userId],
        (err) => {
          if (err) return res.status(500).json({ message:'Database error.' });
          logCourseTransaction({
            courseId,
            userId: req.user.userId,
            userRole: req.user.role,
            action: 'SUBMITTED_FOR_REVIEW',
            oldStatus: course.status,
            newStatus: 'submitted',
            remarks: 'Tutor submitted course for review.'
          });
          res.json({ message:'Course submitted for review successfully.', status:'submitted' });
          notifyAdminsOfCourseSubmission(course);
        }
      );
    }
  );
});

module.exports = router;
