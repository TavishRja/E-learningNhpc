const db = require('../config/db');

function safeInsert(sql, params) {
  db.query(sql, params, (err) => {
    if (err) console.error('Audit log error:', err.message);
  });
}

function logCourseTransaction({ courseId, userId, userRole, action, oldStatus = null, newStatus = null, remarks = null }) {
  safeInsert(
    `INSERT INTO course_transaction_log
      (course_id, user_id, user_role, action, old_status, new_status, remarks)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [courseId, userId, userRole, action, oldStatus, newStatus, remarks]
  );
}

function logStudentTransaction({ studentId, courseId, chapterId = null, action, remarks = null }) {
  safeInsert(
    `INSERT INTO student_transaction_log
      (student_id, course_id, chapter_id, action, remarks)
     VALUES (?, ?, ?, ?, ?)`,
    [studentId, courseId, chapterId, action, remarks]
  );
}

function logDiscussionTransaction({ studentId, courseId, discussionId, action }) {
  safeInsert(
    `INSERT INTO discussion_transaction_log
      (student_id, course_id, discussion_id, action)
     VALUES (?, ?, ?, ?)`,
    [studentId, courseId, discussionId, action]
  );
}

function logCertificateTransaction({ studentId, courseId, certificateId = null }) {
  safeInsert(
    `INSERT INTO certificate_transaction_log
      (student_id, course_id, certificate_id, action)
     VALUES (?, ?, ?, 'CERTIFICATE_GENERATED')`,
    [studentId, courseId, certificateId]
  );
}

module.exports = {
  logCourseTransaction,
  logStudentTransaction,
  logDiscussionTransaction,
  logCertificateTransaction
};
