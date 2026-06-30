const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role ENUM('student', 'tutor', 'admin') NOT NULL DEFAULT 'student',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS otps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp VARCHAR(10) NOT NULL,
        verified TINYINT(1) NOT NULL DEFAULT 0,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_otps_email (email)
      );

      CREATE TABLE IF NOT EXISTS courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description LONGTEXT NULL,
        emoji VARCHAR(50) NULL DEFAULT 'Course',
        image_path VARCHAR(500) NULL,
        tutor_id INT NOT NULL,
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
        INDEX idx_courses_tutor (tutor_id),
        INDEX idx_courses_status (status),
        CONSTRAINT fk_courses_tutor
          FOREIGN KEY (tutor_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chapters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        section_id INT NULL,
        title VARCHAR(255) NOT NULL,
        main_content_type VARCHAR(20) NULL,
        summary LONGTEXT NULL,
        video_url VARCHAR(500) NULL,
        pdf_path VARCHAR(500) NULL,
        chapter_order INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chapters_course (course_id),
        CONSTRAINT fk_chapters_course
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
      );

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
      );
    `);

    console.log('Base E-Learning tables created successfully.');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@gmail.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
    const adminName = process.env.ADMIN_NAME || 'Admin User';
    const adminRole = 'admin';

    const [existingAdmin] = await connection.query(
      'SELECT id FROM users WHERE email = ? AND role = ?',
      [adminEmail, adminRole]
    );

    if (existingAdmin.length === 0) {
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await connection.query(
        'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
        [adminName, adminEmail, hashedPassword, adminRole]
      );
      console.log(`Admin user created: ${adminEmail}`);
      console.log(`Use password: ${adminPassword}`);
    } else {
      console.log(`Admin user already exists: ${adminEmail}`);
    }

    console.log('Next step: run `npm start` in the backend folder.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('Failed to initialize database:', error.message);
  process.exit(1);
});
