const db = require('../config/db');

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

let initialization;

async function initializeCourseStructure() {
  if (initialization) return initialization;

  initialization = (async () => {
    await query(`
      DELETE FROM courses
      WHERE tutor_id IS NULL
        AND title IN (
          'Web Development Fundamentals',
          'Data Science with Python',
          'UI/UX Design Principles',
          'Cloud Computing Essentials'
        )
    `);

    const imageColumns = await query("SHOW COLUMNS FROM courses LIKE 'image_path'");
    if (!imageColumns.length) {
      await query('ALTER TABLE courses ADD COLUMN image_path VARCHAR(500) NULL AFTER emoji');
    }

    const statusColumns = await query("SHOW COLUMNS FROM courses LIKE 'status'");
    const desiredStatusEnum = "ENUM('draft','submitted','under_review','approved','published','unpublished','rejected','changes_requested','delete_requested')";
    if (statusColumns[0] && String(statusColumns[0].Type || '') !== desiredStatusEnum.toLowerCase()) {
      await query("ALTER TABLE courses MODIFY status ENUM('draft','pending','submitted','under_review','approved','published','unpublished','denied','rejected','changes_requested','delete_requested') DEFAULT 'draft'");
      await query("UPDATE courses SET status='submitted' WHERE status='pending'");
      await query("UPDATE courses SET status='rejected' WHERE status='denied'");
      await query("UPDATE courses SET status='published' WHERE status='approved'");
      await query(`ALTER TABLE courses MODIFY status ${desiredStatusEnum} DEFAULT 'draft'`);
    }

    const reviewSubmittedColumns = await query("SHOW COLUMNS FROM courses LIKE 'review_submitted_at'");
    if (!reviewSubmittedColumns.length) {
      await query('ALTER TABLE courses ADD COLUMN review_submitted_at TIMESTAMP NULL DEFAULT NULL AFTER status');
    }

    const approvedColumns = await query("SHOW COLUMNS FROM courses LIKE 'approved_at'");
    if (!approvedColumns.length) {
      await query('ALTER TABLE courses ADD COLUMN approved_at TIMESTAMP NULL DEFAULT NULL AFTER review_submitted_at');
    }

    const deniedColumns = await query("SHOW COLUMNS FROM courses LIKE 'denied_at'");
    if (!deniedColumns.length) {
      await query('ALTER TABLE courses ADD COLUMN denied_at TIMESTAMP NULL DEFAULT NULL AFTER approved_at');
    }

    await query(`
      CREATE TABLE IF NOT EXISTS sections (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        section_order INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sections_course_order (course_id, section_order),
        CONSTRAINT fk_sections_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
      )
    `);

    const columns = await query("SHOW COLUMNS FROM chapters LIKE 'section_id'");
    if (!columns.length) {
      await query('ALTER TABLE chapters ADD COLUMN section_id INT NULL AFTER course_id');
    }

    const contentTypeColumns = await query("SHOW COLUMNS FROM chapters LIKE 'main_content_type'");
    if (!contentTypeColumns.length) {
      await query("ALTER TABLE chapters ADD COLUMN main_content_type VARCHAR(20) NULL AFTER title");
    }

    const summaryColumns = await query("SHOW COLUMNS FROM chapters LIKE 'summary'");
    if (!summaryColumns.length) {
      await query("ALTER TABLE chapters ADD COLUMN summary LONGTEXT NULL AFTER main_content_type");
    }

    await query(`
      CREATE TABLE IF NOT EXISTS chapter_resources (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chapter_id INT NOT NULL,
        resource_type VARCHAR(20) NOT NULL,
        title VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NULL,
        external_url VARCHAR(2000) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_resources_chapter (chapter_id, id),
        CONSTRAINT fk_resources_chapter
          FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )
    `);

    await query(`
      INSERT INTO chapter_resources (chapter_id, resource_type, title, file_path)
      SELECT ch.id, 'pdf', 'Additional PDF', ch.pdf_path
      FROM chapters ch
      WHERE ch.video_url IS NOT NULL
        AND ch.pdf_path IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM chapter_resources cr
          WHERE cr.chapter_id = ch.id
            AND cr.resource_type = 'pdf'
            AND cr.file_path = ch.pdf_path
        )
    `);

    await query(`
      UPDATE chapters
      SET main_content_type = CASE
        WHEN video_url IS NOT NULL AND video_url NOT REGEXP '^https?://' THEN 'video'
        WHEN pdf_path IS NOT NULL THEN 'pdf'
        ELSE NULL
      END
      WHERE main_content_type IS NULL
         OR main_content_type NOT IN ('video', 'pdf')
    `);

    await query(`
      UPDATE chapters
      SET pdf_path = NULL
      WHERE main_content_type = 'video'
        AND pdf_path IS NOT NULL
    `);

    await query(`
      UPDATE chapters
      SET video_url = NULL
      WHERE main_content_type = 'pdf'
        AND video_url IS NOT NULL
    `);

    await query(`
      UPDATE chapters
      SET video_url = NULL,
          main_content_type = CASE WHEN pdf_path IS NOT NULL THEN 'pdf' ELSE NULL END
      WHERE video_url REGEXP '^https?://'
    `);

    await query(`
      INSERT INTO sections (course_id, title, section_order)
      SELECT DISTINCT ch.course_id, 'Course Content', 1
      FROM chapters ch
      LEFT JOIN sections s ON s.course_id = ch.course_id
      WHERE ch.section_id IS NULL AND s.id IS NULL
    `);

    await query(`
      UPDATE chapters ch
      INNER JOIN (
        SELECT course_id, MIN(id) AS section_id
        FROM sections
        GROUP BY course_id
      ) defaults ON defaults.course_id = ch.course_id
      SET ch.section_id = defaults.section_id
      WHERE ch.section_id IS NULL
    `);

    const sectionColumn = await query("SHOW COLUMNS FROM chapters LIKE 'section_id'");
    if (sectionColumn[0]?.Null === 'YES') {
      await query('ALTER TABLE chapters MODIFY section_id INT NOT NULL');
    }

    const constraints = await query(`
      SELECT CONSTRAINT_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'chapters'
        AND COLUMN_NAME = 'section_id'
        AND REFERENCED_TABLE_NAME = 'sections'
    `);
    if (!constraints.length) {
      await query(`
        ALTER TABLE chapters
        ADD INDEX idx_chapters_section_order (section_id, chapter_order),
        ADD CONSTRAINT fk_chapters_section
          FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
      `);
    }

    await query(`
      CREATE TABLE IF NOT EXISTS lecture_progress (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        course_id INT NOT NULL,
        chapter_id INT NOT NULL,
        is_completed TINYINT(1) NOT NULL DEFAULT 0,
        completed_at TIMESTAMP NULL DEFAULT NULL,
        last_accessed_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_lecture_progress_user_chapter (user_id, chapter_id),
        INDEX idx_lecture_progress_course_user (course_id, user_id),
        CONSTRAINT fk_lecture_progress_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_lecture_progress_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        CONSTRAINT fk_lecture_progress_chapter
          FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS course_progress (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        course_id INT NOT NULL,
        progress_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
        last_chapter_id INT NULL,
        completed_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_course_progress_user_course (user_id, course_id),
        INDEX idx_course_progress_course_user (course_id, user_id),
        CONSTRAINT fk_course_progress_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_course_progress_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        CONSTRAINT fk_course_progress_chapter
          FOREIGN KEY (last_chapter_id) REFERENCES chapters(id) ON DELETE SET NULL
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS certificates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        course_id INT NOT NULL,
        certificate_url VARCHAR(500) NOT NULL,
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_certificates_user_course (user_id, course_id),
        CONSTRAINT fk_certificates_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_certificates_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS course_transaction_log (
        transaction_id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        user_id INT NOT NULL,
        user_role VARCHAR(20) NOT NULL,
        action VARCHAR(60) NOT NULL,
        old_status VARCHAR(60) NULL,
        new_status VARCHAR(60) NULL,
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_course_log_created (created_at),
        INDEX idx_course_log_course (course_id),
        INDEX idx_course_log_user (user_id),
        CONSTRAINT fk_course_log_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        CONSTRAINT fk_course_log_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS student_transaction_log (
        transaction_id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        course_id INT NOT NULL,
        chapter_id INT NULL,
        action VARCHAR(60) NOT NULL,
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_student_log_created (created_at),
        INDEX idx_student_log_student (student_id),
        INDEX idx_student_log_course (course_id),
        CONSTRAINT fk_student_log_student
          FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_student_log_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        CONSTRAINT fk_student_log_chapter
          FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS discussion_transaction_log (
        transaction_id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        course_id INT NOT NULL,
        discussion_id INT NOT NULL,
        action VARCHAR(60) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_discussion_log_created (created_at),
        INDEX idx_discussion_log_course (course_id),
        INDEX idx_discussion_log_discussion (discussion_id),
        CONSTRAINT fk_discussion_log_student
          FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_discussion_log_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS certificate_transaction_log (
        transaction_id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        course_id INT NOT NULL,
        certificate_id INT NULL,
        action VARCHAR(60) NOT NULL DEFAULT 'CERTIFICATE_GENERATED',
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_certificate_log_generated (generated_at),
        INDEX idx_certificate_log_student (student_id),
        INDEX idx_certificate_log_course (course_id),
        CONSTRAINT fk_certificate_log_student
          FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_certificate_log_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        CONSTRAINT fk_certificate_log_certificate
          FOREIGN KEY (certificate_id) REFERENCES certificates(id) ON DELETE SET NULL
      )
    `);
  })().catch((err) => {
    initialization = null;
    throw err;
  });

  return initialization;
}

module.exports = { initializeCourseStructure, query };
