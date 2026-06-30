CREATE DATABASE IF NOT EXISTS learnhub
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE learnhub;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'tutor', 'student') NOT NULL DEFAULT 'student',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  INDEX idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS otps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  otp VARCHAR(10) NOT NULL,
  expires_at DATETIME NOT NULL,
  verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_otps_email (email),
  INDEX idx_otps_email_verified (email, verified)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS courses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description LONGTEXT NULL,
  emoji VARCHAR(80) NULL DEFAULT 'Course',
  image_path VARCHAR(500) NULL,
  tutor_id INT NULL,
  status ENUM(
    'draft',
    'submitted',
    'under_review',
    'approved',
    'published',
    'unpublished',
    'rejected',
    'changes_requested',
    'delete_requested'
  ) NOT NULL DEFAULT 'draft',
  review_submitted_at TIMESTAMP NULL DEFAULT NULL,
  approved_at TIMESTAMP NULL DEFAULT NULL,
  denied_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_courses_tutor (tutor_id),
  INDEX idx_courses_status (status),
  INDEX idx_courses_created (created_at),
  CONSTRAINT fk_courses_tutor
    FOREIGN KEY (tutor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  course_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  section_order INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sections_course_order (course_id, section_order),
  CONSTRAINT fk_sections_course
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chapters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  course_id INT NOT NULL,
  section_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  main_content_type VARCHAR(20) NULL,
  summary LONGTEXT NULL,
  video_url VARCHAR(500) NULL,
  pdf_path VARCHAR(500) NULL,
  chapter_order INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chapters_course_order (course_id, chapter_order),
  INDEX idx_chapters_section_order (section_id, chapter_order),
  CONSTRAINT fk_chapters_course
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  CONSTRAINT fk_chapters_section
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS enrollments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  course_id INT NOT NULL,
  enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_enrollments_user_course (user_id, course_id),
  INDEX idx_enrollments_course (course_id),
  CONSTRAINT fk_enrollments_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_enrollments_course
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS doubts (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS doubt_replies (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SHOW TABLES;

DESCRIBE users;
DESCRIBE otps;
DESCRIBE courses;
DESCRIBE sections;
DESCRIBE chapters;
DESCRIBE enrollments;
DESCRIBE student_transaction_log;
DESCRIBE course_transaction_log;