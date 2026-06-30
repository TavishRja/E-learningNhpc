// routes/otp.js — Send and Verify OTP
const express    = require('express');
const nodemailer = require('nodemailer');
const db         = require('../config/db');
require('dotenv').config();

const router = express.Router();

// Gmail transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// ----------------------------------------
// POST /api/otp/send
// Body: { email }
// ----------------------------------------
router.post('/send', (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ message: 'Email is required.' });
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    return res.status(500).json({ message: 'OTP email is not configured. Add GMAIL_USER and GMAIL_PASS in backend/.env.' });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // Expiry: 10 minutes from now
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // Delete any old OTP for this email first
  db.query('DELETE FROM otps WHERE email = ?', [email], (err) => {
    if (err) return res.status(500).json({ message: 'Database error.' });

    // Save new OTP to DB
    db.query(
      'INSERT INTO otps (email, otp, expires_at) VALUES (?, ?, ?)',
      [email, otp, expiresAt],
      (err) => {
        if (err) return res.status(500).json({ message: 'Could not save OTP.' });

        // Send email
        const mailOptions = {
          from: `"E-Learning" <${process.env.GMAIL_USER}>`,
          to: email,
          subject: 'Your E-Learning OTP Code',
          html: `
            <div style="font-family:sans-serif; max-width:400px; margin:auto; padding:32px; border:1px solid #eee; border-radius:12px;">
              <h2 style="color:#1a3a5c;">E-Learning Verification</h2>
              <p style="color:#555;">Use the OTP below to verify your email. It expires in <strong>10 minutes</strong>.</p>
              <div style="font-size:2.5rem; font-weight:bold; letter-spacing:12px; color:#e8631a; margin:24px 0;">${otp}</div>
              <p style="color:#999; font-size:0.85rem;">If you didn't request this, ignore this email.</p>
            </div>
          `
        };

        transporter.sendMail(mailOptions, (err) => {
          if (err) {
            console.error('Email error:', err);
            return res.status(500).json({ message: 'Failed to send email. Check Gmail credentials.' });
          }
          res.json({ message: 'OTP sent successfully!' });
        });
      }
    );
  });
});

// ----------------------------------------
// POST /api/otp/verify
// Body: { email, otp }
// ----------------------------------------
router.post('/verify', (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required.' });

  db.query(
    'SELECT * FROM otps WHERE email = ? AND otp = ? AND verified = FALSE',
    [email, otp],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });

      if (results.length === 0) {
        return res.status(400).json({ message: 'Invalid OTP.' });
      }

      const record = results[0];

      // Check expiry
      if (new Date() > new Date(record.expires_at)) {
        return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
      }

      // Mark as verified
      db.query('UPDATE otps SET verified = TRUE WHERE id = ?', [record.id], (err) => {
        if (err) return res.status(500).json({ message: 'Database error.' });
        res.json({ message: 'OTP verified successfully!' });
      });
    }
  );
});

module.exports = router;
