const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { initializeCourseStructure } = require('../services/course-structure');
const { logCourseTransaction, logStudentTransaction } = require('../services/audit-log');
require('dotenv').config();

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
const contentDir = path.join(uploadDir, 'content');
const resourceDir = path.join(uploadDir, 'resources');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });
if (!fs.existsSync(resourceDir)) fs.mkdirSync(resourceDir, { recursive: true });

const allowedUploadExtensions = {
  pdf: new Set(['.pdf']),
  video: new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
};

function detectUploadType(fieldName) {
  if (['pdf', 'mainPdf', 'resourcePdfs'].includes(fieldName)) return 'pdf';
  if (['video', 'mainVideo'].includes(fieldName)) return 'video';
  if (fieldName === 'resourceImages') return 'image';
  return null;
}

function buildSafeFileName(originalName, prefix, type) {
  const safeExt = path.extname(String(originalName || '')).toLowerCase();
  const allowedExts = type ? allowedUploadExtensions[type] : null;
  const ext = allowedExts?.has(safeExt) ? safeExt : '';
  const baseName = path.basename(String(originalName || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const cleanBase = baseName.replace(/^_+|_+$/g, '').replace(/\s+/g, '_') || 'file';
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}-${cleanBase}${ext}`;
}

function isSafePathWithinDirectory(targetPath, baseDir) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}

function resolveStoredFilePath(fileName, baseDir) {
  const safeFileName = path.basename(String(fileName || ''));
  if (!safeFileName) return null;
  const resolvedPath = path.resolve(baseDir, safeFileName);
  return isSafePathWithinDirectory(resolvedPath, baseDir) ? resolvedPath : null;
}

function safeDeleteFile(fileName, baseDir) {
  const resolvedPath = resolveStoredFilePath(fileName, baseDir);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) return;
  fs.unlink(resolvedPath, () => {});
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Not logged in.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token.' });
  }
}

function requireTutor(req, res, next) {
  if (req.user.role !== 'tutor') {
    return res.status(403).json({ message: 'Tutor access required.' });
  }
  next();
}

function ownsCourse(req, res, next) {
  const courseId = Number(req.body?.courseId ?? req.params?.courseId ?? req.query?.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    const chapterId = Number(req.params?.chapterId || req.params?.id);
    const sectionId = Number(req.params?.sectionId);
    const lookup = (sql, params) => {
      db.query(sql, params, (err, rows) => {
        if (err) {
          removeUploadedFiles(req);
          return res.status(500).json({ message: 'Database error.' });
        }
        if (!rows.length) {
          removeUploadedFiles(req);
          return res.status(400).json({ message: 'Invalid course ID.' });
        }
        req.courseId = Number(rows[0].course_id);
        next();
      });
    };

    if (chapterId) {
      return lookup(
        'SELECT ch.course_id FROM chapters ch INNER JOIN courses c ON c.id = ch.course_id WHERE ch.id = ? AND c.tutor_id = ? LIMIT 1',
        [chapterId, req.user.userId]
      );
    }

    if (sectionId) {
      return lookup(
        'SELECT s.course_id FROM sections s INNER JOIN courses c ON c.id = s.course_id WHERE s.id = ? AND c.tutor_id = ? LIMIT 1',
        [sectionId, req.user.userId]
      );
    }

    removeUploadedFiles(req);
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  db.query(
    'SELECT id FROM courses WHERE id = ? AND tutor_id = ? LIMIT 1',
    [courseId, req.user.userId],
    (err, courses) => {
      if (err) {
        removeUploadedFiles(req);
        return res.status(500).json({ message: 'Database error.' });
      }
      if (!courses.length) {
        removeUploadedFiles(req);
        return res.status(403).json({ message: 'You do not own this course.' });
      }
      req.courseId = courseId;
      next();
    }
  );
}

function canViewCourse(req, res, next) {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  const baseSql = 'SELECT c.id, c.status, c.tutor_id FROM courses c WHERE c.id = ? LIMIT 1';
  db.query(baseSql, [courseId], (err, courses) => {
    if (err) return res.status(500).json({ message: 'Database error.' });
    if (!courses.length) return res.status(404).json({ message: 'Course not found.' });

    const course = courses[0];
    const allowed =
      req.user.role === 'admin' ||
      (req.user.role === 'tutor' && Number(course.tutor_id) === Number(req.user.userId)) ||
      (req.user.role === 'student' && course.status === 'published' && Number(req.user.userId) > 0 && !!req.user.userId);

    if (!allowed) return res.status(403).json({ message: 'Course access denied.' });
    req.courseId = courseId;
    next();
  });
}

function markCourseEdited(courseId, callback) {
  db.query(
    `UPDATE courses
     SET status = CASE WHEN status IN ('submitted', 'under_review', 'approved', 'published', 'unpublished', 'rejected', 'changes_requested') THEN 'draft' ELSE status END
     WHERE id = ?`,
    [courseId],
    callback
  );
}

router.use(auth);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (['video', 'mainVideo'].includes(file.fieldname)) return cb(null, contentDir);
    if (['resourcePdfs', 'resourceImages'].includes(file.fieldname)) return cb(null, resourceDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uploadType = detectUploadType(file.fieldname);
    const prefix = uploadType === 'video' ? 'chapter-video' : uploadType === 'image' ? 'chapter-image' : 'chapter-file';
    cb(null, buildSafeFileName(file.originalname, prefix, uploadType));
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const uploadType = detectUploadType(file.fieldname);
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk =
      (uploadType === 'pdf' && file.mimetype === 'application/pdf') ||
      (uploadType === 'video' && file.mimetype.startsWith('video/')) ||
      (uploadType === 'image' && file.mimetype.startsWith('image/'));
    if (uploadType && mimeOk && allowedUploadExtensions[uploadType].has(ext)) {
      return cb(null, true);
    }
    cb(new Error('Only allowed video, PDF, and image files are permitted.'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});
const chapterUpload = upload.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'mainPdf', maxCount: 1 },
  { name: 'mainVideo', maxCount: 1 },
  { name: 'resourcePdfs', maxCount: 10 },
  { name: 'resourceImages', maxCount: 10 }
]);

function uploadedFile(req, fieldName) {
  return req.files?.[fieldName]?.[0] || null;
}

function removeUploadedFiles(req) {
  Object.values(req.files || {}).flat().forEach(file => fs.unlink(file.path, () => {}));
}

function removeUploadedFile(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

function parseResourceLinks(value) {
  if (!value) return [];
  try {
    const links = JSON.parse(value);
    if (!Array.isArray(links)) return [];
    return links.map((link) => ({
      title: String(link.title || '').trim() || 'External resource',
      url: String(link.url || '').trim()
    })).filter(link => /^https?:\/\//i.test(link.url));
  } catch {
    return [];
  }
}

function sanitizeRichText(value) {
  const allowedTags = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'p', 'div', 'br', 'ol', 'ul', 'li', 'blockquote']);
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, tag => {
      const match = tag.match(/^<\s*(\/?)\s*([a-z0-9]+)[^>]*>$/i);
      if (!match || !allowedTags.has(match[2].toLowerCase())) return '';
      const name = match[2].toLowerCase();
      if (name === 'br') return '<br>';
      return match[1] ? `</${name}>` : `<${name}>`;
    })
    .trim();
}

function resourceRowsFromRequest(req) {
  const pdfs = (req.files?.resourcePdfs || []).map(file => ({
    type: 'pdf',
    title: file.originalname,
    filePath: file.filename,
    externalUrl: null
  }));
  const images = (req.files?.resourceImages || []).map(file => ({
    type: 'image',
    title: file.originalname,
    filePath: file.filename,
    externalUrl: null
  }));
  const links = parseResourceLinks(req.body.resourceLinks).map(link => ({
    type: 'link',
    title: link.title,
    filePath: null,
    externalUrl: link.url
  }));
  return [...pdfs, ...images, ...links];
}

function insertResources(chapterId, resources, callback) {
  if (!resources.length) return callback(null);
  const values = resources.map(resource => [
    chapterId,
    resource.type,
    resource.title,
    resource.filePath,
    resource.externalUrl
  ]);
  db.query(
    `INSERT INTO chapter_resources
      (chapter_id, resource_type, title, file_path, external_url)
     VALUES ?`,
    [values],
    callback
  );
}

function deleteStaleResourceReferences(chapterId, stalePaths, callback) {
  const uniquePaths = [...new Set(stalePaths.filter(Boolean))];
  if (!uniquePaths.length) return callback(null);
  db.query(
    'DELETE FROM chapter_resources WHERE chapter_id = ? AND file_path IN (?)',
    [chapterId, uniquePaths],
    callback
  );
}

function loadChapterWithResources(courseId, chapterId, callback) {
  db.query(
    `SELECT ch.id, ch.course_id, ch.section_id, ch.title, ch.main_content_type, ch.summary,
            CASE WHEN ch.main_content_type = 'video' THEN ch.video_url ELSE NULL END AS video_url,
            CASE WHEN ch.main_content_type = 'pdf' THEN ch.pdf_path ELSE NULL END AS pdf_path,
            ch.chapter_order, ch.created_at, s.title AS section_title
     FROM chapters ch
     INNER JOIN sections s ON s.id = ch.section_id AND s.course_id = ch.course_id
     WHERE ch.id = ? AND ch.course_id = ?
     LIMIT 1`,
    [chapterId, courseId],
    (chapterErr, chapters) => {
      if (chapterErr) return callback(chapterErr);
      if (!chapters.length) return callback(null, null);
      const chapter = { ...chapters[0], resources: [] };
      db.query(
        `SELECT id, chapter_id, resource_type, title, file_path, external_url
         FROM chapter_resources
         WHERE chapter_id = ?
         ORDER BY id`,
        [chapterId],
        (resourceErr, resources) => {
          if (resourceErr) return callback(resourceErr);
          chapter.resources = resources;
          callback(null, chapter);
        }
      );
    }
  );
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = value.map(Number);
  return ids.every(id => Number.isInteger(id) && id > 0) && new Set(ids).size === ids.length ? ids : [];
}

function updateOrder(table, orderColumn, ids, ownerSql, ownerParams, callback) {
  const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
  const caseParams = ids.flatMap((id, index) => [id, index + 1]);
  const placeholders = ids.map(() => '?').join(',');
  db.query(
    `UPDATE ${table}
     SET ${orderColumn} = CASE id ${cases} END
     WHERE id IN (${placeholders}) AND ${ownerSql}`,
    [...caseParams, ...ids, ...ownerParams],
    callback
  );
}

router.get('/:courseId', canViewCourse, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await initializeCourseStructure();
  } catch {
    return res.status(500).json({ message: 'Could not initialize course sections.' });
  }

  db.query(
    `SELECT s.id AS section_id, s.title AS section_title, s.section_order,
            ch.id, ch.course_id, ch.title, ch.main_content_type, ch.summary,
            CASE WHEN ch.main_content_type = 'video' THEN ch.video_url ELSE NULL END AS video_url,
            CASE WHEN ch.main_content_type = 'pdf' THEN ch.pdf_path ELSE NULL END AS pdf_path,
            ch.chapter_order, ch.created_at
     FROM sections s
     LEFT JOIN chapters ch ON ch.section_id = s.id
     WHERE s.course_id = ?
     ORDER BY s.section_order, s.id, ch.chapter_order, ch.id`,
    [req.courseId],
    (err, rows) => {
      if (err) return res.status(500).json({ message: 'Database error.' });

      const sections = [];
      const byId = new Map();
      rows.forEach((row) => {
        if (!byId.has(row.section_id)) {
          const section = {
            id: row.section_id,
            course_id: req.courseId,
            title: row.section_title,
            section_order: row.section_order,
            chapters: []
          };
          byId.set(row.section_id, section);
          sections.push(section);
        }
        if (row.id) {
          byId.get(row.section_id).chapters.push({
            id: row.id,
            course_id: row.course_id,
            section_id: row.section_id,
            title: row.title,
            main_content_type: row.main_content_type,
            summary: row.summary,
            video_url: row.video_url,
            pdf_path: row.pdf_path,
            resources: [],
            chapter_order: row.chapter_order,
            created_at: row.created_at
          });
        }
      });
      const chapterIds = rows.filter(row => row.id).map(row => row.id);
      if (!chapterIds.length) return res.json({ sections });
      db.query(
        `SELECT id, chapter_id, resource_type, title, file_path, external_url
         FROM chapter_resources
         WHERE chapter_id IN (?)
         ORDER BY id`,
        [chapterIds],
        (resourceErr, resources) => {
          if (resourceErr) return res.status(500).json({ message: 'Could not load chapter resources.' });
          const chaptersById = new Map();
          sections.forEach(section => section.chapters.forEach(chapter => chaptersById.set(chapter.id, chapter)));
          resources.forEach(resource => chaptersById.get(resource.chapter_id)?.resources.push(resource));
          res.json({ sections });
        }
      );
    }
  );
});

router.post('/sections', requireTutor, ownsCourse, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Section title is required.' });

  try {
    await initializeCourseStructure();
  } catch {
    return res.status(500).json({ message: 'Could not initialize course sections.' });
  }

  db.query(
    'SELECT id FROM sections WHERE course_id = ? AND LOWER(TRIM(title)) = LOWER(?) LIMIT 1',
    [req.courseId, title],
    (findErr, existing) => {
      if (findErr) return res.status(500).json({ message: 'Could not check section name.' });
      if (existing.length) {
        return res.status(409).json({
          message: 'A section with this title already exists.',
          sectionId: existing[0].id
        });
      }

      db.query(
        `INSERT INTO sections (course_id, title, section_order)
         SELECT ?, ?, COALESCE(MAX(section_order), 0) + 1
         FROM sections WHERE course_id = ?`,
        [req.courseId, title, req.courseId],
        (err, result) => {
          if (err) return res.status(500).json({ message: 'Could not add section.' });
          markCourseEdited(req.courseId, (statusErr) => {
            if (statusErr) return res.status(500).json({ message: 'Section added, but review status could not be updated.' });
            logCourseTransaction({
              courseId: req.courseId,
              userId: req.user.userId,
              userRole: req.user.role,
              action: 'SECTION_ADDED',
              newStatus: 'draft',
              remarks: `Section added: ${title}`
            });
            res.status(201).json({ message: 'Section added!', sectionId: result.insertId });
          });
        }
      );
    }
  );
});

router.post('/sections/reorder', requireTutor, ownsCourse, (req, res) => {
  const sectionIds = normalizeIds(req.body.sectionIds);
  if (!sectionIds.length) return res.status(400).json({ message: 'Valid section order is required.' });
  db.query(
    'SELECT id FROM sections WHERE course_id = ? ORDER BY id',
    [req.courseId],
    (findErr, rows) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      const ownedIds = rows.map(row => Number(row.id)).sort((a, b) => a - b);
      const submittedIds = [...sectionIds].sort((a, b) => a - b);
      if (ownedIds.length !== submittedIds.length || ownedIds.some((id, index) => id !== submittedIds[index])) {
        return res.status(400).json({ message: 'Section order does not match this course.' });
      }
      updateOrder('sections', 'section_order', sectionIds, 'course_id = ?', [req.courseId], (updateErr) => {
        if (updateErr) return res.status(500).json({ message: 'Could not reorder sections.' });
        markCourseEdited(req.courseId, (statusErr) => {
          if (statusErr) return res.status(500).json({ message: 'Sections reordered, but review status could not be updated.' });
          res.json({ message: 'Sections reordered.' });
        });
      });
    }
  );
});

router.put('/sections/:sectionId', requireTutor, (req, res) => {
  const sectionId = Number(req.params.sectionId);
  const title = String(req.body.title || '').trim();
  if (!Number.isInteger(sectionId) || !title) {
    return res.status(400).json({ message: 'Valid section and title are required.' });
  }

  ownsCourse(req, res, () => {
    db.query(
      'UPDATE sections SET title = ? WHERE id = ? AND course_id = ?',
      [title, sectionId, req.courseId],
      (err, result) => {
        if (err) return res.status(500).json({ message: 'Could not update section.' });
        if (!result.affectedRows) return res.status(404).json({ message: 'Section not found.' });
        markCourseEdited(req.courseId, (statusErr) => {
          if (statusErr) return res.status(500).json({ message: 'Section updated, but review status could not be updated.' });
          logCourseTransaction({
            courseId: req.courseId,
            userId: req.user.userId,
            userRole: req.user.role,
            action: 'COURSE_UPDATED',
            newStatus: 'draft',
            remarks: `Section updated: ${title}`
          });
          res.json({ message: 'Section updated.' });
        });
      }
    );
  });
});

router.post('/sections/:sectionId/move', requireTutor, (req, res) => {
  const sectionId = Number(req.params.sectionId);
  const direction = String(req.body.direction || '');
  if (!Number.isInteger(sectionId) || !['up', 'down'].includes(direction)) {
    return res.status(400).json({ message: 'Valid section and direction are required.' });
  }

  ownsCourse(req, res, () => {
    db.query(
      'SELECT id, section_order FROM sections WHERE id = ? AND course_id = ? LIMIT 1',
      [sectionId, req.courseId],
      (findErr, sections) => {
        if (findErr) return res.status(500).json({ message: 'Database error.' });
        if (!sections.length) return res.status(404).json({ message: 'Section not found.' });
        const comparator = direction === 'up' ? '<' : '>';
        const ordering = direction === 'up' ? 'DESC' : 'ASC';
        db.query(
          `SELECT id, section_order FROM sections
           WHERE course_id = ? AND section_order ${comparator} ?
           ORDER BY section_order ${ordering}, id ${ordering}
           LIMIT 1`,
          [req.courseId, sections[0].section_order],
          (neighborErr, neighbors) => {
            if (neighborErr) return res.status(500).json({ message: 'Database error.' });
            if (!neighbors.length) return res.json({ message: 'Section is already at the edge.' });
            db.query(
              `UPDATE sections
               SET section_order = CASE
                 WHEN id = ? THEN ?
                 WHEN id = ? THEN ?
               END
               WHERE id IN (?, ?) AND course_id = ?`,
              [
                sectionId, neighbors[0].section_order,
                neighbors[0].id, sections[0].section_order,
                sectionId, neighbors[0].id, req.courseId
              ],
              (updateErr) => {
                if (updateErr) return res.status(500).json({ message: 'Could not reorder section.' });
                markCourseEdited(req.courseId, (statusErr) => {
                  if (statusErr) return res.status(500).json({ message: 'Section moved, but review status could not be updated.' });
                  res.json({ message: 'Section moved.' });
                });
              }
            );
          }
        );
      }
    );
  });
});

router.delete('/sections/:sectionId', requireTutor, (req, res) => {
  const sectionId = Number(req.params.sectionId);
  if (!Number.isInteger(sectionId)) return res.status(400).json({ message: 'Invalid section.' });

  ownsCourse(req, res, () => {
    db.query(
      `SELECT ch.pdf_path, ch.video_url, GROUP_CONCAT(cr.file_path) AS resource_files
       FROM chapters ch
       LEFT JOIN chapter_resources cr ON cr.chapter_id = ch.id
       WHERE ch.section_id = ? AND ch.course_id = ?
       GROUP BY ch.id, ch.pdf_path, ch.video_url`,
      [sectionId, req.courseId],
      (findErr, chapters) => {
        if (findErr) return res.status(500).json({ message: 'Database error.' });
        db.query(
          'DELETE FROM sections WHERE id = ? AND course_id = ?',
          [sectionId, req.courseId],
          (deleteErr, result) => {
            if (deleteErr) return res.status(500).json({ message: 'Could not delete section.' });
            if (!result.affectedRows) return res.status(404).json({ message: 'Section not found.' });
            chapters.forEach(chapter => {
              if (chapter.pdf_path) safeDeleteFile(chapter.pdf_path, uploadDir);
              if (chapter.video_url) safeDeleteFile(chapter.video_url, contentDir);
              String(chapter.resource_files || '').split(',').filter(Boolean).forEach(filePath => {
                safeDeleteFile(filePath, resourceDir);
              });
            });
            markCourseEdited(req.courseId, (statusErr) => {
              if (statusErr) return res.status(500).json({ message: 'Section deleted, but review status could not be updated.' });
              logCourseTransaction({
                courseId: req.courseId,
                userId: req.user.userId,
                userRole: req.user.role,
                action: 'SECTION_REMOVED',
                newStatus: 'draft',
                remarks: `Section removed: ${sectionId}`
              });
              res.json({ message: 'Section deleted.' });
            });
          }
        );
      }
    );
  });
});

router.post('/add', requireTutor, (req, res) => {
  chapterUpload(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ message: uploadErr.message || 'Could not upload chapter files.' });

    ownsCourse(req, res, async () => {
      const title = String(req.body.title || '').trim();
      const summary = sanitizeRichText(req.body.summary);
      const sectionId = Number(req.body.sectionId);
      const mainContentType = String(req.body.mainContentType || '').trim();
      const videoFile = uploadedFile(req, 'mainVideo') || uploadedFile(req, 'video');
      const pdfFile = uploadedFile(req, 'mainPdf') || uploadedFile(req, 'pdf');
      if (!title || !Number.isInteger(sectionId) || !['video', 'pdf'].includes(mainContentType)) {
        removeUploadedFiles(req);
        return res.status(400).json({ message: 'Section, chapter title, and main content type are required.' });
      }
      if (mainContentType === 'video' && !videoFile) {
        removeUploadedFiles(req);
        return res.status(400).json({ message: 'Upload the main video for this chapter.' });
      }
      if (mainContentType === 'pdf' && !pdfFile) {
        removeUploadedFiles(req);
        return res.status(400).json({ message: 'Upload the main PDF for this chapter.' });
      }

      try {
        await initializeCourseStructure();
      } catch {
        removeUploadedFiles(req);
        return res.status(500).json({ message: 'Could not initialize course sections.' });
      }

      db.query(
        'SELECT id FROM sections WHERE id = ? AND course_id = ? LIMIT 1',
        [sectionId, req.courseId],
        (sectionErr, sections) => {
          if (sectionErr) {
            removeUploadedFiles(req);
            return res.status(500).json({ message: 'Database error.' });
          }
          if (!sections.length) {
            removeUploadedFiles(req);
            return res.status(400).json({ message: 'Invalid section.' });
          }

          const pdfPath = mainContentType === 'pdf' ? pdfFile.filename : null;
          const videoPath = mainContentType === 'video' ? videoFile.filename : null;
          db.query(
            `INSERT INTO chapters
              (course_id, section_id, title, main_content_type, summary, video_url, pdf_path, chapter_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              req.courseId,
              sectionId,
              title,
              mainContentType,
              summary,
              videoPath,
              pdfPath,
              Number(req.body.chapterOrder) || 1
            ],
            (err, result) => {
              if (err) {
                removeUploadedFiles(req);
                return res.status(500).json({ message: 'Could not add chapter.' });
              }
              insertResources(result.insertId, resourceRowsFromRequest(req), (resourceErr) => {
                if (resourceErr) {
                  db.query('DELETE FROM chapters WHERE id = ?', [result.insertId], () => {});
                  removeUploadedFiles(req);
                  return res.status(500).json({ message: 'Could not save chapter resources.' });
                }
                markCourseEdited(req.courseId, (statusErr) => {
                  if (statusErr) return res.status(500).json({ message: 'Chapter added, but review status could not be updated.' });
                  logCourseTransaction({
                    courseId: req.courseId,
                    userId: req.user.userId,
                    userRole: req.user.role,
                    action: 'CHAPTER_ADDED',
                    newStatus: 'draft',
                    remarks: `Chapter added: ${title}`
                  });
                  loadChapterWithResources(req.courseId, result.insertId, (loadErr, chapter) => {
                    if (loadErr) return res.status(500).json({ message: 'Chapter added, but the latest chapter could not be loaded.' });
                    res.status(201).json({
                      message: 'Chapter added!',
                      chapterId: result.insertId,
                      chapter
                    });
                  });
                });
              });
            }
          );
        }
      );
    });
  });
});

router.post('/reorder', requireTutor, ownsCourse, (req, res) => {
  const sectionId = Number(req.body.sectionId);
  const chapterIds = normalizeIds(req.body.chapterIds);
  if (!Number.isInteger(sectionId) || !chapterIds.length) {
    return res.status(400).json({ message: 'Valid section and chapter order are required.' });
  }
  db.query(
    `SELECT ch.id
     FROM chapters ch
     INNER JOIN sections s ON s.id = ch.section_id
     WHERE ch.course_id = ? AND ch.section_id = ? AND s.course_id = ?
     ORDER BY ch.id`,
    [req.courseId, sectionId, req.courseId],
    (findErr, rows) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      const ownedIds = rows.map(row => Number(row.id)).sort((a, b) => a - b);
      const submittedIds = [...chapterIds].sort((a, b) => a - b);
      if (ownedIds.length !== submittedIds.length || ownedIds.some((id, index) => id !== submittedIds[index])) {
        return res.status(400).json({ message: 'Chapter order does not match this section.' });
      }
      updateOrder(
        'chapters',
        'chapter_order',
        chapterIds,
        'course_id = ? AND section_id = ?',
        [req.courseId, sectionId],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ message: 'Could not reorder chapters.' });
          markCourseEdited(req.courseId, (statusErr) => {
            if (statusErr) return res.status(500).json({ message: 'Chapters reordered, but review status could not be updated.' });
            res.json({ message: 'Chapters reordered.' });
          });
        }
      );
    }
  );
});

router.post('/reorder-all', requireTutor, ownsCourse, (req, res) => {
  const layout = Array.isArray(req.body.sections) ? req.body.sections : [];
  const sectionIds = normalizeIds(layout.map(section => section.sectionId));
  const chapterIds = normalizeIds(layout.flatMap(section => section.chapterIds || []));
  if (!layout.length || sectionIds.length !== layout.length) {
    return res.status(400).json({ message: 'Valid course layout is required.' });
  }

  db.query(
    `SELECT s.id AS section_id, ch.id AS chapter_id
     FROM sections s
     LEFT JOIN chapters ch ON ch.section_id = s.id
     WHERE s.course_id = ?`,
    [req.courseId],
    (findErr, rows) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      const ownedSections = [...new Set(rows.map(row => Number(row.section_id)))].sort((a, b) => a - b);
      const submittedSections = [...sectionIds].sort((a, b) => a - b);
      const ownedChapters = rows.filter(row => row.chapter_id).map(row => Number(row.chapter_id)).sort((a, b) => a - b);
      const submittedChapters = [...chapterIds].sort((a, b) => a - b);
      const sectionsMatch = ownedSections.length === submittedSections.length &&
        ownedSections.every((id, index) => id === submittedSections[index]);
      const chaptersMatch = ownedChapters.length === submittedChapters.length &&
        ownedChapters.every((id, index) => id === submittedChapters[index]);
      if (!sectionsMatch || !chaptersMatch) {
        return res.status(400).json({ message: 'Course layout does not match this course.' });
      }

      db.beginTransaction((transactionErr) => {
        if (transactionErr) return res.status(500).json({ message: 'Could not start reorder.' });
        const updates = layout.flatMap(section =>
          section.chapterIds.map((chapterId, index) => [Number(chapterId), Number(section.sectionId), index + 1])
        );
        let pending = updates.length;
        let failed = false;
        const finish = () => {
          if (failed || pending > 0) return;
          markCourseEdited(req.courseId, (statusErr) => {
            if (statusErr) {
              return db.rollback(() => res.status(500).json({ message: 'Layout changed, but review status could not be updated.' }));
            }
            db.commit((commitErr) => {
              if (commitErr) return db.rollback(() => res.status(500).json({ message: 'Could not save course layout.' }));
              res.json({ message: 'Chapter layout updated.' });
            });
          });
        };
        if (!pending) return finish();
        updates.forEach(([chapterId, sectionId, chapterOrder]) => {
          db.query(
            'UPDATE chapters SET section_id = ?, chapter_order = ? WHERE id = ? AND course_id = ?',
            [sectionId, chapterOrder, chapterId, req.courseId],
            (updateErr) => {
              if (failed) return;
              if (updateErr) {
                failed = true;
                return db.rollback(() => res.status(500).json({ message: 'Could not move chapter.' }));
              }
              pending -= 1;
              finish();
            }
          );
        });
      });
    }
  );
});

router.post('/:chapterId/move', requireTutor, (req, res) => {
  const chapterId = Number(req.params.chapterId);
  const direction = String(req.body.direction || '');
  if (!Number.isInteger(chapterId) || !['up', 'down'].includes(direction)) {
    return res.status(400).json({ message: 'Valid chapter and direction are required.' });
  }

  ownsCourse(req, res, () => {
    db.query(
      'SELECT id, section_id, chapter_order FROM chapters WHERE id = ? AND course_id = ? LIMIT 1',
      [chapterId, req.courseId],
      (findErr, chapters) => {
        if (findErr) return res.status(500).json({ message: 'Database error.' });
        if (!chapters.length) return res.status(404).json({ message: 'Chapter not found.' });
        const comparator = direction === 'up' ? '<' : '>';
        const ordering = direction === 'up' ? 'DESC' : 'ASC';
        db.query(
          `SELECT id, chapter_order FROM chapters
           WHERE section_id = ? AND chapter_order ${comparator} ?
           ORDER BY chapter_order ${ordering}, id ${ordering}
           LIMIT 1`,
          [chapters[0].section_id, chapters[0].chapter_order],
          (neighborErr, neighbors) => {
            if (neighborErr) return res.status(500).json({ message: 'Database error.' });
            if (!neighbors.length) return res.json({ message: 'Chapter is already at the edge.' });
            db.query(
              `UPDATE chapters
               SET chapter_order = CASE
                 WHEN id = ? THEN ?
                 WHEN id = ? THEN ?
               END
               WHERE id IN (?, ?) AND course_id = ?`,
              [
                chapterId, neighbors[0].chapter_order,
                neighbors[0].id, chapters[0].chapter_order,
                chapterId, neighbors[0].id, req.courseId
              ],
              (updateErr) => {
                if (updateErr) return res.status(500).json({ message: 'Could not reorder chapter.' });
                markCourseEdited(req.courseId, (statusErr) => {
                  if (statusErr) return res.status(500).json({ message: 'Chapter moved, but review status could not be updated.' });
                  res.json({ message: 'Chapter moved.' });
                });
              }
            );
          }
        );
      }
    );
  });
});

router.put('/:chapterId', requireTutor, (req, res) => {
  chapterUpload(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ message: uploadErr.message || 'Could not upload chapter files.' });

    const chapterId = Number(req.params.chapterId);
    ownsCourse(req, res, () => {
      const sectionId = Number(req.body.sectionId);
      const title = String(req.body.title || '').trim();
      const summary = sanitizeRichText(req.body.summary);
      const mainContentType = String(req.body.mainContentType || '').trim();
      if (!Number.isInteger(chapterId) || !Number.isInteger(sectionId) || !title || !['video', 'pdf'].includes(mainContentType)) {
        removeUploadedFiles(req);
        return res.status(400).json({ message: 'Section, chapter title, and main content type are required.' });
      }

      db.query(
        `SELECT ch.main_content_type, ch.pdf_path, ch.video_url
         FROM chapters ch
         INNER JOIN sections s ON s.id = ? AND s.course_id = ch.course_id
         WHERE ch.id = ? AND ch.course_id = ?
         LIMIT 1`,
        [sectionId, chapterId, req.courseId],
        (findErr, chapters) => {
          if (findErr) {
            removeUploadedFiles(req);
            return res.status(500).json({ message: 'Database error.' });
          }
          if (!chapters.length) {
            removeUploadedFiles(req);
            return res.status(404).json({ message: 'Chapter or section not found.' });
          }

          const oldPdfPath = chapters[0].pdf_path;
          const oldVideoPath = chapters[0].video_url;
          const oldContentType = chapters[0].main_content_type;
          const pdfFile = uploadedFile(req, 'mainPdf') || uploadedFile(req, 'pdf');
          const videoFile = uploadedFile(req, 'mainVideo') || uploadedFile(req, 'video');
          if (mainContentType === 'video' && pdfFile) removeUploadedFile(pdfFile);
          if (mainContentType === 'pdf' && videoFile) removeUploadedFile(videoFile);

          const pdfPath = mainContentType === 'pdf' ? (pdfFile ? pdfFile.filename : oldPdfPath) : null;
          const videoPath = mainContentType === 'video' ? (videoFile ? videoFile.filename : oldVideoPath) : null;
          if (mainContentType === 'video' && oldContentType !== 'video' && !videoFile) {
            removeUploadedFiles(req);
            return res.status(400).json({ message: 'Upload a video when changing the main content type to Video.' });
          }
          if (mainContentType === 'pdf' && oldContentType !== 'pdf' && !pdfFile) {
            removeUploadedFiles(req);
            return res.status(400).json({ message: 'Upload a PDF when changing the main content type to PDF.' });
          }
          if (mainContentType === 'video' && !videoPath) {
            removeUploadedFiles(req);
            return res.status(400).json({ message: 'Upload the main video for this chapter.' });
          }
          if (mainContentType === 'pdf' && !pdfPath) {
            removeUploadedFiles(req);
            return res.status(400).json({ message: 'Upload the main PDF for this chapter.' });
          }

          const staleContentPaths = [
            oldPdfPath && oldPdfPath !== pdfPath ? oldPdfPath : null,
            oldVideoPath && oldVideoPath !== videoPath ? oldVideoPath : null
          ].filter(Boolean);
          db.query(
            `UPDATE chapters
             SET section_id = ?, title = ?, main_content_type = ?, summary = ?, video_url = ?, pdf_path = ?
             WHERE id = ? AND course_id = ?`,
            [sectionId, title, mainContentType, summary, videoPath, pdfPath, chapterId, req.courseId],
            (updateErr) => {
              if (updateErr) {
                removeUploadedFiles(req);
                return res.status(500).json({ message: 'Could not update chapter.' });
              }

              deleteStaleResourceReferences(chapterId, staleContentPaths, (staleErr) => {
                if (staleErr) return res.status(500).json({ message: 'Chapter updated, but stale content references could not be cleared.' });

                insertResources(chapterId, resourceRowsFromRequest(req), (resourceErr) => {
                  if (resourceErr) return res.status(500).json({ message: 'Chapter updated, but resources could not be saved.' });
                  markCourseEdited(req.courseId, (statusErr) => {
                    if (statusErr) return res.status(500).json({ message: 'Chapter updated, but review status could not be updated.' });
                    loadChapterWithResources(req.courseId, chapterId, (loadErr, updatedChapter) => {
                      if (loadErr) return res.status(500).json({ message: 'Chapter updated, but the latest chapter could not be loaded.' });
                      if (!updatedChapter) return res.status(404).json({ message: 'Chapter updated, but was not found on reload.' });

                      if (oldPdfPath && oldPdfPath !== updatedChapter.pdf_path) {
                        safeDeleteFile(oldPdfPath, uploadDir);
                      }
                      if (oldVideoPath && oldVideoPath !== updatedChapter.video_url) {
                        safeDeleteFile(oldVideoPath, contentDir);
                      }
                      logCourseTransaction({
                        courseId: req.courseId,
                        userId: req.user.userId,
                        userRole: req.user.role,
                        action: 'COURSE_UPDATED',
                        newStatus: 'draft',
                        remarks: `Chapter updated: ${title}`
                      });
                      res.json({
                        message: 'Chapter updated.',
                        chapter: updatedChapter,
                        main_content_type: updatedChapter.main_content_type,
                        pdf_path: updatedChapter.pdf_path,
                        video_url: updatedChapter.video_url
                      });
                    });
                  });
                });
              });
            }
          );
        }
      );
    });
  });
});

router.get('/:courseId/:chapterId/pdf', canViewCourse, (req, res) => {
  const chapterId = Number(req.params.chapterId);
  db.query(
    "SELECT pdf_path FROM chapters WHERE id = ? AND course_id = ? AND main_content_type = 'pdf' AND pdf_path IS NOT NULL LIMIT 1",
    [chapterId, req.courseId],
    (err, chapters) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!chapters.length) return res.status(404).json({ message: 'PDF not found.' });

      const pdfFile = resolveStoredFilePath(chapters[0].pdf_path, uploadDir);
      if (!pdfFile || !fs.existsSync(pdfFile)) return res.status(404).json({ message: 'PDF file not found.' });
      res.set('Cache-Control', 'no-store');
      res.sendFile(pdfFile);
    }
  );
});

router.get('/:courseId/:chapterId/video', canViewCourse, (req, res) => {
  const chapterId = Number(req.params.chapterId);
  db.query(
    "SELECT video_url FROM chapters WHERE id = ? AND course_id = ? AND main_content_type = 'video' AND video_url IS NOT NULL LIMIT 1",
    [chapterId, req.courseId],
    (err, chapters) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!chapters.length) return res.status(404).json({ message: 'Video not found.' });

      const videoFile = resolveStoredFilePath(chapters[0].video_url, contentDir);
      if (!videoFile || !fs.existsSync(videoFile)) return res.status(404).json({ message: 'Video file not found.' });
      res.set('Cache-Control', 'no-store');
      res.sendFile(videoFile);
    }
  );
});

router.get('/:courseId/resources/:resourceId', canViewCourse, (req, res) => {
  const resourceId = Number(req.params.resourceId);
  db.query(
    `SELECT cr.file_path
     FROM chapter_resources cr
     INNER JOIN chapters ch ON ch.id = cr.chapter_id
     WHERE cr.id = ? AND ch.course_id = ? AND cr.file_path IS NOT NULL
     LIMIT 1`,
    [resourceId, req.courseId],
    (err, resources) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!resources.length) return res.status(404).json({ message: 'Resource not found.' });
      const resourceFile = resolveStoredFilePath(resources[0].file_path, resourceDir);
      if (!resourceFile || !fs.existsSync(resourceFile)) return res.status(404).json({ message: 'Resource file not found.' });
      if (req.user.role === 'student') {
        logStudentTransaction({
          studentId: req.user.userId,
          courseId: req.courseId,
          action: 'RESOURCE_DOWNLOADED',
          remarks: `Resource ${resourceId} downloaded.`
        });
      }
      res.sendFile(resourceFile);
    }
  );
});

router.put('/:courseId/resources/:resourceId', requireTutor, ownsCourse, (req, res) => {
  const resourceId = Number(req.params.resourceId);
  const title = String(req.body.title || '').trim();
  const externalUrl = String(req.body.externalUrl || '').trim();
  if (!Number.isInteger(resourceId) || !title) {
    return res.status(400).json({ message: 'Valid resource and title are required.' });
  }
  db.query(
    `SELECT cr.resource_type
     FROM chapter_resources cr
     INNER JOIN chapters ch ON ch.id = cr.chapter_id
     WHERE cr.id = ? AND ch.course_id = ?
     LIMIT 1`,
    [resourceId, req.courseId],
    (findErr, resources) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      if (!resources.length) return res.status(404).json({ message: 'Resource not found.' });
      if (resources[0].resource_type === 'link' && !/^https?:\/\//i.test(externalUrl)) {
        return res.status(400).json({ message: 'A valid HTTP or HTTPS link is required.' });
      }
      db.query(
        `UPDATE chapter_resources
         SET title = ?, external_url = CASE WHEN resource_type = 'link' THEN ? ELSE external_url END
         WHERE id = ?`,
        [title, externalUrl || null, resourceId],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ message: 'Could not update resource.' });
          markCourseEdited(req.courseId, (statusErr) => {
            if (statusErr) return res.status(500).json({ message: 'Resource updated, but review status could not be updated.' });
            logCourseTransaction({
              courseId: req.courseId,
              userId: req.user.userId,
              userRole: req.user.role,
              action: 'COURSE_UPDATED',
              newStatus: 'draft',
              remarks: `Resource updated: ${resourceId}`
            });
            res.json({ message: 'Resource updated.' });
          });
        }
      );
    }
  );
});

router.delete('/:courseId/resources/:resourceId', requireTutor, ownsCourse, (req, res) => {
  const resourceId = Number(req.params.resourceId);
  db.query(
    `SELECT cr.file_path
     FROM chapter_resources cr
     INNER JOIN chapters ch ON ch.id = cr.chapter_id
     WHERE cr.id = ? AND ch.course_id = ?
     LIMIT 1`,
    [resourceId, req.courseId],
    (findErr, resources) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      if (!resources.length) return res.status(404).json({ message: 'Resource not found.' });
      db.query('DELETE FROM chapter_resources WHERE id = ?', [resourceId], (deleteErr) => {
        if (deleteErr) return res.status(500).json({ message: 'Could not delete resource.' });
        if (resources[0].file_path) {
          safeDeleteFile(resources[0].file_path, resourceDir);
        }
        markCourseEdited(req.courseId, (statusErr) => {
          if (statusErr) return res.status(500).json({ message: 'Resource deleted, but review status could not be updated.' });
          logCourseTransaction({
            courseId: req.courseId,
            userId: req.user.userId,
            userRole: req.user.role,
            action: 'COURSE_UPDATED',
            newStatus: 'draft',
            remarks: `Resource removed: ${resourceId}`
          });
          res.json({ message: 'Resource deleted.' });
        });
      });
    }
  );
});

router.delete('/:id', requireTutor, (req, res) => {
  db.query(
    `SELECT ch.course_id, ch.pdf_path, ch.video_url,
            GROUP_CONCAT(cr.file_path) AS resource_files
     FROM chapters ch
     INNER JOIN courses c ON c.id = ch.course_id
     LEFT JOIN chapter_resources cr ON cr.chapter_id = ch.id
     WHERE ch.id = ? AND c.tutor_id = ?
     GROUP BY ch.id, ch.course_id, ch.pdf_path, ch.video_url
     LIMIT 1`,
    [req.params.id, req.user.userId],
    (findErr, chapters) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      if (!chapters.length) return res.status(404).json({ message: 'Chapter not found.' });

      db.query('DELETE FROM chapters WHERE id = ?', [req.params.id], (err, result) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!result.affectedRows) return res.status(404).json({ message: 'Chapter not found.' });
        if (chapters[0].pdf_path) {
          safeDeleteFile(chapters[0].pdf_path, uploadDir);
        }
        if (chapters[0].video_url) {
          safeDeleteFile(chapters[0].video_url, contentDir);
        }
        String(chapters[0].resource_files || '').split(',').filter(Boolean).forEach((filePath) => {
          safeDeleteFile(filePath, resourceDir);
        });
        markCourseEdited(chapters[0].course_id, (statusErr) => {
          if (statusErr) return res.status(500).json({ message: 'Chapter deleted, but review status could not be updated.' });
          logCourseTransaction({
            courseId: chapters[0].course_id,
            userId: req.user.userId,
            userRole: req.user.role,
            action: 'CHAPTER_REMOVED',
            newStatus: 'draft',
            remarks: `Chapter removed: ${req.params.id}`
          });
          res.json({ message: 'Chapter deleted.' });
        });
      });
    }
  );
});

module.exports = router;
