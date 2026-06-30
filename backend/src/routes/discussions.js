const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const db = require('../config/db');
const { logDiscussionTransaction } = require('../services/audit-log');
require('dotenv').config();

const router = express.Router();
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

function requireStudent(req, res, next) {
  if (req.user.role !== 'student') {
    return res.status(403).json({ message: 'Student access required.' });
  }
  next();
}

function sendDiscussionMail({ to, subject, heading, rows, body }, callback) {
  const recipients = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
  if (!recipients.length) return callback(null, false);
  mailTransporter.sendMail({
    from: `"E-Learning" <${process.env.GMAIL_USER}>`,
    to: recipients.join(','),
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:12px;">
        <h2 style="color:#1a3a5c;">${escapeEmailHtml(heading)}</h2>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          ${rows.map(row => `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee;"><strong>${escapeEmailHtml(row.label)}</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${escapeEmailHtml(row.value)}</td>
            </tr>
          `).join('')}
        </table>
        <div style="margin-top:18px;padding:16px;background:#f7f4ef;border-radius:8px;white-space:pre-wrap;">${escapeEmailHtml(body)}</div>
      </div>
    `
  }, (mailErr) => callback(mailErr, !mailErr));
}

function requireEnrollment(req, res, next) {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) {
    return res.status(400).json({ message: 'Invalid course ID.' });
  }

  db.query(
    `SELECT c.id
     FROM courses c
     INNER JOIN enrollments e
       ON e.course_id = c.id AND e.user_id = ?
     WHERE c.id = ? AND c.status = 'published'
     LIMIT 1`,
    [req.user.userId, courseId],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (!results.length) {
        return res.status(403).json({ message: 'Enroll in this course to join the discussion.' });
      }

      req.courseId = courseId;
      next();
    }
  );
}

function requireCourseViewer(req, res, next) {
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

      if (!allowed) return res.status(403).json({ message: 'Course discussion access denied.' });
      req.courseId = courseId;
      next();
    }
  );
}

function initializeDiscussionTables() {
  db.query(
    `CREATE TABLE IF NOT EXISTS doubts (
       id INT AUTO_INCREMENT PRIMARY KEY,
       course_id INT NOT NULL,
       chapter_id INT NOT NULL,
       user_id INT NOT NULL,
       question TEXT NOT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_doubts_course_chapter (course_id, chapter_id),
       CONSTRAINT fk_doubts_course
         FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
       CONSTRAINT fk_doubts_chapter
         FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
       CONSTRAINT fk_doubts_user
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
     )`,
    (doubtErr) => {
      if (doubtErr) {
        console.error('Could not initialize doubts table:', doubtErr.message);
        return;
      }

      db.query(
        `CREATE TABLE IF NOT EXISTS doubt_replies (
           id INT AUTO_INCREMENT PRIMARY KEY,
           doubt_id INT NOT NULL,
           user_id INT NOT NULL,
           reply TEXT NOT NULL,
           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_replies_doubt (doubt_id),
           CONSTRAINT fk_replies_doubt
             FOREIGN KEY (doubt_id) REFERENCES doubts(id) ON DELETE CASCADE,
           CONSTRAINT fk_replies_user
             FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
         )`,
        (replyErr) => {
          if (replyErr) console.error('Could not initialize doubt replies table:', replyErr.message);
        }
      );
    }
  );
}

initializeDiscussionTables();

router.use(auth);

// POST /api/discussions/:courseId/feedback
router.post('/:courseId/feedback', requireStudent, requireEnrollment, (req, res) => {
  const feedback = String(req.body.feedback || '').trim();
  const chapterId = Number(req.body.chapterId);
  if (!feedback || feedback.length > 3000) {
    return res.status(400).json({ message: 'Feedback must be between 1 and 3000 characters.' });
  }

  db.query(
    `SELECT c.title AS course_title, u.name AS tutor_name, u.email AS tutor_email,
            student.name AS student_name, student.email AS student_email,
            ch.title AS chapter_title
     FROM courses c
     INNER JOIN users u ON u.id = c.tutor_id
     INNER JOIN users student ON student.id = ?
     LEFT JOIN chapters ch ON ch.id = ? AND ch.course_id = c.id
     WHERE c.id = ?
     LIMIT 1`,
    [req.user.userId, Number.isInteger(chapterId) ? chapterId : 0, req.courseId],
    (findErr, courses) => {
      if (findErr) return res.status(500).json({ message: 'Database error.' });
      if (!courses.length || !courses[0].tutor_email) {
        return res.status(404).json({ message: 'Tutor email is not available.' });
      }
      const course = courses[0];
      mailTransporter.sendMail({
        from: `"E-Learning" <${process.env.GMAIL_USER}>`,
        to: course.tutor_email,
        subject: `Course Feedback: ${course.course_title}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:12px;">
            <h2 style="color:#1a3a5c;">New Student Feedback</h2>
            <p><strong>Course:</strong> ${escapeEmailHtml(course.course_title)}</p>
            ${course.chapter_title ? `<p><strong>Chapter:</strong> ${escapeEmailHtml(course.chapter_title)}</p>` : ''}
            <p><strong>Student:</strong> ${escapeEmailHtml(course.student_name)} (${escapeEmailHtml(course.student_email)})</p>
            <div style="margin-top:18px;padding:16px;background:#f7f4ef;border-radius:8px;white-space:pre-wrap;">${escapeEmailHtml(feedback)}</div>
          </div>
        `
      }, (mailErr) => {
        if (mailErr) {
          console.error('Course feedback email error:', mailErr.message);
          return res.status(500).json({ message: 'Feedback could not be emailed to the tutor.' });
        }
        logDiscussionTransaction({
          studentId: req.user.userId,
          courseId: req.courseId,
          discussionId: Number.isInteger(chapterId) ? chapterId : 0,
          action: 'MAIL_TUTOR_CLICKED'
        });
        res.json({ message: 'Feedback sent to the tutor.' });
      });
    }
  );
});

// GET /api/discussions/:courseId/chapters/:chapterId
router.get('/:courseId/chapters/:chapterId', requireCourseViewer, (req, res) => {
  const chapterId = Number(req.params.chapterId);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    return res.status(400).json({ message: 'Invalid chapter ID.' });
  }

  db.query(
    'SELECT id FROM chapters WHERE id = ? AND course_id = ? LIMIT 1',
    [chapterId, req.courseId],
    (chapterErr, chapterResults) => {
      if (chapterErr) return res.status(500).json({ message: 'Database error.' });
      if (!chapterResults.length) return res.status(404).json({ message: 'Chapter not found.' });

      db.query(
        `SELECT d.id, d.course_id, d.chapter_id, d.user_id, d.question, d.created_at,
                u.name AS student_name
         FROM doubts d
         INNER JOIN users u ON u.id = d.user_id
         WHERE d.course_id = ? AND d.chapter_id = ?
         ORDER BY d.created_at DESC, d.id DESC`,
        [req.courseId, chapterId],
        (doubtErr, doubts) => {
          if (doubtErr) return res.status(500).json({ message: 'Database error.' });
          if (!doubts.length) return res.json([]);

          const doubtIds = doubts.map(doubt => doubt.id);
          db.query(
            `SELECT r.id, r.doubt_id, r.user_id, r.reply, r.created_at,
                    u.name AS student_name
             FROM doubt_replies r
             INNER JOIN users u ON u.id = r.user_id
             WHERE r.doubt_id IN (?)
             ORDER BY r.created_at ASC, r.id ASC`,
            [doubtIds],
            (replyErr, replies) => {
              if (replyErr) return res.status(500).json({ message: 'Database error.' });
              const repliesByDoubt = new Map();
              replies.forEach((reply) => {
                if (!repliesByDoubt.has(reply.doubt_id)) repliesByDoubt.set(reply.doubt_id, []);
                repliesByDoubt.get(reply.doubt_id).push(reply);
              });

              res.json(doubts.map(doubt => ({
                ...doubt,
                replies: repliesByDoubt.get(doubt.id) || []
              })));
            }
          );
        }
      );
    }
  );
});

// POST /api/discussions/:courseId/chapters/:chapterId
router.post('/:courseId/chapters/:chapterId', requireStudent, requireEnrollment, (req, res) => {
  const chapterId = Number(req.params.chapterId);
  const question = String(req.body.question || '').trim();

  if (!Number.isInteger(chapterId) || chapterId < 1) {
    return res.status(400).json({ message: 'Invalid chapter ID.' });
  }
  if (!question || question.length > 2000) {
    return res.status(400).json({ message: 'Question must be between 1 and 2000 characters.' });
  }

  db.query(
    `SELECT c.title AS course_title, tutor.name AS tutor_name, tutor.email AS tutor_email,
            ch.id, ch.title AS chapter_title,
            student.name AS student_name, student.email AS student_email
     FROM chapters ch
     INNER JOIN courses c ON c.id = ch.course_id
     INNER JOIN users tutor ON tutor.id = c.tutor_id
     INNER JOIN users student ON student.id = ?
     WHERE ch.id = ? AND ch.course_id = ?
     LIMIT 1`,
    [req.user.userId, chapterId, req.courseId],
    (chapterErr, chapters) => {
      if (chapterErr) return res.status(500).json({ message: 'Database error.' });
      if (!chapters.length) return res.status(404).json({ message: 'Chapter not found.' });
      const chapter = chapters[0];

      db.query(
        'INSERT INTO doubts (course_id, chapter_id, user_id, question) VALUES (?, ?, ?, ?)',
        [req.courseId, chapterId, req.user.userId, question],
        (err, result) => {
          if (err) return res.status(500).json({ message: 'Could not post question.' });
          logDiscussionTransaction({
            studentId: req.user.userId,
            courseId: req.courseId,
            discussionId: result.insertId,
            action: 'QUESTION_POSTED'
          });
          sendDiscussionMail({
            to: chapter.tutor_email,
            subject: `New doubt: ${chapter.course_title}`,
            heading: 'New Student Doubt',
            rows: [
              { label: 'Course', value: chapter.course_title },
              { label: 'Lecture', value: chapter.chapter_title },
              { label: 'Student', value: `${chapter.student_name} (${chapter.student_email || 'no email'})` }
            ],
            body: question
          }, (mailErr, emailSent) => {
            if (mailErr) console.error('Discussion doubt email error:', mailErr.message);
            res.status(201).json({
              message: emailSent ? 'Question posted and tutor emailed.' : 'Question posted. Tutor email could not be sent.',
              doubtId: result.insertId,
              emailSent
            });
          });
        }
      );
    }
  );
});

// POST /api/discussions/:courseId/doubts/:doubtId/replies
router.post('/:courseId/doubts/:doubtId/replies', requireCourseViewer, (req, res) => {
  const doubtId = Number(req.params.doubtId);
  const reply = String(req.body.reply || '').trim();

  if (!Number.isInteger(doubtId) || doubtId < 1) {
    return res.status(400).json({ message: 'Invalid question ID.' });
  }
  if (!reply || reply.length > 2000) {
    return res.status(400).json({ message: 'Reply must be between 1 and 2000 characters.' });
  }

  db.query(
    `SELECT d.id, d.question,
            c.title AS course_title,
            ch.title AS chapter_title,
            tutor.email AS tutor_email,
            asker.name AS asker_name, asker.email AS asker_email,
            replier.name AS replier_name, replier.email AS replier_email
     FROM doubts d
     INNER JOIN courses c ON c.id = d.course_id
     INNER JOIN chapters ch ON ch.id = d.chapter_id
     INNER JOIN users tutor ON tutor.id = c.tutor_id
     INNER JOIN users asker ON asker.id = d.user_id
     INNER JOIN users replier ON replier.id = ?
     WHERE d.id = ? AND d.course_id = ?
     LIMIT 1`,
    [req.user.userId, doubtId, req.courseId],
    (doubtErr, doubts) => {
      if (doubtErr) return res.status(500).json({ message: 'Database error.' });
      if (!doubts.length) return res.status(404).json({ message: 'Question not found.' });
      const doubt = doubts[0];

      db.query(
        'INSERT INTO doubt_replies (doubt_id, user_id, reply) VALUES (?, ?, ?)',
        [doubtId, req.user.userId, reply],
        (err, result) => {
          if (err) return res.status(500).json({ message: 'Could not post reply.' });
          logDiscussionTransaction({
            studentId: req.user.userId,
            courseId: req.courseId,
            discussionId: doubtId,
            action: 'REPLY_POSTED'
          });
          sendDiscussionMail({
            to: [doubt.tutor_email, doubt.asker_email],
            subject: `New reply: ${doubt.course_title}`,
            heading: 'New Discussion Reply',
            rows: [
              { label: 'Course', value: doubt.course_title },
              { label: 'Lecture', value: doubt.chapter_title },
              { label: 'Original student', value: `${doubt.asker_name} (${doubt.asker_email || 'no email'})` },
              { label: 'Replied by', value: `${doubt.replier_name} (${doubt.replier_email || 'no email'})` }
            ],
            body: `Original doubt:\n${doubt.question}\n\nReply:\n${reply}`
          }, (mailErr, emailSent) => {
            if (mailErr) console.error('Discussion reply email error:', mailErr.message);
            res.status(201).json({
              message: emailSent ? 'Reply posted and notifications emailed.' : 'Reply posted. Notification email could not be sent.',
              replyId: result.insertId,
              emailSent
            });
          });
        }
      );
    }
  );
});

module.exports = router;
